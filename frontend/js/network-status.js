/**
 * GHOSTCHAT NETWORK STATUS  v1
 * A small, calm notice at the bottom-left that only appears when something is wrong:
 *   - your device is offline
 *   - GhostChat's servers cannot be reached (it keeps retrying by itself)
 *   - the connection is very slow
 * and a short "Back online" message when it recovers. Nothing shows while all is well.
 * It checks /health (no login needed, never rate-limited). Pauses while the tab is hidden.
 */
window.GhostNet = (() => {
    const OK_EVERY = 45000, BAD_EVERY = 6000, TIMEOUT = 7000, SLOW_MS = 2500;
    let state = navigator.onLine === false ? 'offline' : 'online', latency = null, fails = 0, timer = null, el = null, hideT = null, wasBad = false;
    const listeners = new Set();

    function ui() {
        if (el) return el;
        const st = document.createElement('style');
        st.textContent = `#gcNet{position:fixed;left:max(12px,env(safe-area-inset-left));bottom:max(12px,env(safe-area-inset-bottom));z-index:9000;display:none;align-items:center;gap:8px;
          max-width:calc(100vw - 24px);padding:9px 14px;border-radius:999px;font:500 13px/1.3 var(--font,system-ui,sans-serif);color:#fff;background:#b45309;box-shadow:0 6px 20px rgba(0,0,0,.35)}
          #gcNet.show{display:flex}#gcNet.bad{background:#b91c1c}#gcNet.good{background:#15803d}#gcNet i{font-size:13px}
          #gcNet .gcn-spin{animation:gcns 1s linear infinite}@keyframes gcns{to{transform:rotate(360deg)}}
          @media (prefers-reduced-motion:reduce){#gcNet .gcn-spin{animation:none}}`;
        document.head.appendChild(st);
        el = document.createElement('div'); el.id = 'gcNet'; el.setAttribute('role', 'status'); el.setAttribute('aria-live', 'polite');
        document.body.appendChild(el); return el;
    }
    function show(kind, icon, text) {
        const e = ui(); clearTimeout(hideT);
        e.className = 'show ' + kind;
        e.innerHTML = `<i class="fas ${icon}${icon === 'fa-rotate' ? ' gcn-spin' : ''}" aria-hidden="true"></i><span></span>`;
        e.lastChild.textContent = text;
    }
    function hide() { if (el) el.className = ''; }

    function set(next) {
        if (next === state) return;
        const prev = state; state = next;
        // chat.html already has its own "you're offline" bar; don't show two
        const hasBar = !!document.getElementById('offlineBanner');
        if (next === 'offline') { wasBad = true; if (!hasBar) show('', 'fa-wifi', "You're offline. Changes will sync when you reconnect."); }
        else if (next === 'down') { wasBad = true; show('bad', 'fa-rotate', "Can't reach GhostChat right now. Retrying…"); }
        else if (next === 'slow') { show('', 'fa-gauge-high', 'Your connection is slow.'); }
        else if (next === 'online') {
            if (wasBad && prev !== 'slow') { show('good', 'fa-circle-check', 'Back online'); hideT = setTimeout(hide, 3000); } else hide();
            wasBad = false;
        }
        listeners.forEach(f => { try { f(state, latency); } catch (_) {} });
    }

    async function check() {
        clearTimeout(timer);
        if (navigator.onLine === false) { set('offline'); return schedule(BAD_EVERY); }
        const ctl = new AbortController(), kill = setTimeout(() => ctl.abort(), TIMEOUT), t0 = performance.now();
        try {
            const r = await fetch('/health?_=' + Date.now(), { cache: 'no-store', signal: ctl.signal, credentials: 'omit' });
            latency = Math.round(performance.now() - t0);
            if (!r.ok) throw new Error('bad status');
            fails = 0; set(latency > SLOW_MS ? 'slow' : 'online');
        } catch (_) {
            if (navigator.onLine === false) set('offline');
            else if (++fails >= 2) set('down');          // one blip is not an outage
        } finally { clearTimeout(kill); }
        schedule(fails || state !== 'online' ? BAD_EVERY : OK_EVERY);
    }
    function schedule(ms) { clearTimeout(timer); if (!document.hidden) timer = setTimeout(check, ms); }

    window.addEventListener('offline', () => set('offline'));
    window.addEventListener('online', () => { fails = 0; check(); });
    document.addEventListener('visibilitychange', () => { if (!document.hidden) check(); else clearTimeout(timer); });
    const start = () => { if (navigator.onLine === false) { state = 'online'; set('offline'); } schedule(2500); };
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start); else start();

    return { get state() { return state; }, get latency() { return latency; }, check, onChange: f => { listeners.add(f); return () => listeners.delete(f); } };
})();
