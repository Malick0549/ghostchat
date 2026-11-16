/**
 * Unread-message sign. Shows a count on the Chat button (and on the menu button on phones)
 * as soon as someone writes to you, and puts the count in the browser tab title.
 * It asks the server every 10 seconds and again whenever you come back to the tab.
 * Only counts are read. No message content is ever fetched here.
 */
(function () {
  'use strict';
  const EVERY = 10000;
  let last = null, lastAlert = 0;

  function badge(host, n, cls) {
    if (!host) return;
    let b = host.querySelector(':scope > .gc-unread.' + cls);
    if (!n) { if (b) b.remove(); return; }
    if (!b) { b = document.createElement('span'); b.className = 'gc-unread ' + cls; b.setAttribute('role', 'status'); host.appendChild(b); }
    b.textContent = n > 99 ? '99+' : String(n);
    b.setAttribute('aria-label', n + ' unread message' + (n === 1 ? '' : 's'));
  }

  function show(n) {
    badge(document.querySelector('.nav-item[data-page="chat"]'), n, 'on-nav');
    const ham = document.getElementById('hamburger');
    if (ham) ham.classList.toggle('has-unread', n > 0);   // a red dot, since the menu icon has no room for a number
    const back = document.querySelector('a.back, a[href="dashboard.html"]');
    if (back && document.body.dataset.page !== 'dashboard') badge(back, n, 'on-link');
    document.title = (n ? '(' + n + ') ' : '') + document.title.replace(/^\(\d+\)\s*/, '');
    // Fallback if the live connection is down: the 10-second check raises the alert instead.
    if (last !== null && n > last && Date.now() - lastAlert > 6000) { lastAlert = Date.now(); popup('New message', 'Open Chat to read it.'); if (window.UI && UI.playSound) UI.playSound('info'); }
    last = n;
  }

  async function poll() {
    try {
      const r = await fetch('/api/contacts', { credentials: 'include', headers: { 'Accept': 'application/json', 'X-Requested-With': 'XMLHttpRequest' } });
      if (!r.ok) return;
      const d = await r.json();
      const list = d.contacts || d.data || [];
      list.forEach(c => { names[c.contact_id] = c.username || c.name || names[c.contact_id]; });
      show(list.reduce((s, c) => s + (c.unread_count || 0), 0) + groupPending);
    } catch (_) { /* offline: keep the last count */ }
  }

  // ── Instant alert ─────────────────────────────────────────────────────────
  // A live connection tells the dashboard the moment a message arrives: a pop-up with the sender's name,
  // the chime, the Chat badge, and (if allowed and the tab is hidden) a system notification.
  // The alert never contains the message itself, because messages are encrypted.
  const names = {}; let groupPending = 0, me = null, tray = null;
  const esc = t => String(t).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  function popup(title, text) {
    if (!tray) { tray = document.createElement('div'); tray.className = 'gc-alerts'; tray.setAttribute('aria-live', 'polite'); document.body.appendChild(tray); }
    const a = document.createElement('a'); a.className = 'gc-alert'; a.href = 'chat.html';
    a.innerHTML = '<span class="gc-alert-ico"><i class="fas fa-comment-dots"></i></span><span class="gc-alert-txt"><b>' + esc(title) + '</b><small>' + esc(text) + '</small></span><span class="gc-alert-go">Open</span>';
    tray.appendChild(a);
    while (tray.children.length > 3) tray.firstChild.remove();
    setTimeout(() => { a.classList.add('out'); setTimeout(() => a.remove(), 300); }, 9000);
  }

  function incoming(d, isGroup) {
    if (!d || d.sender_id === me) return;
    lastAlert = Date.now();
    const who = d.sender || names[d.sender_id] || 'Someone';
    if (isGroup) groupPending++;
    popup(isGroup ? 'New group message' : 'New message from ' + who, isGroup ? who + ' wrote in a group. Open Chat to read it.' : 'Open Chat to read it.');
    if (window.UI && UI.playSound) UI.playSound('info');
    if (document.hidden && 'Notification' in window && Notification.permission === 'granted') {
      try { const n = new Notification(isGroup ? 'New group message' : who, { body: 'New encrypted message', tag: 'gc-msg', icon: 'assets/icons/icon-192.png' }); n.onclick = () => { window.focus(); location.href = 'chat.html'; }; } catch (_) {}
    }
    poll();
  }

  async function live() {
    try {
      const r = await fetch('/api/auth/me', { credentials: 'include', headers: { 'Accept': 'application/json' } });
      if (!r.ok) return; const d = await r.json(); me = (d.user && d.user.id) || d.id; if (!me) return;
      if (!window.io) await new Promise((res, rej) => { const sc = document.createElement('script'); sc.src = 'https://cdn.socket.io/4.7.2/socket.io.min.js'; sc.onload = res; sc.onerror = rej; document.head.appendChild(sc); });
      const sock = io({ path: '/socket.io', transports: ['websocket', 'polling'], withCredentials: true, reconnectionDelayMax: 15000 });
      sock.on('connect', () => sock.emit('join_user_room', { user_id: me }));
      sock.on('receive_message', d => incoming(d, false));
      sock.on('group_message', d => incoming(d, true));
    } catch (_) { /* polling still keeps the badge correct */ }
  }
  // Ask once, politely, so alerts can also appear when this tab is in the background.
  document.addEventListener('click', () => { if ('Notification' in window && Notification.permission === 'default' && !sessionStorage.getItem('gc_notif_asked')) { sessionStorage.setItem('gc_notif_asked', '1'); try { Notification.requestPermission(); } catch (_) {} } }, { once: true });

  document.addEventListener('visibilitychange', () => { if (!document.hidden) poll(); });
  window.addEventListener('focus', poll);
  window.addEventListener('ghostchat:unread-check', poll);
  poll(); setInterval(poll, EVERY);
  if (!location.pathname.endsWith('chat.html')) live();
})();
