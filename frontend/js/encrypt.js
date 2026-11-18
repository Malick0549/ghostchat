/**
 * GHOSTCHAT ENCRYPTION MODULE  v3.2
 * Password-based AES-256-GCM + emoji packet, done entirely in the browser (GhostE2E.pwEncrypt):
 * the message and the password are never sent to the server.
 *
 * FIX: this module never dispatched the `ghostchat:encrypt` / `ghostchat:error`
 * window events that dashboard.js listens for — meaning the notification
 * badge, sound effects, and activity-log write triggered by those events
 * never actually fired on a real encrypt action. Dispatching them here is
 * what makes dashboard.js's notification system actually turn on.
 */

window.EncryptionModule = {
    _lastPacket: null,
    _mode: 'user',            // 'user' = locked to a GhostChat account, 'key' = key / password
    _recipient: null,         // { id, name }
    _keyChoice: 'generate',   // 'generate' | 'own'
    _genKey: '',
    _searchTimer: null,
    _searchSeq: 0,

    init() {
        this._mode = 'user'; this._recipient = null; this._keyChoice = 'generate';
        this._wire();
        this._newKey();
        this._paint();
    },

    _$(id) { return document.getElementById(id); },

    _wire() {
        const btn = this._$('encryptBtn');
        if (btn) {
            const fresh = btn.cloneNode(true);
            btn.parentNode.replaceChild(fresh, btn);
            fresh.addEventListener('click', () => this._encrypt());
        }

        const plain = this._$('plaintext');
        if (plain) plain.addEventListener('input', () => this._clearResult());

        this._dd('encModeDD', [
            { v: 'user', icon: 'fa-user-lock', t: 'To a GhostChat user', d: 'Locked so only that person\'s account can open it. No key to share.' },
            { v: 'key',  icon: 'fa-key',       t: 'With a key',          d: 'Works for anyone, even without GhostChat. You pass the key separately.' },
        ], () => this._mode, v => { this._mode = v; this._clearResult(); this._paint(); });
        this._dd('keyChoiceDD', [
            { v: 'generate', icon: 'fa-wand-magic-sparkles', t: 'Make a strong key for me', d: 'A new random key for every message. Nothing to invent.', badge: 'Recommended' },
            { v: 'own',      icon: 'fa-pen',                 t: 'I\'ll type my own key',   d: 'At least 8 characters. A short key can be guessed.' },
        ], () => this._keyChoice, v => { this._keyChoice = v; this._clearResult(); this._paint(); });
        this._$('genKeyNew')?.addEventListener('click', () => this._newKey());
        this._$('genKeyCopy')?.addEventListener('click', () => this._copyText(this._genKey, 'Key copied'));

        const q = this._$('recipientSearch');
        if (q) {
            q.addEventListener('input', () => { clearTimeout(this._searchTimer); this._searchTimer = setTimeout(() => this._search(q.value), 250); });
            q.addEventListener('focus', () => this._search(q.value));
            q.addEventListener('click', () => this._search(q.value));
            q.addEventListener('keydown', e => this._comboKeys(e));
        }
        if (!this._docWired) {
            this._docWired = true;
            document.addEventListener('click', e => {
                if (!e.target.closest('.gc-combo')) this._closeMenu();
                document.querySelectorAll('.gc-dd.open').forEach(d => { if (!d.contains(e.target)) d.classList.remove('open'); });
            });
        }
        [
            ['exportWhatsApp', () => this._exportWhatsApp()],
            ['exportTelegram', () => this._exportTelegram()],
            ['exportDiscord',  () => this._exportDiscord()],
            ['exportEmail',    () => this._exportEmail()],
            ['exportSMS',      () => this._exportSMS()],
            ['exportCopy',     () => this._copyPacket()],
            ['exportSave',     () => this._saveFile()],
        ].forEach(([id, fn]) => {
            const el = document.getElementById(id);
            if (!el) return;
            const f = el.cloneNode(true);
            el.parentNode.replaceChild(f, el);
            f.addEventListener('click', fn);
        });
    },


    // A labelled dropdown: a button showing the current choice (icon, title, one-line help) and a menu of options.
    _dd(id, options, get, set) {
        const root = this._$(id); if (!root) return;
        root.innerHTML = '';
        const btn = document.createElement('button'); btn.type = 'button'; btn.className = 'gc-dd-btn'; btn.setAttribute('aria-haspopup', 'listbox'); btn.setAttribute('aria-expanded', 'false');
        const menu = document.createElement('div'); menu.className = 'gc-menu gc-dd-menu'; menu.setAttribute('role', 'listbox');
        const row = (o, sel) => `<span class="gc-dd-ic"><i class="fas ${o.icon}"></i></span><span class="gc-opt-t"><b>${this._esc(o.t)}${o.badge ? ` <em>${this._esc(o.badge)}</em>` : ''}</b><small>${this._esc(o.d)}</small></span>${sel ? '<i class="fas fa-check gc-dd-ck"></i>' : ''}`;
        const render = () => {
            const cur = options.find(o => o.v === get()) || options[0];
            btn.innerHTML = row(cur, false) + '<i class="fas fa-chevron-down gc-dd-chev"></i>';
            menu.innerHTML = '';
            options.forEach(o => {
                const it = document.createElement('button'); it.type = 'button'; it.setAttribute('role', 'option'); it.dataset.value = o.v;
                it.setAttribute('aria-selected', o.v === cur.v ? 'true' : 'false'); it.className = 'gc-dd-opt' + (o.v === cur.v ? ' on' : '');
                it.innerHTML = row(o, o.v === cur.v);
                it.addEventListener('click', () => { root.classList.remove('open'); btn.setAttribute('aria-expanded', 'false'); if (o.v !== get()) set(o.v); render(); btn.focus(); });
                menu.appendChild(it);
            });
        };
        btn.addEventListener('click', () => { const o = root.classList.toggle('open'); btn.setAttribute('aria-expanded', o ? 'true' : 'false'); });
        root.addEventListener('keydown', e => {
            if (e.key === 'Escape') { root.classList.remove('open'); btn.setAttribute('aria-expanded', 'false'); btn.focus(); }
            if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
                e.preventDefault(); root.classList.add('open'); btn.setAttribute('aria-expanded', 'true');
                const opts = [...menu.querySelectorAll('button')], i = opts.indexOf(document.activeElement);
                opts[(i + (e.key === 'ArrowDown' ? 1 : -1) + opts.length) % opts.length].focus();
            }
        });
        root.appendChild(btn); root.appendChild(menu);
        root._render = render; render();
    },
    _ddRefresh() { ['encModeDD', 'keyChoiceDD'].forEach(id => this._$(id)?._render?.()); },

    // ── choose-how-to-send screen ───────────────────────────────────────────
    _paint() {
        this._ddRefresh();
        const userMode = this._mode === 'user';
        if (this._$('encUserPane')) this._$('encUserPane').hidden = !userMode;
        if (this._$('encKeyPane')) this._$('encKeyPane').hidden = userMode;
        const gen = this._keyChoice === 'generate';
        if (this._$('genKeyBox')) this._$('genKeyBox').hidden = !gen;
        if (this._$('ownKeyRow')) this._$('ownKeyRow').hidden = gen;
        const chosen = !!this._recipient;
        if (this._$('recipientPick')) this._$('recipientPick').hidden = chosen;
        const chip = this._$('recipientChosen');
        if (chip) {
            chip.hidden = !chosen;
            chip.innerHTML = chosen ? `<div class="gc-chip">${this._avatar(this._recipient)}<div><b>${this._esc(this._recipient.name)}</b><small style="display:block;color:var(--t3)">Only this account can open the message</small></div><button type="button" class="x" id="recipientClear" aria-label="Choose someone else">×</button></div>` : '';
            this._$('recipientClear')?.addEventListener('click', () => { this._recipient = null; this._hint('Only accounts that have opened secure chat once can receive this way.'); this._paint(); this._$('recipientSearch')?.focus(); });
        }
    },
    _hint(text, kind) { const h = this._$('recipientHint'); if (h) { h.textContent = text; h.className = 'gc-hint' + (kind ? ' ' + kind : ''); } },
    _avatar(u) {
        const ch = this._esc((u.name || '?').trim().charAt(0).toUpperCase());
        return `<span class="gc-av">${ch}</span>`;
    },
    _newKey() {
        try { this._genKey = window.GhostE2E.generateKey(); } catch (_) { this._genKey = ''; }
        const el = this._$('genKeyValue'); if (el) el.textContent = this._genKey;
    },
    _copyText(t, msg) {
        if (!t) return;
        if (window.secureCopy) window.secureCopy(t);
        else navigator.clipboard?.writeText(t).then(() => { if (window.UI) UI.showToast(msg || 'Copied!', 'success'); });
    },

    _closeMenu() {
        const box = this._$('recipientResults'), q = this._$('recipientSearch');
        if (box) box.hidden = true; if (q) q.setAttribute('aria-expanded', 'false');
    },
    _comboKeys(e) {
        const box = this._$('recipientResults'); if (!box) return;
        const opts = [...box.querySelectorAll('[role=option]')]; if (!opts.length && e.key !== 'Escape') return;
        const cur = opts.findIndex(o => o.classList.contains('active'));
        const go = i => { opts.forEach(o => o.classList.remove('active')); const o = opts[(i + opts.length) % opts.length]; o.classList.add('active'); o.scrollIntoView({ block: 'nearest' }); };
        if (e.key === 'ArrowDown') { e.preventDefault(); box.hidden = false; go(cur + 1); }
        else if (e.key === 'ArrowUp') { e.preventDefault(); go(cur < 0 ? opts.length - 1 : cur - 1); }
        else if (e.key === 'Enter') { const o = opts[cur >= 0 ? cur : (opts.length === 1 ? 0 : -1)]; if (o) { e.preventDefault(); o.click(); } }
        else if (e.key === 'Escape') this._closeMenu();
    },
    async _search(raw) {
        const box = this._$('recipientResults'); if (!box) return;
        const q = String(raw || '').trim(), seq = ++this._searchSeq;
        const input = this._$('recipientSearch');
        let people = [];
        box.hidden = false; if (input) input.setAttribute('aria-expanded', 'true');
        if (!box.children.length) box.innerHTML = '<div class="gc-menu-note"><i class="fas fa-spinner fa-spin"></i> Loading…</div>';
        try {
            if (q) {
                const d = await window.GhostChatAPI._get('/api/contacts/search?q=' + encodeURIComponent(q));
                people = (d.users || []).map(u => ({ id: u.id, name: u.username, sub: u.is_contact ? 'In your contacts' : '' }));
            } else {
                const d = await window.GhostChatAPI._get('/api/contacts');
                people = (d.contacts || []).map(c => ({ id: c.contact_id, name: c.display_name || c.username, sub: 'In your contacts' }));
            }
        } catch (e) { if (seq === this._searchSeq) box.innerHTML = '<div class="gc-menu-note">Could not load people. Try again.</div>'; return; }
        if (seq !== this._searchSeq) return;       // a newer search is running
        box.innerHTML = '';
        const head = document.createElement('div'); head.className = 'gc-menu-head'; head.textContent = q ? 'People' : 'Your contacts'; box.appendChild(head);
        if (!people.length) {
            const n = document.createElement('div'); n.className = 'gc-menu-note';
            n.textContent = q ? 'No one found. Check the spelling.' : 'No contacts yet. Type a username to search.'; box.appendChild(n);
        }
        people.slice(0, 20).forEach(p => {
            const b = document.createElement('button'); b.type = 'button'; b.setAttribute('role', 'option');
            b.innerHTML = `${this._avatar(p)}<span class="gc-opt-t"><b>${this._esc(p.name)}</b>${p.sub ? `<small>${this._esc(p.sub)}</small>` : ''}</span>`;
            b.addEventListener('click', () => this._choose(p));
            box.appendChild(b);
        });
    },
    async _choose(p) {
        this._recipient = { id: p.id, name: p.name };
        this._closeMenu(); const rb = this._$('recipientResults'); if (rb) rb.innerHTML = '';
        const q = this._$('recipientSearch'); if (q) q.value = '';
        this._paint();
        this._hint('Checking that ' + p.name + ' can receive…');
        const ok = await window.GhostE2E.canSealTo(p.id);
        if (!this._recipient || this._recipient.id !== p.id) return;
        this._hint(ok ? p.name + ' is ready to receive.' : p.name + ' has not set up secure messages yet. Ask them to open GhostChat chat once, or use "With a key".', ok ? 'ok' : 'bad');
        this._recipient.ready = ok;
    },
    async _myId() {
        try { const u = JSON.parse(localStorage.getItem('ghostchat_user') || 'null'); if (u && u.id) return String(u.id); } catch (_) {}
        const d = await window.GhostChatAPI._get('/api/auth/me'); return String(d.user.id);
    },

    async _encrypt() {
        const plaintext = (this._$('plaintext')?.value || '').trim();
        if (!plaintext) { this._showError('Please enter a message to encrypt'); return; }

        let password = '', keyShown = '';
        if (this._mode === 'user') {
            if (!this._recipient) { this._showError('Search for the person you are sending to, and pick them from the list.'); return; }
        } else if (this._keyChoice === 'generate') {
            password = keyShown = this._genKey;
            if (!password) { this._showError('Could not make a key in this browser. Choose "I\'ll type my own key".'); return; }
        } else {
            password = (this._$('encryptPassword')?.value || '').trim();
            if (!password)  { this._showError('Please enter an encryption key'); return; }
            if (password.length < 8) { this._showError('Use a key of at least 8 characters. A short key can be guessed.'); return; }
        }

        this._setLoading(true);

        try {
            let result;
            try {
                if (this._mode === 'user') {
                    window.GhostE2E.bindUser(await this._myId());
                    result = { success: true, algorithm: 'AES-256-GCM · locked to ' + this._recipient.name, emoji_message: await window.GhostE2E.sealTo(this._recipient.id, plaintext), forUser: this._recipient.name };
                } else {
                    result = { success: true, algorithm: 'AES-256-GCM', emoji_message: await window.GhostE2E.pwEncrypt(plaintext, password), key: keyShown };
                }
            } catch (e) {
                result = { success: false, error: e.message === 'not_ready'
                    ? `${this._recipient?.name || 'That person'} has not set up secure messages yet. Ask them to open GhostChat chat once, or choose "With a key".`
                    : (e.message || 'Encryption failed') };
            }

            if (result.success) {
                this._lastPacket = result.emoji_message;
                this._showResult(result);
                this._showExport(true);
                if (result.key) this._newKey();       // the next message gets a different key
                if (window.UI?.playSound) window.UI.playSound('success');
                window.dispatchEvent(new CustomEvent('ghostchat:encrypt', { detail: { length: plaintext.length } }));

                if (window.HistoryModule?.addMessage) {
                    window.HistoryModule.addMessage(
                        plaintext,
                        result.emoji_message,
                        'encryption'
                    );
                }
            } else {
                this._showError(result.error || 'Encryption failed');
                this._showExport(false);
                if (window.UI?.playSound) window.UI.playSound('error');
                window.dispatchEvent(new CustomEvent('ghostchat:error', { detail: { message: result.error || 'Encryption failed' } }));
            }
        } catch (err) {
            const msg = err?.isNetworkError ? 'You appear to be offline. Please check your connection.' : `Encryption failed: ${err.message}`;
            this._showError(msg);
            this._showExport(false);
            if (window.UI?.playSound) window.UI.playSound('error');
            window.dispatchEvent(new CustomEvent('ghostchat:error', { detail: { message: msg } }));
        } finally {
            this._setLoading(false);
        }
    },

    _showResult(result) {
        const div = this._$('encryptResult');
        if (!div) return;
        const count = Array.from(result.emoji_message || '').length;
        const sub = result.forUser
            ? `Locked to <b>${this._esc(result.forUser)}</b>. Only their account can open it.`
            : 'Protected by your key. Anyone who has the packet and the key can read it.';
        const key = result.key ? `
            <div class="gc-keyresult">
                <div class="gc-keyresult-t"><i class="fas fa-key"></i> Send this key separately</div>
                <p>Use a call, SMS or another app. Not the same chat as the packet.</p>
                <code>${this._esc(result.key)}</code>
                <button type="button" class="btn btn-ghost btn-sm" id="resKeyCopy"><i class="fas fa-copy"></i> Copy key</button>
            </div>` : '';
        const foot = result.forUser
            ? 'You cannot reopen this packet yourself. It stays in your History as the original text.'
            : 'Copy the whole packet. Every emoji matters.';
        div.innerHTML = `
            <section class="gc-result" aria-live="polite">
                <header class="gc-result-head">
                    <span class="gc-result-ic"><i class="fas fa-check"></i></span>
                    <div><b>Encrypted</b><small>${sub}</small></div>
                </header>
                <div id="encPacketText" class="gc-packet" tabindex="0" aria-label="Encrypted packet">${this._esc(result.emoji_message || '')}</div>
                <div class="gc-result-bar">
                    <button type="button" class="btn btn-primary btn-sm" id="resPacketCopy"><i class="fas fa-copy"></i> Copy packet</button>
                    <span class="gc-count">${count} emoji · ${this._esc(result.algorithm || 'AES-256-GCM')} · done in your browser</span>
                </div>
                ${key}
                <p class="gc-result-note">${foot}</p>
            </section>`;
        this._$('resPacketCopy')?.addEventListener('click', () => this._copyPacket());
        this._$('resKeyCopy')?.addEventListener('click', () => this._copyText(result.key, 'Key copied'));
    },

    _showExport(show) {
        const sec = document.getElementById('exportSection');
        if (sec) sec.style.display = show ? 'block' : 'none';
    },

    _clearResult() {
        const div = document.getElementById('encryptResult');
        if (div) div.innerHTML = '';
        this._showExport(false);
        this._lastPacket = null;
    },

    _setLoading(on) {
        const btn = document.getElementById('encryptBtn');
        if (!btn) return;
        btn.disabled = on;
        btn.innerHTML = on
            ? '<i class="fas fa-spinner fa-spin"></i> Encrypting…'
            : '<i class="fas fa-ghost"></i> Encrypt &amp; Obfuscate';
    },

    _showError(msg) {
        const div = document.getElementById('encryptResult');
        if (div) div.innerHTML = `
            <div style="color:var(--red);padding:14px;background:rgba(255,59,92,.08);
                        border:1px solid rgba(255,59,92,.2);border-radius:var(--r2);margin-top:16px;
                        font-size:.875rem;">
                <i class="fas fa-exclamation-triangle"></i>
                <span style="margin-left:8px;">${this._esc(msg)}</span>
            </div>`;
    },

    // ── Export helpers ────────────────────────────────────────────────────────

    _copyPacket() {
        if (!this._lastPacket) return;
        if (window.secureCopy) window.secureCopy(this._lastPacket);
        else navigator.clipboard.writeText(this._lastPacket)
            .then(() => { if (window.UI) UI.showToast('Copied!', 'success'); });
    },

    async _exportWhatsApp() {
        if (!this._lastPacket) return;
        const r = await GhostShare.ask({ title: 'Send on WhatsApp', label: 'Phone number with country code (e.g. +233…)', placeholder: '+233…', message: this._lastPacket });
        if (r) GhostShare.whatsapp(r.target, r.message);
    },

    async _exportTelegram() {
        if (!this._lastPacket) return;
        const r = await GhostShare.ask({ title: 'Send on Telegram', label: 'Telegram username (without @)', message: this._lastPacket });
        if (r) GhostShare.telegram(r.target, r.message);
    },

    _exportDiscord() {
        if (!this._lastPacket) return;
        this._copyPacket();
        if (window.UI) UI.showToast('Copied! Paste it in Discord.', 'success');
    },

    async _exportEmail() {
        if (!this._lastPacket) return;
        const r = await GhostShare.ask({ title: 'Send by email', label: 'Recipient email address', message: this._lastPacket });
        if (r) GhostShare.email(r.target, r.message);
    },

    async _exportSMS() {
        if (!this._lastPacket) return;
        const r = await GhostShare.ask({ title: 'Send by SMS', label: 'Phone number', message: this._lastPacket });
        if (r) GhostShare.sms(r.target, r.message);
    },

    _saveFile() {
        if (!this._lastPacket) return;
        const blob = new Blob([this._lastPacket], { type: 'text/plain' });
        const url  = URL.createObjectURL(blob);
        const a    = document.createElement('a');
        a.href     = url;
        a.download = `ghostchat_encrypted_${Date.now()}.txt`;
        a.click();
        URL.revokeObjectURL(url);
        if (window.UI) UI.showToast('Saved to file!', 'success');
    },

    _esc(str) {
        const d = document.createElement('div');
        d.textContent = String(str);
        return d.innerHTML;
    },
};
