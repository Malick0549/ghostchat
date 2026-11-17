/**
 * Location sharing.  When the server says it is required (everyone except admins), the app is covered by a
 * full-screen notice until the browser's location permission is granted; otherwise it is an optional card.  Nothing is asked silently: a small card is shown once on the
 * dashboard, the browser then shows its own Allow / Block prompt, and the choice can be changed in Settings.
 * Only a town-level place (rounded to ~1 km) is kept, and only admins can see it.
 */
(function () {
  'use strict';
  const api = () => window.GhostChatAPI;
  const KEY = 'gc_loc_sync';
  const store = { get: k => { try { return localStorage.getItem(k); } catch (e) { return null; } },
                  set: (k, v) => { try { localStorage.setItem(k, v); } catch (e) {} } };
  const toast = (m, t) => window.UI && UI.showToast ? UI.showToast(m, t || 'info') : null;
  let state = null;

  function position() {
    return new Promise((res, rej) => {
      if (!navigator.geolocation) return rej(new Error('Location is not supported on this device.'));
      navigator.geolocation.getCurrentPosition(p => res(p.coords), e => rej(e),
        { enableHighAccuracy: false, timeout: 15000, maximumAge: 600000 });
    });
  }
  async function share() {
    try {
      const c = await position();
      const r = await api()._post('/api/me/location', { lat: c.latitude, lon: c.longitude });
      state = { consent: true, place: r.place }; store.set(KEY, String(Date.now()));
      return r.place;
    } catch (e) {
      throw new Error(e && e.code === 1 ? 'Location is blocked for this site. Allow it in your browser settings and try again.'
        : (e && e.message) || 'Could not get your location.');
    }
  }
  async function stop() { await api()._del('/api/me/location'); state = { consent: false }; store.set(KEY, ''); }

  function card() {
    if (document.getElementById('gcLocCard')) return;
    const d = document.createElement('div'); d.id = 'gcLocCard'; d.setAttribute('role', 'dialog');
    d.style.cssText = 'position:fixed;left:50%;bottom:16px;transform:translateX(-50%);width:min(440px,calc(100% - 24px));z-index:9000;' +
      'background:var(--bg2,#151823);color:var(--t1,#fff);border:1px solid var(--border2,#333);border-radius:16px;padding:16px;box-shadow:0 12px 40px rgba(0,0,0,.45);';
    d.innerHTML = '<div style="display:flex;gap:12px;align-items:flex-start"><i class="fas fa-location-dot" style="color:var(--primary,#b9a7ff);font-size:1.3rem;margin-top:2px"></i>' +
      '<div><b>Share your location? (optional)</b><p style="color:var(--t2,#aaa);font-size:.88rem;margin:6px 0 12px;line-height:1.45">' +
      'Helps the admin see where sign-ins really come from and spot account takeovers. Only the town is kept (about 1 km accuracy), ' +
      'never your messages, and you can turn it off any time in Settings.</p>' +
      '<div style="display:flex;gap:8px;flex-wrap:wrap"><button class="btn btn-primary btn-sm" id="gcLocYes">Share location</button>' +
      '<button class="btn btn-ghost btn-sm" id="gcLocNo">No thanks</button></div></div></div>';
    document.body.appendChild(d);
    d.querySelector('#gcLocNo').onclick = async () => { d.remove(); try { await api()._post('/api/me/location/decline', {}); } catch (e) {} };
    d.querySelector('#gcLocYes').onclick = async () => {
      const b = d.querySelector('#gcLocYes'); b.disabled = true; b.textContent = 'Waiting for permission…';
      try { const p = await share(); d.remove(); toast('Location shared: ' + p, 'success'); }
      catch (e) { d.remove(); toast(e.message, 'error'); }
    };
  }

  function wall(msg) {
    if (document.getElementById('gcLocWall')) { if (msg) document.getElementById('gcLocMsg').textContent = msg; return; }
    const d = document.createElement('div'); d.id = 'gcLocWall'; d.setAttribute('role', 'alertdialog'); d.setAttribute('aria-modal', 'true');
    d.style.cssText = 'position:fixed;inset:0;z-index:99999;display:grid;place-items:center;padding:20px;background:rgba(6,8,13,.94);backdrop-filter:blur(8px);color:var(--t1,#fff);overflow:auto;';
    d.innerHTML = '<div style="max-width:420px;width:100%;text-align:center;background:var(--bg2,#151823);border:1px solid var(--border2,#333);border-radius:20px;padding:28px 22px;">' +
      '<i class="fas fa-location-dot" style="font-size:2.2rem;color:var(--primary,#b9a7ff)"></i>' +
      '<h2 style="margin:12px 0 8px;font-size:1.3rem">Location is required</h2>' +
      '<p style="color:var(--t2,#aaa);font-size:.92rem;line-height:1.5;margin-bottom:14px">To keep GhostChat safe, every account shares its location. ' +
      'Only the town is kept (about 1 km), never your messages, and only the admin can see it. Tap the button, then choose <b>Allow</b> when your browser asks.</p>' +
      '<p id="gcLocMsg" style="color:var(--red,#ff7385);font-size:.86rem;min-height:1.2em;margin-bottom:10px"></p>' +
      '<button class="btn btn-primary" id="gcLocAllow" style="width:100%;min-height:48px;margin-bottom:10px">Allow location</button>' +
      '<button class="btn btn-ghost btn-sm" id="gcLocOut">Sign out</button>' +
      '<details style="margin-top:14px;text-align:left;color:var(--t3,#888);font-size:.82rem"><summary style="cursor:pointer">Blocked it by mistake?</summary>' +
      '<p style="margin-top:8px;line-height:1.5">Tap the lock or tune icon next to the web address, open <b>Site settings</b> (or <b>Permissions</b>), set <b>Location</b> to <b>Allow</b>, then come back and tap Allow location. On iPhone also check Settings → Privacy → Location Services → your browser.</p></details></div>';
    document.body.appendChild(d); document.body.style.overflow = 'hidden';
    if (msg) d.querySelector('#gcLocMsg').textContent = msg;
    d.querySelector('#gcLocAllow').onclick = async () => {
      const b = d.querySelector('#gcLocAllow'); b.disabled = true; b.textContent = 'Waiting for permission…';
      try { await share(); d.remove(); document.body.style.overflow = ''; toast('Location on. Welcome back.', 'success'); }
      catch (e) { d.querySelector('#gcLocMsg').textContent = e.message; b.disabled = false; b.textContent = 'Try again'; }
    };
    d.querySelector('#gcLocOut').onclick = async () => { try { await api()._post('/api/auth/logout', {}); } catch (e) {} location.href = '/'; };
  }
  // Any request the server refuses because location is off brings the notice back.
  const _fetch = window.fetch;
  window.fetch = function () {
    return _fetch.apply(this, arguments).then(r => {
      if (r.status === 403 && !/\/api\/me\/location/.test(String(arguments[0] && arguments[0].url || arguments[0]))) {
        r.clone().json().then(j => { if (j && j.code === 'location_required') wall(); }).catch(() => {});
      }
      return r;
    });
  };
  window.addEventListener('gc-location-required', () => wall());

  function settingsRow() {
    const mount = document.getElementById('e2eSettingsMount');
    if (!mount || document.getElementById('gcLocSetting')) return;
    const g = document.createElement('div'); g.className = 'settings-group'; g.id = 'gcLocSetting';
    g.innerHTML = '<h3>Location</h3><div class="setting-row"><div><div class="setting-label">Share my location with the admin</div>' +
      '<div class="setting-sub" id="gcLocSub">Optional. Town-level only. Used to spot suspicious sign-ins.</div></div>' +
      '<label class="toggle-sw"><input type="checkbox" id="gcLocToggle" /><div class="toggle-track"></div><div class="toggle-thumb"></div></label></div>';
    mount.parentNode.insertBefore(g, mount.nextSibling);
    const t = g.querySelector('#gcLocToggle'), sub = g.querySelector('#gcLocSub');
    const paint = () => { t.checked = !!(state && state.consent); if (t.checked && state.place) sub.textContent = 'Sharing: ' + state.place; };
    paint();
    t.onchange = async () => {
      t.disabled = true;
      try {
        if (t.checked) { const p = await share(); sub.textContent = 'Sharing: ' + p; toast('Location shared', 'success'); }
        else { await stop(); sub.textContent = 'Optional. Town-level only. Used to spot suspicious sign-ins.'; toast('Location sharing turned off', 'info'); }
      } catch (e) { t.checked = !t.checked; toast(e.message, 'error'); }
      t.disabled = false;
    };
  }

  async function init() {
    if (!api()) return;
    try { state = await api()._get('/api/me/location'); } catch (e) { return; }
    if (state.blocked) {                       // permission already given before? renew quietly, otherwise show the notice
      let granted = false;
      try { granted = (await navigator.permissions.query({ name: 'geolocation' })).state === 'granted'; } catch (e) {}
      if (granted) { try { await share(); } catch (e) { wall(e.message); } } else wall();
    }
    else if (state.consent) {                  // refresh quietly at most every 6 hours (permission already granted)
      if (Date.now() - Number(store.get(KEY) || 0) > 6 * 3600e3) share().catch(() => { if (state.required) wall('Location was switched off in your browser. Please allow it again.'); });
    } else if (!state.asked && !state.required) setTimeout(card, 4000);
    if (state.required) return;                // compulsory: no opt-out toggle to show
    if (location.pathname.indexOf('dashboard') < 0 && location.pathname !== '/dashboard') return;
    new MutationObserver(settingsRow).observe(document.body, { childList: true, subtree: true });
    settingsRow();
  }
  window.GhostLocation = { share, stop };
  document.addEventListener('DOMContentLoaded', () => setTimeout(init, 800));
})();
