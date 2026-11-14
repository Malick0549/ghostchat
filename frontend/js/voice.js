/**
 * GHOSTCHAT VOICE TYPING  v1
 * Speak instead of type, in the chat box and the Encrypt box.
 *
 * Uses the browser's built-in speech recognition (Web Speech API).
 *  - It is NOT available in every browser (works in Chrome, Edge and Safari; not Firefox).
 *    Where it is missing the microphone button simply stays hidden.
 *  - IMPORTANT PRIVACY NOTE: in Chrome and Edge the audio is sent to the browser maker's
 *    speech service (Google / Microsoft) to be turned into text. GhostChat never receives
 *    the audio, but that service does. So we ask the person to agree once, and we never
 *    attach voice typing to a password field.
 *
 * Markup:  <textarea data-voice>  gets a mic button automatically.
 *          Or call GhostVoice.attach(textarea, button) with your own button.
 */
window.GhostVoice = (() => {
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    const supported = !!SR;
    const CONSENT_KEY = 'gc_voice_consent_v1';
    const toast = (m, t = 'info') => { try { window.UI?.showToast(m, t); } catch (_) {} };
    const lsGet = k => { try { return localStorage.getItem(k); } catch (_) { return null; } };
    const lsSet = (k, v) => { try { localStorage.setItem(k, v); } catch (_) {} };

    let active = null;                       // only one box listens at a time

    function css() {
        if (document.getElementById('gv-css')) return;
        const st = document.createElement('style'); st.id = 'gv-css';
        st.textContent = `
        .gv-host{position:relative}
        .gv-btn{display:inline-flex;align-items:center;justify-content:center;width:38px;height:38px;border-radius:50%;border:1px solid var(--border,rgba(255,255,255,.15));
          background:var(--bg2,rgba(255,255,255,.06));color:var(--t2,#9aa);cursor:pointer;font-size:15px;transition:all .15s}
        .gv-btn:hover{color:var(--primary,#4dd);border-color:var(--primary,#4dd)}
        .gv-btn.gv-abs{position:absolute;right:10px;bottom:10px;z-index:2}
        .gv-btn.listening{background:#e5484d;border-color:#e5484d;color:#fff;animation:gvp 1.2s infinite}
        @keyframes gvp{0%{box-shadow:0 0 0 0 rgba(229,72,77,.55)}100%{box-shadow:0 0 0 12px rgba(229,72,77,0)}}
        @media (prefers-reduced-motion:reduce){.gv-btn.listening{animation:none}}
        .gv-modal{position:fixed;inset:0;background:rgba(0,0,0,.6);display:flex;align-items:center;justify-content:center;z-index:9999;padding:16px}
        .gv-card{max-width:420px;width:100%;background:var(--bg1,#12151f);color:var(--t1,#eef);border:1px solid var(--border,rgba(255,255,255,.15));border-radius:16px;padding:22px}
        .gv-card h3{margin:0 0 10px;font-size:17px}.gv-card p{margin:0 0 10px;font-size:14px;line-height:1.5;opacity:.9}
        .gv-row{display:flex;gap:10px;justify-content:flex-end;margin-top:16px;flex-wrap:wrap}
        .gv-row button{padding:10px 16px;border-radius:10px;border:1px solid var(--border,rgba(255,255,255,.2));background:transparent;color:inherit;cursor:pointer;font:inherit}
        .gv-row button.gv-ok{background:var(--primary,#4dd);border-color:var(--primary,#4dd);color:#04060e;font-weight:600}`;
        document.head.appendChild(st);
    }

    function askConsent() {
        if (lsGet(CONSENT_KEY) === '1') return Promise.resolve(true);
        css();
        return new Promise(res => {
            const m = document.createElement('div'); m.className = 'gv-modal'; m.setAttribute('role', 'dialog'); m.setAttribute('aria-modal', 'true'); m.setAttribute('aria-labelledby', 'gvT');
            m.innerHTML = `<div class="gv-card"><h3 id="gvT"><i class="fas fa-microphone-lines"></i> Before you use voice typing</h3>
              <p>Voice typing is done by <b>your browser</b>. In Chrome and Edge your voice is sent to Google or Microsoft to be turned into text. GhostChat never receives your voice.</p>
              <p>So anything you <b>say</b> is not protected by GhostChat's encryption until it has been typed. Do not use it for secrets, passwords or sensitive details.</p>
              <div class="gv-row"><button type="button" class="gv-no">Cancel</button><button type="button" class="gv-ok">I understand, continue</button></div></div>`;
            const done = v => { m.remove(); if (v) lsSet(CONSENT_KEY, '1'); res(v); };
            m.querySelector('.gv-no').onclick = () => done(false);
            m.querySelector('.gv-ok').onclick = () => done(true);
            m.addEventListener('keydown', e => { if (e.key === 'Escape') done(false); });
            m.addEventListener('click', e => { if (e.target === m) done(false); });
            document.body.appendChild(m); m.querySelector('.gv-ok').focus();
        });
    }

    function attach(ta, btn, opts = {}) {
        if (!supported || !ta || !btn || btn._gv) return null;
        btn._gv = true; btn.hidden = false; btn.style.display = '';
        btn.setAttribute('aria-pressed', 'false');
        btn.title = 'Voice typing'; btn.setAttribute('aria-label', 'Voice typing');

        let rec = null, on = false, before = '', after = '', lastSet = '', errored = false;

        const write = (finalTxt, interim) => {
            const sp = (before && !/\s$/.test(before) ? ' ' : '');
            const mid = (finalTxt + interim).replace(/\s+/g, ' ');
            ta.value = lastSet = before + (mid ? sp + mid : '') + after;
            const caret = (before + (mid ? sp + mid : '')).length;
            try { ta.setSelectionRange(caret, caret); } catch (_) {}
            ta.dispatchEvent(new Event('input', { bubbles: true }));   // lets the page resize / show "typing"
        };
        const rebase = () => {                                         // text changed by someone else (typing, or a sent message)
            const pos = ta.selectionStart ?? ta.value.length;
            before = ta.value.slice(0, pos); after = ta.value.slice(pos); lastSet = ta.value;
        };
        const ui = v => { btn.classList.toggle('listening', v); btn.setAttribute('aria-pressed', String(v)); btn.title = v ? 'Stop voice typing' : 'Voice typing'; };

        function begin() {
            rec = new SR();
            rec.continuous = true; rec.interimResults = true; rec.maxAlternatives = 1;
            rec.lang = opts.lang || lsGet('gc_voice_lang') || navigator.language || 'en-US';
            let committed = '';
            rec.onresult = ev => {
                if (ta.value !== lastSet) { rebase(); committed = ''; try { rec.abort(); } catch (_) {} return; }   // restarts fresh in onend
                let fin = '', itm = '';
                for (let i = 0; i < ev.results.length; i++) (ev.results[i].isFinal ? (fin += ev.results[i][0].transcript) : (itm += ev.results[i][0].transcript));
                committed = fin; write(committed, itm);
                if (ev.results[ev.results.length - 1]?.isFinal) { /* kept; next phrase continues after it */ }
            };
            rec.onerror = ev => {
                errored = true;
                if (ev.error === 'not-allowed' || ev.error === 'service-not-allowed') { toast('Microphone is blocked. Allow it in your browser\'s site settings to use voice typing.', 'error'); stop(); }
                else if (ev.error === 'audio-capture') { toast('No microphone was found.', 'error'); stop(); }
                else if (ev.error === 'network') { toast('Voice typing needs an internet connection.', 'error'); stop(); }
                else if (ev.error === 'language-not-supported') { toast('That language is not supported for voice typing.', 'error'); stop(); }
                else errored = false;                                   // 'no-speech' / 'aborted': just carry on
            };
            rec.onend = () => {                                         // browsers stop after silence — keep going until the person stops
                if (on && !errored) { rebase(); try { begin(); } catch (_) { stop(); } } else if (!on) ui(false);
            };
            rec.start();
        }
        function stop() { on = false; if (active === api) active = null; try { rec && rec.stop(); } catch (_) {} ui(false); }
        async function start() {
            if (active && active !== api) active.stop();
            if (!(await askConsent())) return;
            errored = false; rebase(); on = true; active = api; ui(true);
            try { begin(); ta.focus(); } catch (_) { stop(); toast('Could not start voice typing.', 'error'); }
        }
        const api = { start, stop, get listening() { return on; } };
        btn.addEventListener('click', e => { e.preventDefault(); on ? stop() : start(); });
        document.addEventListener('visibilitychange', () => { if (document.hidden && on) stop(); });
        window.addEventListener('pagehide', stop);
        return api;
    }

    // Any <textarea data-voice> gets its own mic button (works for pages that render later).
    function scan(root) {
        if (!supported) return;
        (root || document).querySelectorAll('textarea[data-voice]:not([data-voice-ready])').forEach(ta => {
            ta.setAttribute('data-voice-ready', '1'); css();
            const host = ta.parentElement; host.classList.add('gv-host');
            const b = document.createElement('button'); b.type = 'button'; b.className = 'gv-btn gv-abs';
            b.innerHTML = '<i class="fas fa-microphone-lines" aria-hidden="true"></i>';
            host.appendChild(b); attach(ta, b);
        });
    }
    function init() {
        if (!supported) return;
        scan();
        new MutationObserver(() => scan()).observe(document.body, { childList: true, subtree: true });
    }
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();

    return { supported, attach, scan, setLanguage: l => lsSet('gc_voice_lang', String(l || '')) };
})();
