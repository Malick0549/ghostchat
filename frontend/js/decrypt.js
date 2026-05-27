/**
 * GHOSTCHAT DECRYPTION MODULE  v3.1
 * Calls /api/decrypt (password-based AES-256 + emoji packet).
 * All crypto happens server-side.
 *
 * INPUT FORMAT:
 *   Paste the FULL packet produced by encrypt — the string that looks like:
 *   "😀😃😉...GOSTiv_base64GOSTsalt_base64"
 *   The packet is self-contained — no separate IV/metadata needed.
 */

window.DecryptionModule = {

    init() {
        this._wire();
    },

    _wire() {
        const btn = document.getElementById('decryptBtn');
        if (btn) {
            const fresh = btn.cloneNode(true);
            btn.parentNode.replaceChild(fresh, btn);
            fresh.addEventListener('click', () => this._decrypt());
        }

        const importBtn = document.getElementById('importBtn');
        if (importBtn) {
            const fresh = importBtn.cloneNode(true);
            importBtn.parentNode.replaceChild(fresh, importBtn);
            fresh.addEventListener('click', () => this._importFile());
        }

        const importFile = document.getElementById('importFile');
        if (importFile) {
            importFile.addEventListener('change', e => this._handleFile(e));
        }

        const clearBtn = document.getElementById('decClear');
        if (clearBtn) {
            clearBtn.addEventListener('click', () => this._clear());
        }
    },

    _importFile() {
        document.getElementById('importFile')?.click();
    },

    _handleFile(e) {
        const file = e.target.files?.[0];
        if (!file) return;
        const reader = new FileReader();
        reader.onload = ev => {
            const ta = document.getElementById('ciphertext');
            if (ta) {
                ta.value = (ev.target.result || '').trim();
                if (window.UI) UI.showToast('File imported', 'success');
            }
        };
        reader.readAsText(file);
    },

    async _decrypt() {
        const packet   = (document.getElementById('ciphertext')?.value       || '').trim();
        const password = (document.getElementById('decryptPassword')?.value  || '').trim();

        if (!packet) {
            this._showError(
                'Please paste the encrypted packet.<br>' +
                '<small>It should look like: 😀😃😉…GOSTabc…GOSTdef…</small>'
            );
            return;
        }
        if (!password) {
            this._showError('Please enter the decryption password');
            return;
        }

        // Quick sanity check — packets must contain the GHOST separator
        if (!packet.includes('GHOST')) {
            this._showError(
                'Invalid packet format — make sure you pasted the <strong>complete</strong> ' +
                'encrypted output including the GHOST separator parts.'
            );
            return;
        }

        this._setLoading(true);

        try {
            const result = await window.GhostChatAPI.decryptSimple(packet, password);

            if (result.success) {
                this._showResult(result.decrypted_message);
                if (window.UI) UI.showToast('Message decrypted!', 'success');

                // Save to history
                if (window.HistoryModule?.addMessage) {
                    window.HistoryModule.addMessage(
                        result.decrypted_message,
                        packet,
                        'decryption'
                    );
                }
            } else {
                this._showError(
                    result.error || 'Decryption failed — check your password and packet.'
                );
            }
        } catch (err) {
            this._showError(`Decryption failed: ${err.message}`);
        } finally {
            this._setLoading(false);
        }
    },

    _showResult(plaintext) {
        const div = document.getElementById('decryptResult');
        if (!div) return;
        div.innerHTML = `
            <div style="margin-top:20px;padding:16px;
                        background:rgba(0,255,136,0.07);
                        border:1px solid rgba(0,255,136,0.2);
                        border-radius:var(--r2);">
                <p style="font-family:var(--mono);font-size:.75rem;
                           color:var(--green);margin-bottom:12px;">
                    ✓ DECRYPTION SUCCESSFUL — AES-256-CBC
                </p>
                <label style="font-family:var(--mono);font-size:.7rem;
                              letter-spacing:.1em;text-transform:uppercase;
                              color:var(--t2);display:block;margin-bottom:8px;">
                    Original Message
                </label>
                <div style="background:rgba(0,0,0,.35);border:1px solid var(--border);
                            border-radius:var(--r2);padding:14px;
                            font-size:.9rem;line-height:1.7;color:var(--t1);
                            white-space:pre-wrap;word-break:break-word;
                            max-height:300px;overflow-y:auto;">
                    ${this._esc(plaintext)}
                </div>
                <button onclick="HistoryModule._copyItem('${this._esc(plaintext).replace(/'/g,"\\'")}');"
                    class="btn btn-ghost btn-sm" style="margin-top:10px;">
                    <i class="fas fa-copy"></i> Copy plaintext
                </button>
            </div>`;
    },

    _showError(html) {
        const div = document.getElementById('decryptResult');
        if (!div) return;
        div.innerHTML = `
            <div style="color:var(--red);padding:14px;
                        background:rgba(255,59,92,.08);
                        border:1px solid rgba(255,59,92,.2);
                        border-radius:var(--r2);margin-top:16px;
                        font-size:.875rem;line-height:1.6;">
                <i class="fas fa-exclamation-triangle"></i>
                <span style="margin-left:8px;">${html}</span>
            </div>`;
    },

    _setLoading(on) {
        const btn = document.getElementById('decryptBtn');
        if (!btn) return;
        btn.disabled  = on;
        btn.innerHTML = on
            ? '<i class="fas fa-spinner fa-spin"></i> Decrypting…'
            : '<i class="fas fa-ghost"></i> Decrypt Message';
    },

    _clear() {
        const ct = document.getElementById('ciphertext');
        const pw = document.getElementById('decryptPassword');
        const rs = document.getElementById('decryptResult');
        if (ct) ct.value = '';
        if (pw) pw.value = '';
        if (rs) rs.innerHTML = '';
    },

    _esc(str) {
        const d = document.createElement('div');
        d.textContent = String(str || '');
        return d.innerHTML;
    },
};