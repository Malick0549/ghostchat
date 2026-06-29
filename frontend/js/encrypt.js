/**
 * GHOSTCHAT ENCRYPTION MODULE  v3.1
 * Calls /api/encrypt (password-based AES-256 + emoji packet).
 * All crypto happens server-side — this module only handles UI.
 */

window.EncryptionModule = {
    _lastPacket: null,

    init() {
        this._wire();
    },

    _wire() {
        const btn = document.getElementById('encryptBtn');
        if (btn) {
            const fresh = btn.cloneNode(true);
            btn.parentNode.replaceChild(fresh, btn);
            fresh.addEventListener('click', () => this._encrypt());
        }

        const plain = document.getElementById('plaintext');
        if (plain) plain.addEventListener('input', () => this._clearResult());

        // Export buttons
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

    async _encrypt() {
        const plaintext = (document.getElementById('plaintext')?.value || '').trim();
        const password  = (document.getElementById('encryptPassword')?.value || '').trim();
        const useDecoys = document.getElementById('useDecoys')?.checked || false;

        if (!plaintext) { this._showError('Please enter a message to encrypt'); return; }
        if (!password)  { this._showError('Please enter an encryption password'); return; }

        this._setLoading(true);

        try {
            const result = await window.GhostChatAPI.encryptSimple(plaintext, password, useDecoys);

            if (result.success) {
                this._lastPacket = result.emoji_message;
                this._showResult(result);
                this._showExport(true);
                if (window.UI) UI.showToast('Message encrypted successfully!', 'success');

                // Save to history — store plaintext preview + full packet
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
            }
        } catch (err) {
            this._showError(`Encryption failed: ${err.message}`);
            this._showExport(false);
        } finally {
            this._setLoading(false);
        }
    },

    _showResult(result) {
        const div = document.getElementById('encryptResult');
        if (!div) return;
        div.innerHTML = `
            <div style="margin-top:20px;padding:16px;background:rgba(0,255,136,0.07);
                        border:1px solid rgba(0,255,136,0.2);border-radius:var(--r2);">
                <p style="font-family:var(--mono);font-size:.75rem;color:var(--green);margin-bottom:12px;">
                    ✓ ENCRYPTION COMPLETE — ${result.algorithm || 'AES-256-CBC'} + EMOJI OBFUSCATION
                </p>
                <label style="font-family:var(--mono);font-size:.7rem;letter-spacing:.1em;
                              text-transform:uppercase;color:var(--t2);display:block;margin-bottom:8px;">
                    Encrypted Packet (copy the entire string below)
                </label>
                <div style="background:rgba(0,0,0,.35);border:1px solid var(--border);
                            border-radius:var(--r2);padding:14px;word-break:break-all;
                            font-family:var(--mono);font-size:.75rem;line-height:1.7;
                            color:var(--t1);max-height:180px;overflow-y:auto;">
                    ${this._esc(result.emoji_message || '')}
                </div>
                <p style="font-size:.75rem;color:var(--t3);margin-top:8px;">
                    <i class="fas fa-info-circle"></i>
                    Copy the <strong>entire</strong> string above (including the GHOST separator)
                    and paste it into the Decrypt panel.
                </p>
            </div>
        `;
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

    _exportWhatsApp() {
        if (!this._lastPacket) return;
        const phone = prompt('WhatsApp phone number (with country code, e.g. +233…):');
        if (phone) {
            // FIXED: Use raw emoji string with proper encoding
            const message = this._lastPacket;
            const encodedMessage = encodeURIComponent(message);
            const url = `https://wa.me/${phone.replace(/\D/g,'')}?text=${encodedMessage}`;
            
            const win = window.open(url, '_blank');
            if (!win) {
                if (window.UI) UI.showToast('Please allow popups or copy the link manually', 'info');
            }
            if (window.UI) UI.showToast('Opening WhatsApp...', 'success');
        }
    },

    _exportTelegram() {
        if (!this._lastPacket) return;
        const user = prompt('Telegram username (without @):');
        if (user) {
            // FIXED: Use raw emoji string with proper encoding
            const message = this._lastPacket;
            const encodedMessage = encodeURIComponent(message);
            window.open(
                `https://t.me/${user.replace('@','')}?text=${encodedMessage}`,
                '_blank'
            );
        }
    },

    _exportDiscord() {
        if (!this._lastPacket) return;
        this._copyPacket();
        if (window.UI) UI.showToast('Copied! Paste it in Discord.', 'success');
    },

    _exportEmail() {
        if (!this._lastPacket) return;
        const email = prompt('Recipient email address:');
        if (email) {
            // FIXED: Use raw emoji string with proper encoding
            const message = this._lastPacket;
            window.location.href =
                `mailto:${email}?subject=${encodeURIComponent('Encrypted GhostChat Message')}`
                + `&body=${encodeURIComponent(message)}`;
        }
    },

    _exportSMS() {
        if (!this._lastPacket) return;
        const phone = prompt('Phone number:');
        if (phone) {
            // FIXED: Use raw emoji string with proper encoding
            const message = this._lastPacket;
            window.location.href =
                `sms:${phone}?body=${encodeURIComponent(message)}`;
        }
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