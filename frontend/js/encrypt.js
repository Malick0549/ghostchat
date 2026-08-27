/**
 * GHOSTCHAT ENCRYPTION MODULE  v3.2
 * Calls /api/encrypt (password-based AES-256 + emoji packet).
 * All crypto happens server-side — this module only handles UI.
 *
 * FIX: this module never dispatched the `ghostchat:encrypt` / `ghostchat:error`
 * window events that dashboard.js listens for — meaning the notification
 * badge, sound effects, and activity-log write triggered by those events
 * never actually fired on a real encrypt action. Dispatching them here is
 * what makes dashboard.js's notification system actually turn on.
 */

window.EncryptionModule = {
    _lastPacket: null,
    _showFullCipher: false,   // display-only toggle — never affects what gets copied/exported

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
        this._showFullCipher = false;   // always start clean on a fresh encryption
        this._renderResultBody(result.algorithm);
    },

    // ── Separated from _showResult so the "Show full cipher" toggle can
    // re-render just the display without re-encrypting anything. The full
    // packet in this._lastPacket is read here but never reassigned — this
    // function only ever changes what's shown, never what's stored. ──
    _renderResultBody(algorithm) {
        const div = document.getElementById('encryptResult');
        if (!div || !this._lastPacket) return;

        // The packet format is: emoji + "GHOST" + iv_b64 + "GHOST" + salt_b64
        // Splitting on the separator to isolate just the emoji portion is a
        // read-only operation — this._lastPacket itself is untouched, so
        // every export/copy function still has the exact complete packet.
        const emojiOnly = this._lastPacket.split('GHOST')[0];
        const displayText = this._showFullCipher ? this._lastPacket : emojiOnly;

        div.innerHTML = `
            <div style="margin-top:20px;padding:16px;background:rgba(0,255,136,0.07);
                        border:1px solid rgba(0,255,136,0.2);border-radius:var(--r2);">
                <p style="font-family:var(--mono);font-size:.75rem;color:var(--green);margin-bottom:12px;">
                    ✓ ENCRYPTION COMPLETE — ${algorithm || 'AES-256-CBC'} + EMOJI OBFUSCATION
                </p>
                <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:8px;">
                    <label style="font-family:var(--mono);font-size:.7rem;letter-spacing:.1em;
                                  text-transform:uppercase;color:var(--t2);">
                        ${this._showFullCipher ? 'Full Encrypted Packet' : 'Encrypted Message'}
                    </label>
                    <button type="button" id="toggleCipherViewBtn"
                            class="btn btn-ghost btn-sm" style="font-size:.7rem;padding:4px 10px;">
                        <i class="fas fa-${this._showFullCipher ? 'eye-slash' : 'code'}"></i>
                        ${this._showFullCipher ? 'Show emoji only' : 'Show full cipher'}
                    </button>
                </div>
                <div style="background:rgba(0,0,0,.35);border:1px solid var(--border);
                            border-radius:var(--r2);padding:14px;word-break:break-all;
                            font-family:var(--mono);font-size:.75rem;line-height:1.7;
                            color:var(--t1);max-height:180px;overflow-y:auto;">
                    ${this._esc(displayText)}
                </div>
                <p style="font-size:.75rem;color:var(--t3);margin-top:8px;">
                    <i class="fas fa-info-circle"></i>
                    ${this._showFullCipher
                        ? 'This is the complete packet, including the hidden decryption data. Copy/Export always use this full version.'
                        : 'Copy and Export always include the complete data needed to decrypt this message — even though only the emoji are shown here.'}
                </p>
            </div>
        `;

        document.getElementById('toggleCipherViewBtn')?.addEventListener('click', () => {
            this._showFullCipher = !this._showFullCipher;
            this._renderResultBody(algorithm);
        });
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
        this._showFullCipher = false;
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
            const cleanPhone = phone.replace(/\D/g, '');
            const message = this._lastPacket;
            const encodedMessage = encodeURIComponent(message);
            const url = `https://api.whatsapp.com/send?phone=${cleanPhone}&text=${encodedMessage}`;

            try {
                const win = window.open(url, '_blank');
                if (!win) {
                    navigator.clipboard.writeText(message)
                        .then(() => {
                            if (window.UI) UI.showToast('Message copied! Open WhatsApp and paste it.', 'success');
                            window.open(`https://wa.me/${cleanPhone}`, '_blank');
                        })
                        .catch(() => {
                            if (window.UI) UI.showToast('Please copy the message manually.', 'info');
                        });
                } else {
                    if (window.UI) UI.showToast('Opening WhatsApp...', 'success');
                }
            } catch (err) {
                navigator.clipboard.writeText(message)
                    .then(() => {
                        if (window.UI) UI.showToast('Message copied! Open WhatsApp and paste it.', 'success');
                        window.open(`https://wa.me/${cleanPhone}`, '_blank');
                    })
                    .catch(() => {
                        if (window.UI) UI.showToast('Could not open WhatsApp. Please copy the message manually.', 'info');
                    });
            }
        }
    },

    _exportTelegram() {
        if (!this._lastPacket) return;
        const user = prompt('Telegram username (without @):');
        if (user) {
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