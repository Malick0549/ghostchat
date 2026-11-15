/**
 * Unread-message sign. Shows a count on the Chat button (and on the menu button on phones)
 * as soon as someone writes to you, and puts the count in the browser tab title.
 * It asks the server every 10 seconds and again whenever you come back to the tab.
 * Only counts are read. No message content is ever fetched here.
 */
(function () {
  'use strict';
  const EVERY = 10000;
  let last = null;

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
    if (last !== null && n > last && window.UI && UI.playSound) UI.playSound('info');
    last = n;
  }

  async function poll() {
    try {
      const r = await fetch('/api/contacts', { credentials: 'include', headers: { 'Accept': 'application/json', 'X-Requested-With': 'XMLHttpRequest' } });
      if (!r.ok) return;
      const d = await r.json();
      const list = d.contacts || d.data || [];
      show(list.reduce((s, c) => s + (c.unread_count || 0), 0));
    } catch (_) { /* offline: keep the last count */ }
  }

  document.addEventListener('visibilitychange', () => { if (!document.hidden) poll(); });
  window.addEventListener('focus', poll);
  window.addEventListener('ghostchat:unread-check', poll);
  poll(); setInterval(poll, EVERY);
})();
