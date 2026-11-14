/* Live checks for status.html. Everything runs from the visitor's browser. */
(function () {
  var rows = document.getElementById('stRows'), hero = document.getElementById('stHero');
  function row(name, sub, kind, label) {
    return '<div class="st-row"><div class="nm"><b></b><small></small></div><span class="st-pill ' + kind + '"></span></div>';
  }
  function timed(url, ms) {
    var c = new AbortController(), k = setTimeout(function () { c.abort(); }, ms || 8000), t0 = performance.now();
    return fetch(url, { cache: 'no-store', signal: c.signal, credentials: 'omit' }).then(function (r) {
      return r.text().then(function (txt) { clearTimeout(k); return { ok: r.ok, ms: Math.round(performance.now() - t0), text: txt }; });
    }).catch(function () { clearTimeout(k); return { ok: false, ms: null, text: '' }; });
  }
  async function cryptoTest() {
    try {
      var s = crypto.subtle, key = await s.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
      var iv = crypto.getRandomValues(new Uint8Array(12)), data = new TextEncoder().encode('ghostchat self-test');
      var ct = await s.encrypt({ name: 'AES-GCM', iv: iv }, key, data), pt = await s.decrypt({ name: 'AES-GCM', iv: iv }, key, ct);
      return new TextDecoder().decode(pt) === 'ghostchat self-test';
    } catch (e) { return false; }
  }
  async function run() {
    document.getElementById('stRefresh').disabled = true;
    var items = [];
    var h = await timed('/health?_=' + Date.now());
    var j = {}; try { j = JSON.parse(h.text); } catch (e) {}
    var apiOk = h.ok && j.service;
    items.push({ n: 'Website and API', s: apiOk ? 'Response time ' + h.ms + ' ms' : 'Could not reach the servers',
      k: !apiOk ? 'bad' : (h.ms > 2500 ? 'warn' : 'ok'), l: !apiOk ? 'Unreachable' : (h.ms > 2500 ? 'Slow' : 'Operational') });
    var db = j.database;
    items.push({ n: 'Database', s: 'Accounts and messages storage',
      k: !apiOk ? 'na' : (db === 'connected' ? 'ok' : (db === 'unreachable' ? 'bad' : 'warn')),
      l: !apiOk ? 'Unknown' : (db === 'connected' ? 'Operational' : (db === 'unreachable' ? 'Unreachable' : 'Not enabled')) });
    var rt = await timed('/socket.io/?EIO=4&transport=polling&t=' + Date.now());
    var rtOk = rt.ok && /^0\{/.test(rt.text);
    items.push({ n: 'Real-time chat', s: rtOk ? 'Live delivery connection, ' + rt.ms + ' ms' : 'Live delivery connection',
      k: !apiOk ? 'na' : (rtOk ? 'ok' : 'warn'), l: !apiOk ? 'Unknown' : (rtOk ? 'Operational' : 'Degraded') });
    var ce = await cryptoTest();
    items.push({ n: 'Encryption in your browser', s: 'AES-256-GCM self-test on this device', k: ce ? 'ok' : 'bad', l: ce ? 'Working' : 'Not available' });
    var sp = !!(window.SpeechRecognition || window.webkitSpeechRecognition);
    items.push({ n: 'Voice typing', s: 'Depends on your browser', k: sp ? 'ok' : 'na', l: sp ? 'Supported' : 'Not in this browser' });

    rows.innerHTML = '';
    items.forEach(function (it) {
      rows.insertAdjacentHTML('beforeend', row());
      var r = rows.lastElementChild;
      r.querySelector('b').textContent = it.n; r.querySelector('small').textContent = it.s;
      var p = r.querySelector('.st-pill'); p.className = 'st-pill ' + it.k; p.textContent = it.l;
    });
    var bad = items.some(function (i) { return i.k === 'bad'; }), warn = items.some(function (i) { return i.k === 'warn'; });
    hero.className = 'st-hero ' + (bad ? 'bad' : warn ? 'warn' : 'ok');
    document.getElementById('stIcon').className = 'fas ' + (bad ? 'fa-circle-xmark' : warn ? 'fa-triangle-exclamation' : 'fa-circle-check');
    document.getElementById('stTitle').textContent = bad ? 'Some systems are down' : warn ? 'Some systems are slow or degraded' : 'All systems operational';
    document.getElementById('stSub').textContent = bad ? 'We are aware of problems or you may be offline. Try again shortly.' : warn ? 'GhostChat should still work, possibly slower.' : 'GhostChat is working normally.';
    document.getElementById('stTime').textContent = 'Last checked ' + new Date().toLocaleTimeString();
    document.getElementById('stRefresh').disabled = false;
  }
  document.getElementById('stRefresh').addEventListener('click', run);
  setInterval(function () { if (!document.hidden) run(); }, 30000);
  run();
})();
