/**
 * GHOSTCHAT ENCRYPTION SCREEN  v1   (needs e2e.js)
 *
 *  - open(contact)       the per-chat "Encryption" screen (mode, status, manual keys, backup)
 *  - attach(contact)     tell it which chat is open (updates the key button's colour/tooltip)
 *  - blocked(c, reason)  explain why a message was not sent, and open the fix
 *  - mountSettings(el)   the "Message encryption" block for the Settings page
 *
 * Self-contained: injects its own styles and markup, uses the app's theme variables.
 */
window.GhostE2EUI = (() => {
    const E = () => window.GhostE2E;
    const BASE = ((document.currentScript && document.currentScript.src) || '').replace(/[^/]*$/, '');
    const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

    let contact = null, ov = null, tab = 'dh', scanner = null, busy = false, msg = null, shown = null, drafts = {};
    const cid = () => contact && contact.contact_id;
    const nm = () => (contact && (contact.display_name || contact.username)) || 'your contact';

    // ── helpers ──────────────────────────────────────────────────────────────
    function toast(text, type) {
        if (window.chat && typeof window.chat._toast === 'function') return window.chat._toast(text, type || 'info');
        if (window.UI && UI.showToast) return UI.showToast(text, type || 'info');
        try { alert(text); } catch (_) {}
    }
    const libs = {};
    function loadScript(src) {
        return libs[src] || (libs[src] = new Promise((res, rej) => {
            const s = document.createElement('script');
            s.src = src; s.onload = res; s.onerror = () => { delete libs[src]; rej(new Error('Could not load ' + src)); };
            document.head.appendChild(s);
        }));
    }
    async function drawQR(canvas, text) {
        try {
            await loadScript(BASE + 'vendor/qrcode.min.js');
            const qr = window.qrcode(0, 'M'); qr.addData(text); qr.make();
            const n = qr.getModuleCount(), quiet = 4, scale = Math.max(3, Math.floor(240 / (n + quiet * 2)));
            const size = (n + quiet * 2) * scale;
            canvas.width = size; canvas.height = size;
            const g = canvas.getContext('2d');
            g.fillStyle = '#fff'; g.fillRect(0, 0, size, size);          // always black-on-white so cameras can read it
            g.fillStyle = '#000';
            for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (qr.isDark(r, c)) g.fillRect((c + quiet) * scale, (r + quiet) * scale, scale, scale);
            canvas.style.display = '';
        } catch (_) { canvas.style.display = 'none'; }                  // QR is optional: the text code still works
    }
    async function copyText(t) {
        try { await navigator.clipboard.writeText(t); toast('Copied', 'success'); }
        catch (_) {
            const ta = document.createElement('textarea'); ta.value = t; document.body.appendChild(ta); ta.select();
            try { document.execCommand('copy'); toast('Copied', 'success'); } catch (e) { toast('Select the text and copy it manually', 'info'); }
            ta.remove();
        }
    }

    // ── styles ───────────────────────────────────────────────────────────────
    function injectStyles() {
        if (document.getElementById('ge2e-style')) return;
        const st = document.createElement('style'); st.id = 'ge2e-style';
        st.textContent = `
.ge2e-ov{position:fixed;inset:0;z-index:10050;background:rgba(0,0,0,.66);display:flex;align-items:center;justify-content:center;padding:12px;-webkit-backdrop-filter:blur(3px);backdrop-filter:blur(3px)}
.ge2e{position:relative;background:var(--card,#101826);color:var(--t1,#e8eef8);border:1px solid var(--border,#26334a);border-radius:16px;width:100%;max-width:540px;max-height:92vh;overflow:auto;box-shadow:0 24px 70px rgba(0,0,0,.55);font-size:.92rem;line-height:1.45}
.ge2e *{box-sizing:border-box}
.ge2e-hd{position:sticky;top:0;z-index:2;display:flex;align-items:center;gap:10px;padding:14px 16px;background:var(--card,#101826);border-bottom:1px solid var(--border,#26334a)}
.ge2e-hd h3{margin:0;font-size:1rem;flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.ge2e-x{background:none;border:0;color:var(--t2,#9fb0c8);font-size:1.5rem;line-height:1;cursor:pointer;padding:2px 8px;border-radius:8px}
.ge2e-x:hover{background:var(--bg3,rgba(255,255,255,.08))}
.ge2e-bd{padding:14px 16px 18px;display:flex;flex-direction:column;gap:14px}
.ge2e-sec{display:flex;flex-direction:column;gap:8px}
.ge2e-lbl{font-size:.74rem;text-transform:uppercase;letter-spacing:.06em;color:var(--t3,#7d8ea8);font-weight:700}
.ge2e-seg{display:flex;gap:6px;flex-wrap:wrap}
.ge2e-seg button,.ge2e-tabs button{flex:1 1 0;min-width:0;padding:9px 8px;border-radius:10px;border:1px solid var(--border,#26334a);background:var(--bg2,#0b1220);color:var(--t2,#9fb0c8);cursor:pointer;font:inherit;font-weight:600}
.ge2e-seg button.on,.ge2e-tabs button.on{background:var(--primary-dim,rgba(0,200,255,.14));border-color:var(--primary,#00c8ff);color:var(--t1,#e8eef8)}
.ge2e-tabs{display:flex;gap:6px}
.ge2e-box{border:1px solid var(--border,#26334a);background:var(--bg2,#0b1220);border-radius:12px;padding:12px;display:flex;flex-direction:column;gap:8px}
.ge2e-st{display:flex;gap:10px;align-items:flex-start}
.ge2e-dot{flex:none;width:10px;height:10px;border-radius:50%;margin-top:5px;background:var(--amber,#f5a524)}
.ge2e-dot.ok{background:var(--green,#2ecc71)}.ge2e-dot.bad{background:var(--red,#ff5d5d)}
.ge2e-mono{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;word-break:break-all;font-size:.82rem}
.ge2e textarea,.ge2e input[type=text],.ge2e input[type=password]{width:100%;background:var(--bg,#070d18);color:var(--t1,#e8eef8);border:1px solid var(--border,#26334a);border-radius:10px;padding:10px;font:inherit;font-size:.85rem}
.ge2e textarea{min-height:66px;resize:vertical;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}
.ge2e textarea:focus,.ge2e input:focus{outline:2px solid var(--primary,#00c8ff);outline-offset:1px}
.ge2e-row{display:flex;gap:8px;flex-wrap:wrap}
.ge2e-btn{padding:9px 14px;border-radius:10px;border:1px solid var(--border,#26334a);background:var(--bg3,#162033);color:var(--t1,#e8eef8);cursor:pointer;font:inherit;font-weight:600}
.ge2e-btn:hover{border-color:var(--primary,#00c8ff)}
.ge2e-btn.pri{background:var(--primary,#00c8ff);border-color:var(--primary,#00c8ff);color:#04121c}
.ge2e-btn.dng{color:var(--red,#ff5d5d)}
[data-theme="light"] .ge2e-btn.pri{color:#fff}
.ge2e-btn[disabled]{opacity:.5;cursor:default}
.ge2e-sm{font-size:.8rem;color:var(--t2,#9fb0c8)}
.ge2e-qr{align-self:center;max-width:100%;height:auto;border-radius:8px;background:#fff}
.ge2e-msg{padding:10px 12px;border-radius:10px;font-size:.86rem}
.ge2e-msg.ok{background:rgba(46,204,113,.14);border:1px solid rgba(46,204,113,.5)}
.ge2e-msg.err{background:rgba(255,93,93,.12);border:1px solid rgba(255,93,93,.5)}
.ge2e-meter{display:flex;gap:4px}.ge2e-meter i{flex:1;height:5px;border-radius:3px;background:var(--border,#26334a)}
.ge2e-meter i.on{background:var(--amber,#f5a524)}.ge2e-meter.good i.on{background:var(--green,#2ecc71)}
.ge2e-scan{position:absolute;inset:0;z-index:5;background:#000;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:12px;padding:12px;border-radius:16px}
.ge2e-scan video{width:100%;max-height:70%;object-fit:cover;border-radius:12px;background:#111}
.ge2e-scan .ge2e-sm{color:#ddd}
.ge2e details>summary{cursor:pointer;font-weight:600;color:var(--t2,#9fb0c8)}
@media (max-width:480px){.ge2e-ov{padding:0;align-items:flex-end}.ge2e{max-width:none;max-height:94vh;border-radius:16px 16px 0 0}}
`;
        document.head.appendChild(st);
    }

    // ── reading the current state ────────────────────────────────────────────
    const MODE_LABEL = { auto: 'Automatic', manual: 'Manual' };
    async function gather() {
        const e = E(), id = cid();
        const g = { mode: e.getMode(id), override: e.getOverride(id), def: e.getDefault() };
        if (g.mode === 'auto') g.auto = await e.autoInfo(id);
        else { g.info = await e.manualInfo(id); g.st = await e.manualStatus(id, true); }
        return g;
    }
    function statusBlock(g) {
        let cls = '', head = '', body = '';
        if (g.mode === 'auto') {
            if (g.auto.ready) {
                cls = 'ok'; head = 'Automatic encryption is active';
                body = `Keys were created and shared for you. To be sure nobody is intercepting, compare this <b>safety number</b> with ${esc(nm())} (in person or on a call):<div class="ge2e-mono" style="margin-top:6px;font-size:.95rem">${esc(g.auto.safety)}</div>`;
            } else {
                head = `Waiting for ${esc(nm())}`;
                body = `${esc(nm())} has not opened GhostChat since secure messaging was added, so there is no key to use yet. Ask them to open the chat once. Until then messages to them are not sent.`;
            }
        } else {
            const s = g.st.state, id = g.info.kid ? g.info.kid.slice(0, 8).replace(/(.{4})/, '$1 ') : '';
            if (s === 'ready' || s === 'unknown') {
                cls = 'ok'; head = s === 'ready' ? 'Manual key is active' : 'Manual key set (cannot reach the server to double-check)';
                body = `Key ID <span class="ge2e-mono">${esc(id)}</span>. ${esc(nm())} should see the <b>same Key ID</b>.`;
            } else if (s === 'no_key') {
                cls = 'bad'; head = 'No key yet';
                body = `Set one up below. Until you do, messages to ${esc(nm())} are not sent.`;
            } else if (s === 'waiting') {
                head = `Waiting for ${esc(nm())} to set the same key`;
                body = `Your key ID is <span class="ge2e-mono">${esc(id)}</span>. Messages are held back until ${esc(nm())} finishes the same setup.`;
            } else {
                cls = 'bad'; head = 'The two keys do not match';
                body = `Yours is <span class="ge2e-mono">${esc(id)}</span>, theirs is <span class="ge2e-mono">${esc((g.st.theirs || '').slice(0, 8).replace(/(.{4})/, '$1 '))}</span>. Redo the setup together, and make sure you both use the same method and the same code or passphrase.`;
            }
        }
        return `<div class="ge2e-box"><div class="ge2e-st"><span class="ge2e-dot ${cls}"></span><div><b>${head}</b><div class="ge2e-sm" style="margin-top:3px">${body}</div></div></div>${g.mode === 'manual' ? '<div class="ge2e-row"><button class="ge2e-btn" data-act="refresh">Check again</button></div>' : ''}</div>`;
    }
    function strengthMeter(p) {
        const s = E().passStrength(p), on = s.score;
        return `<div class="ge2e-meter ${on >= 3 ? 'good' : ''}" aria-hidden="true">${[1, 2, 3, 4].map(i => `<i class="${i <= on ? 'on' : ''}"></i>`).join('')}</div><div class="ge2e-sm" id="ge2ePassLbl">${esc(p ? s.label : 'Use a sentence of 4+ random words')}</div>`;
    }

    async function manualPanels(g) {
        const e = E(), id = cid();
        const tabs = `<div class="ge2e-tabs" role="tablist">
            <button role="tab" data-act="tab" data-v="dh" class="${tab === 'dh' ? 'on' : ''}">Diffie-Hellman</button>
            <button role="tab" data-act="tab" data-v="random" class="${tab === 'random' ? 'on' : ''}">Random key</button>
            <button role="tab" data-act="tab" data-v="pass" class="${tab === 'pass' ? 'on' : ''}">Passphrase</button></div>`;
        let body = '';
        if (tab === 'dh') {
            const mine = (await e.dhStart(id)).share;
            body = `<div class="ge2e-sm">Each of you shows a code and scans or pastes the other's. The secret is worked out on both devices, and nothing secret is ever sent. <b>Recommended.</b></div>
              <div class="ge2e-lbl">1. Your code (show it to ${esc(nm())})</div>
              <canvas class="ge2e-qr" data-qr="${esc(mine)}" style="display:none" aria-label="Your QR code"></canvas>
              <textarea readonly id="ge2eMine" rows="2" aria-label="Your code">${esc(mine)}</textarea>
              <div class="ge2e-row"><button class="ge2e-btn" data-act="copy" data-t="${esc(mine)}">Copy my code</button></div>
              <div class="ge2e-lbl">2. Their code</div>
              <textarea id="ge2eCode" rows="2" placeholder="Paste ${esc(nm())}'s code here (starts with GCDH1.)" aria-label="Their code"></textarea>
              <div class="ge2e-row"><button class="ge2e-btn" data-act="scan">Scan their QR</button><button class="ge2e-btn pri" data-act="apply">Use their code</button></div>
              <div class="ge2e-sm">Your code stays the same until you ask for new ones, so ${esc(nm())} can still scan it after you finish.${g.info.method === 'dh' ? ' <a href="#" data-act="dhreset">Make new codes (re-key)</a>' : ''}</div>`;
        } else if (tab === 'random') {
            const share = shown || await e.manualShare(id);
            body = `<div class="ge2e-sm">The app makes a random 256-bit key. Hand it to ${esc(nm())} <b>in person (QR)</b> or through a channel you trust. Anyone who gets this code can read your messages.</div>
              <div class="ge2e-row"><button class="ge2e-btn pri" data-act="gen">${share ? 'Make a new key' : 'Make a key'}</button></div>
              ${share ? `<div class="ge2e-lbl">Your key code (give this to ${esc(nm())})</div>
                <canvas class="ge2e-qr" data-qr="${esc(share)}" style="display:none" aria-label="Key QR code"></canvas>
                <textarea readonly rows="2" aria-label="Key code">${esc(share)}</textarea>
                <div class="ge2e-row"><button class="ge2e-btn" data-act="copy" data-t="${esc(share)}">Copy key code</button></div>` : ''}
              <div class="ge2e-lbl">Got a key code from ${esc(nm())}?</div>
              <textarea id="ge2eCode" rows="2" placeholder="Paste the code here (starts with GCKEY1.)" aria-label="Key code from contact"></textarea>
              <div class="ge2e-row"><button class="ge2e-btn" data-act="scan">Scan their QR</button><button class="ge2e-btn pri" data-act="apply">Use this key</button></div>`;
        } else {
            body = `<div class="ge2e-sm">You both type the <b>exactly same</b> passphrase. It is stretched into a key on your device. Pick something long and unique, and tell ${esc(nm())} through a safe channel. A guessable phrase can be cracked, because the encrypted messages are stored on the server.</div>
              <input type="password" id="ge2ePass" autocomplete="off" placeholder="Shared passphrase" aria-label="Shared passphrase" value="${esc(drafts.pass || '')}">
              ${strengthMeter(drafts.pass || '')}
              <div class="ge2e-row"><button class="ge2e-btn" data-act="showpass">Show / hide</button><button class="ge2e-btn pri" data-act="usepass">Use this passphrase</button></div>`;
        }
        const keyActions = g.info.hasKey ? `<div class="ge2e-row" style="margin-top:4px"><button class="ge2e-btn" data-act="retire">Stop using this key</button><button class="ge2e-btn dng" data-act="wipe">Erase keys for this chat</button></div>
              <div class="ge2e-sm">Old messages stay readable after you change or stop using a key, until you erase the keys.</div>` : '';
        return `<div class="ge2e-sec"><div class="ge2e-lbl">Set the key</div>${tabs}<div class="ge2e-box">${body}</div>${keyActions}</div>`;
    }
    function backupBlock() {
        return `<details class="ge2e-sec"><summary>Back up or restore manual keys</summary>
            <div class="ge2e-box" style="margin-top:8px"><div class="ge2e-sm">A backup locks <b>all</b> your manual keys with a passphrase and stores the locked copy on GhostChat. Only that passphrase can open it, so GhostChat cannot read your keys. Use it to read your chats on a new phone or computer.</div>
            <input type="password" id="ge2eBk" autocomplete="off" placeholder="Backup passphrase (8+ characters)" aria-label="Backup passphrase" value="${esc(drafts.bk || '')}">
            <div class="ge2e-row"><button class="ge2e-btn pri" data-act="backup">Back up now</button><button class="ge2e-btn" data-act="restore">Restore from backup</button></div></div></details>`;
    }

    // ── render ───────────────────────────────────────────────────────────────
    function keepDrafts() {
        if (!ov) return;
        const q = s => ov.querySelector(s);
        if (q('#ge2eCode')) drafts.code = q('#ge2eCode').value;
        if (q('#ge2ePass')) drafts.pass = q('#ge2ePass').value;
        if (q('#ge2eBk')) drafts.bk = q('#ge2eBk').value;
    }
    async function render() {
        if (!ov) return;
        keepDrafts();
        const keepOpen = ov.querySelector('details') && ov.querySelector('details').open;
        const dlg = ov.querySelector('.ge2e'), scrollTop = dlg.scrollTop;
        let g;
        try { g = await gather(); } catch (err) { dlg.querySelector('.ge2e-bd').innerHTML = `<div class="ge2e-msg err">Could not load encryption details: ${esc(err.message)}</div>`; return; }
        const e = E(), def = g.def, ovr = g.override;
        const seg = `<div class="ge2e-seg" role="radiogroup" aria-label="Encryption mode for this chat">
            ${[['default', `Default (${MODE_LABEL[def]})`], ['auto', 'Automatic'], ['manual', 'Manual']].map(([v, l]) =>
                `<button role="radio" aria-checked="${(ovr || 'default') === v}" data-act="mode" data-v="${v}" class="${(ovr || 'default') === v ? 'on' : ''}">${l}</button>`).join('')}</div>`;
        const help = g.mode === 'auto'
            ? 'Automatic: GhostChat creates and shares the keys for you. Nothing to type.'
            : 'Manual: you and your contact choose the key yourselves. GhostChat never creates or sees it.';
        const msgHtml = msg ? `<div class="ge2e-msg ${msg.type}" role="status">${msg.html}</div>` : '';
        dlg.querySelector('.ge2e-bd').innerHTML =
            `<div class="ge2e-sec"><div class="ge2e-lbl">Encryption mode for this chat</div>${seg}<div class="ge2e-sm">${help}</div></div>
             ${msgHtml}${statusBlock(g)}${g.mode === 'manual' ? await manualPanels(g) : ''}${backupBlock()}`;
        if (keepOpen) dlg.querySelector('details').open = true;
        const q = s => dlg.querySelector(s);
        if (q('#ge2eCode') && drafts.code) q('#ge2eCode').value = drafts.code;
        dlg.querySelectorAll('canvas[data-qr]').forEach(c => drawQR(c, c.getAttribute('data-qr')));
        dlg.scrollTop = scrollTop;
        refreshBadge();
    }
    const setMsg = (type, html) => { msg = html ? { type, html } : null; };

    // ── actions ──────────────────────────────────────────────────────────────
    async function guarded(btn, fn) {
        if (busy) return; busy = true;
        const old = btn && btn.textContent; if (btn) { btn.disabled = true; }
        try { await fn(); } catch (err) { setMsg('err', esc(err.message || 'Something went wrong')); }
        finally { busy = false; if (btn) { btn.disabled = false; if (old != null) btn.textContent = old; } await render(); }
    }
    async function onClick(ev) {
        const b = ev.target.closest('[data-act]'); if (!b || !ov) return;
        const act = b.dataset.act, e = E(), id = cid();
        if (act === 'close') return close();
        if (act === 'copy') return copyText(b.dataset.t);
        if (act === 'showpass') { const p = ov.querySelector('#ge2ePass'); if (p) p.type = p.type === 'password' ? 'text' : 'password'; return; }
        if (act === 'scan') return scan();
        if (act === 'scan-stop') { if (scanner) scanner.stop(); return; }
        if (act === 'mode') { keepDrafts(); e.setOverride(id, b.dataset.v === 'default' ? null : b.dataset.v); setMsg(); shown = null; return render(); }
        if (act === 'tab') { keepDrafts(); tab = b.dataset.v; setMsg(); return render(); }
        if (act === 'refresh') return guarded(b, async () => { setMsg(); });
        if (act === 'apply') return guarded(b, () => applyCode((ov.querySelector('#ge2eCode') || {}).value));
        if (act === 'gen') return guarded(b, async () => {
            const info = await e.manualInfo(id);
            if (info.hasKey && !confirm(`Replace the current key with ${nm()}? Messages are held back until they use the new one. Old messages stay readable.`)) return;
            const r = await e.randomCreate(id); shown = r.share;
            setMsg('ok', 'New key made. Give the code below to ' + esc(nm()) + ' and ask them to enter it.');
        });
        if (act === 'usepass') return guarded(b, async () => {
            const p = (ov.querySelector('#ge2ePass') || {}).value || '';
            const r = await e.passphrase(id, p); drafts.pass = '';
            setMsg('ok', 'Passphrase set (Key ID ' + esc(r.kid.slice(0, 8)) + '). ' + esc(nm()) + ' must enter exactly the same phrase.');
        });
        if (act === 'dhreset') { ev.preventDefault(); return guarded(null, async () => {
            if (!confirm(`Make new codes with ${nm()}? You will both need to scan/paste the new codes. Old messages stay readable.`)) return;
            await e.dhReset(id); drafts.code = ''; setMsg('ok', 'New codes made. Exchange them again.');
        }); }
        if (act === 'retire') return guarded(b, async () => { await e.manualRetire(id); shown = null; setMsg('ok', 'Stopped using the key. Old messages are still readable.'); });
        if (act === 'wipe') return guarded(b, async () => {
            if (!confirm(`Erase ALL manual keys for ${nm()} from this device?\n\nMessages that used them become unreadable here unless you have a backup.`)) return;
            await e.manualWipe(id); shown = null; drafts = {}; setMsg('ok', 'Keys erased from this device.');
        });
        if (act === 'backup') return guarded(b, async () => {
            const r = await e.backup((ov.querySelector('#ge2eBk') || {}).value || ''); drafts.bk = '';
            setMsg('ok', `Backed up ${r.contacts} chat${r.contacts === 1 ? '' : 's'}. Keep the passphrase safe: it cannot be recovered.`);
        });
        if (act === 'restore') return guarded(b, async () => {
            const r = await e.restore((ov.querySelector('#ge2eBk') || {}).value || ''); drafts.bk = '';
            setMsg('ok', `Restored ${r.keys} key${r.keys === 1 ? '' : 's'} for ${r.contacts} chat${r.contacts === 1 ? '' : 's'}.`);
        });
    }
    async function applyCode(text) {
        if (!String(text || '').trim()) throw new Error('Paste or scan a code first.');
        const r = await E().importCode(cid(), text);
        drafts.code = '';
        if (r.kind === 'dh') setMsg('ok', `Key set. <b>Check number:</b> <span class="ge2e-mono">${esc(r.check)}</span><br>It must be identical on ${esc(nm())}'s screen. If it is not, do not trust the key.`);
        else setMsg('ok', 'Key set (Key ID ' + esc(r.kid.slice(0, 8)) + '). ' + esc(nm()) + ' should see the same Key ID.');
    }

    // ── QR scanning ──────────────────────────────────────────────────────────
    async function scan() {
        if (scanner) return;
        if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) { setMsg('err', 'The camera is not available here. Paste the code instead.'); return render(); }
        const dlg = ov.querySelector('.ge2e');
        const wrap = document.createElement('div'); wrap.className = 'ge2e-scan';
        wrap.innerHTML = '<video playsinline muted></video><div class="ge2e-sm">Point the camera at the QR code</div><button class="ge2e-btn" data-act="scan-stop">Cancel</button>';
        dlg.appendChild(wrap);
        let stream;
        try { stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' } }, audio: false }); }
        catch (err) {
            wrap.remove();
            setMsg('err', err && err.name === 'NotAllowedError' ? 'Camera permission was denied. Allow the camera in your browser, or paste the code instead.' : 'No usable camera was found. Paste the code instead.');
            return render();
        }
        const video = wrap.querySelector('video'); video.srcObject = stream;
        try { await video.play(); } catch (_) {}
        let detector = null;
        if ('BarcodeDetector' in window) { try { detector = new window.BarcodeDetector({ formats: ['qr_code'] }); } catch (_) {} }
        if (!detector) { try { await loadScript(BASE + 'vendor/jsQR.min.js'); } catch (_) { wrap.remove(); stream.getTracks().forEach(t => t.stop()); setMsg('err', 'Scanner could not load. Paste the code instead.'); return render(); } }
        const canvas = document.createElement('canvas'), g = canvas.getContext('2d', { willReadFrequently: true });
        let stop = false;
        scanner = { stop() { stop = true; stream.getTracks().forEach(t => t.stop()); wrap.remove(); scanner = null; } };
        const tick = async () => {
            if (stop) return;
            try {
                let text = null;
                if (video.readyState >= 2 && video.videoWidth) {
                    if (detector) { const r = await detector.detect(video); text = r[0] && r[0].rawValue; }
                    else {
                        const w = video.videoWidth, h = video.videoHeight, sc = Math.min(1, 720 / Math.max(w, h));
                        canvas.width = Math.round(w * sc); canvas.height = Math.round(h * sc);
                        g.drawImage(video, 0, 0, canvas.width, canvas.height);
                        const im = g.getImageData(0, 0, canvas.width, canvas.height);
                        const r = window.jsQR(im.data, im.width, im.height, { inversionAttempts: 'attemptBoth' });
                        text = r && r.data;
                    }
                }
                if (text && /^GC(DH1|KEY1)\./.test(String(text).trim())) {
                    scanner.stop();
                    drafts.code = String(text).trim();
                    return guarded(null, () => applyCode(drafts.code));
                }
            } catch (_) {}
            setTimeout(tick, 140);
        };
        tick();
    }

    // ── open / close ─────────────────────────────────────────────────────────
    function close() {
        if (scanner) scanner.stop();
        if (ov) { ov.remove(); ov = null; }
        document.removeEventListener('keydown', onKey, true);
        shown = null; msg = null; drafts = {};
    }
    function onKey(e) { if (e.key === 'Escape' && ov) { e.stopPropagation(); scanner ? scanner.stop() : close(); } }
    async function open(c) {
        if (c) contact = c;
        if (!contact || !cid()) { toast('Open a chat first, then tap the key button', 'info'); return; }
        if (!E()) { toast('Encryption module is not loaded', 'error'); return; }
        if (!(window.isSecureContext && crypto && crypto.subtle)) { toast('Encryption needs a secure (https) connection', 'error'); return; }
        injectStyles(); close();
        ov = document.createElement('div'); ov.className = 'ge2e-ov';
        ov.innerHTML = `<div class="ge2e" role="dialog" aria-modal="true" aria-label="Encryption settings"><div class="ge2e-hd"><i class="fas fa-shield-halved" style="color:var(--primary,#00c8ff)"></i><h3>Encryption with ${esc(nm())}</h3><button class="ge2e-x" data-act="close" aria-label="Close">&times;</button></div><div class="ge2e-bd"><div class="ge2e-sm">Loading…</div></div></div>`;
        ov.addEventListener('click', ev => { if (ev.target === ov) close(); else onClick(ev); });
        ov.addEventListener('input', ev => {
            if (ev.target.id === 'ge2ePass') { drafts.pass = ev.target.value; const m = ov.querySelector('.ge2e-meter'), l = ov.querySelector('#ge2ePassLbl'); if (m && l) { const s = E().passStrength(ev.target.value); m.className = 'ge2e-meter ' + (s.score >= 3 ? 'good' : ''); [...m.children].forEach((el, i) => el.className = i < s.score ? 'on' : ''); l.textContent = ev.target.value ? s.label : 'Use a sentence of 4+ random words'; } }
        });
        document.body.appendChild(ov);
        document.addEventListener('keydown', onKey, true);
        msg = null;
        await render();
    }

    // ── the key button on the chat header ────────────────────────────────────
    let badgeSeq = 0;
    async function refreshBadge() {
        const btn = document.getElementById('setPasswordBtn'); if (!btn || !contact || !E()) return;
        const seq = ++badgeSeq, e = E(), id = cid();
        let ready = false, mode = e.getMode(id);
        try {
            if (mode === 'auto') ready = (await e.autoInfo(id)).ready;
            else { const s = (await e.manualStatus(id)).state; ready = s === 'ready' || s === 'unknown'; }
        } catch (_) {}
        if (seq !== badgeSeq) return;
        const i = btn.querySelector('i');
        if (i) i.style.color = ready ? 'var(--green,#2ecc71)' : 'var(--amber,#f5a524)';
        const t = `Encryption: ${MODE_LABEL[mode]} (${ready ? 'ready' : 'not ready yet'}). Tap to change.`;
        btn.title = t; btn.setAttribute('aria-label', t);
    }
    let badgeTimer = null;
    function attach(c) {
        contact = c; refreshBadge();
        if (!badgeTimer) {   // keep the key button colour fresh (e.g. once the contact finishes setting up)
            badgeTimer = setInterval(() => { if (!document.hidden) refreshBadge(); }, 20000);
            window.addEventListener('focus', () => refreshBadge());
        }
    }
    window.addEventListener('ghoste2e:changed', () => { refreshBadge(); });

    // ── why a message was not sent ───────────────────────────────────────────
    function blocked(c, reason, mode) {
        if (c) contact = c;
        const n = nm();
        const T = {
            no_manual_key: [`Not sent: this chat is in Manual mode but no key is set up yet.`, true],
            peer_not_ready: mode === 'manual'
                ? [`Not sent: ${n} has not set the same key yet. Finish the setup together, then send again.`, true]
                : [`Not sent: ${n} has not opened GhostChat since secure messaging was added, so there is no key to use. Ask them to open the chat once, or switch encryption off (lock button) to send without it.`, false],
            key_mismatch: [`Not sent: your key and ${n}'s key do not match. Redo the setup together.`, true],
            no_auto_key: ['Not sent: secure messaging is not unlocked on this device. Reload the page and enter your recovery passphrase.', false],
            error: ['Not sent: encryption failed. Try again.', false],
        };
        const [text, fixable] = T[reason] || T.error;
        toast(text, 'error');
        if (fixable) open(contact);
    }

    // ── Settings page block ──────────────────────────────────────────────────
    function mountSettings(el) {
        if (!el || !E()) return;
        let uid = null; try { uid = (JSON.parse(localStorage.getItem('ghostchat_user') || '{}') || {}).id; } catch (_) {}
        if (!uid) return;
        E().bindUser(uid);
        el.innerHTML = `<h3>Message encryption</h3>
          <div class="setting-row"><div><div class="setting-label">Default for chats</div>
            <div class="setting-sub"><b>Automatic:</b> keys are created and shared for you, nothing to type.<br><b>Manual:</b> you and your contact set the key yourselves (QR code, Diffie-Hellman, random key or passphrase).</div></div>
            <select id="e2eDefaultMode" aria-label="Default encryption mode"><option value="auto">Automatic (recommended)</option><option value="manual">Manual</option></select></div>
          <div class="setting-row"><div><div class="setting-sub">To use a different mode for one person, open the chat and tap the <b>key</b> button. Manual keys are set up there too.</div></div></div>`;
        const sel = el.querySelector('#e2eDefaultMode');
        sel.value = E().getDefault();
        sel.addEventListener('change', () => { E().setDefault(sel.value); if (window.UI && UI.showToast) UI.showToast('Encryption default saved', 'success'); });
    }

    return { open, close, attach, blocked, mountSettings, refreshBadge };
})();