/**
 * GHOSTCHAT INSTALL SUPPORT (PWA)
 * Registers the service worker and offers "Install app" where the browser allows it.
 * On iPhone/iPad (no install prompt exists) it shows a one-time "Add to Home Screen" hint.
 */
(() => {
    const okHost = location.protocol === 'https:' || location.hostname === 'localhost' || location.hostname === '127.0.0.1';
    if ('serviceWorker' in navigator && okHost) {
        window.addEventListener('load', () => { navigator.serviceWorker.register('/sw.js').catch(() => {}); });
    }
    const lsGet = k => { try { return localStorage.getItem(k); } catch (_) { return null; } };
    const lsSet = (k, v) => { try { localStorage.setItem(k, v); } catch (_) {} };
    const standalone = () => window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
    let deferred = null, chip = null;

    function show(text, onClick, withClose) {
        if (chip || standalone() || lsGet('gc_pwa_dismissed') === '1') return;
        chip = document.createElement('div'); chip.id = 'gcInstall'; chip.setAttribute('role', 'region'); chip.setAttribute('aria-label', 'Install GhostChat');
        chip.style.cssText = 'position:fixed;right:max(12px,env(safe-area-inset-right));bottom:max(12px,env(safe-area-inset-bottom));z-index:8999;display:flex;align-items:center;gap:10px;max-width:calc(100vw - 24px);padding:10px 12px 10px 16px;border-radius:999px;background:#1d1a3a;color:#eef;border:1px solid rgba(185,167,255,.45);box-shadow:0 8px 24px rgba(0,0,0,.4);font:500 14px/1.3 system-ui,sans-serif';
        const t = document.createElement('span'); t.textContent = text; chip.appendChild(t);
        if (onClick) { const b = document.createElement('button'); b.type = 'button'; b.textContent = 'Install'; b.style.cssText = 'border:0;border-radius:999px;padding:8px 14px;background:#b9a7ff;color:#150f33;font-weight:700;cursor:pointer;font:inherit;font-weight:700'; b.onclick = onClick; chip.appendChild(b); }
        const x = document.createElement('button'); x.type = 'button'; x.setAttribute('aria-label', 'Dismiss'); x.textContent = '×'; x.style.cssText = 'border:0;background:transparent;color:#aab;font-size:20px;line-height:1;cursor:pointer;padding:0 4px';
        x.onclick = () => { lsSet('gc_pwa_dismissed', '1'); chip.remove(); chip = null; }; chip.appendChild(x);
        document.body.appendChild(chip);
    }
    window.addEventListener('beforeinstallprompt', e => {
        e.preventDefault(); deferred = e;
        show('Install GhostChat on this device', async () => { if (!deferred) return; deferred.prompt(); try { await deferred.userChoice; } catch (_) {} deferred = null; if (chip) { chip.remove(); chip = null; } });
    });
    window.addEventListener('appinstalled', () => { if (chip) { chip.remove(); chip = null; } });
    const ios = /iphone|ipad|ipod/i.test(navigator.userAgent) && !window.MSStream;
    if (ios && !standalone()) setTimeout(() => show('To install: tap Share, then "Add to Home Screen"', null), 4000);
})();
