/**
 * GHOSTCHAT DECRYPTION MODULE  v3.2
 * New packets (AES-256-GCM) are opened in the browser with GhostE2E.pwDecrypt.
 * Older packets (made by the previous server-side tool) still open through /api/decrypt.
 *
 * FIX: same issue as encrypt.js — never dispatched the `ghostchat:decrypt` /
 * `ghostchat:error` events dashboard.js listens for, so notifications/sound
 * never fired on a real decrypt action.
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

        const ct = document.getElementById('ciphertext');
        if (ct) {
            ct.addEventListener('paste', () => setTimeout(() => this._detect(true), 0));
            ct.addEventListener('input', () => this._detect(false));
        }
        document.getElementById('decryptPassword')?.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); this._decrypt(); } });
        this._lastAuto = '';

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
                this._detect(true);
            }
        };
        reader.readAsText(file);
    },

    // What did the person paste? Show the right fields, and open "for you" messages straight away.
    _detect(auto) {
        const val = (document.getElementById('ciphertext')?.value || '').trim();
        const box = document.getElementById('decryptDetect'), row = document.getElementById('decryptPwRow');
        const kind = val ? (window.GhostE2E?.packetKind?.(val) || 'unknown') : null;
        this._kind = kind;
        const say = (t, ok) => { if (box) { box.textContent = t; box.className = 'gc-detect' + (ok ? ' ok' : ''); } };
        if (!val) { say(''); if (row) row.hidden = false; this._lastAuto = ''; return; }
        if (kind === 'seal') {
            if (row) row.hidden = true;
            say('Locked to a GhostChat account: no key needed. Opening…', true);
            if (auto !== false && val !== this._lastAuto) { this._lastAuto = val; clearTimeout(this._autoT); this._autoT = setTimeout(() => this._decrypt(), 150); }
        } else if (kind === 'password' || kind === 'legacy') {
            if (row) row.hidden = false;
            say('This message needs the key you were given. Type it below and press Enter.', false);
            if (auto) document.getElementById('decryptPassword')?.focus();
        } else if (kind === 'chat') {
            if (row) row.hidden = true;
            say('This is a message from a GhostChat chat. It opens inside that chat automatically.', false);
        } else {
            if (row) row.hidden = false;
            say('This does not look like a GhostChat message yet. Paste the whole string of emojis.', false);
        }
    },

    async _unlockIfNeeded() {
        if (!window.GhostE2E?.isLocked?.()) return true;
        const pass = window.prompt('Your secure messages are locked.\nEnter your recovery passphrase to unlock them:');
        if (!pass) return false;
        try { await window.GhostE2E.unlock(pass); return true; }
        catch (e) { this._showError(this._esc(e.message || 'Could not unlock.')); return false; }
    },

    async _openSeal(packet) {
        try {
            const uid = await this._myId();
            window.GhostE2E.bindUser(uid);
            if (!(await this._unlockIfNeeded())) return { success: false, error: 'Unlock your secure messages to open this.', quiet: true };
            return { success: true, decrypted_message: await window.GhostE2E.openSeal(packet), algorithm: 'AES-256-GCM · locked to your account' };
        } catch (e) {
            const m = e.message;
            return { success: false, error:
                m === 'not_for_you' ? 'This message was locked for a different account. Sign in as the person it was sent to, on the device where they set up secure messages.' :
                m === 'no_keys' ? 'Your secure-message keys are not on this device. Open Settings → Message encryption to restore them, then paste again.' :
                m === 'locked' ? 'Your secure messages are locked. Unlock them and paste again.' :
                'This packet looks damaged. Copy the complete message again.' };
        }
    },
    async _myId() {
        try { const u = JSON.parse(localStorage.getItem('ghostchat_user') || 'null'); if (u && u.id) return String(u.id); } catch (_) {}
        const d = await window.GhostChatAPI._get('/api/auth/me'); return String(d.user.id);
    },

    async _decrypt() {
        if (this._busy) return;
        let packet = (document.getElementById('ciphertext')?.value || '').trim();
        const original = packet;   // the emoji form, kept for History
        if (window.GhostE2E?.unwrap) packet = window.GhostE2E.unwrap(packet);
        const password = (document.getElementById('decryptPassword')?.value  || '').trim();

        if (!packet) {
            this._showError(
                'Please paste the encrypted packet.<br>' +
                '<small>It looks like a long string of emojis: 🌙🎯🔮💫🎭…</small>'
            );
            return;
        }
        const seal = !!window.GhostE2E?.isSeal?.(packet);
        const isNew = !!window.GhostE2E?.isPw?.(packet);
        if (!seal && !password) {
            this._showError('Please enter the key you were given');
            return;
        }
        if (!seal && !isNew && !packet.includes('GHOST')) {
            this._showError(
                'This does not look like a GhostChat message. Make sure you pasted the <strong>complete</strong> ' +
                'string of emojis.'
            );
            return;
        }

        this._busy = true;
        this._setLoading(true);

        try {
            let result;
            if (seal) {
                result = await this._openSeal(packet);
                if (result.quiet) { this._busy = false; this._setLoading(false); return; }
            } else if (isNew) {
                const tryKeys = [password];
                const norm = window.GhostE2E.normalizeGeneratedKey?.(password);
                if (norm && norm !== password) tryKeys.push(norm);        // typed in lower case or without dashes
                result = null;
                for (const k of tryKeys) {
                    try { result = { success: true, decrypted_message: await window.GhostE2E.pwDecrypt(packet, k), algorithm: 'AES-256-GCM' }; break; }
                    catch (e) {
                        result = { success: false, error: e.message === 'wrong_password'
                            ? 'Wrong key, or the message was changed after it was encrypted.'
                            : 'This packet looks damaged. Copy the complete message again.' };
                        if (e.message !== 'wrong_password') break;
                    }
                }
            } else {
                result = await window.GhostChatAPI.decryptSimple(packet, password);
                if (result.success) result.algorithm = 'AES-256-CBC (older message)';
            }

            if (result.success) {
                this._showResult(result.decrypted_message, result.algorithm);
                if (window.UI) UI.showToast('Message decrypted!', 'success');
                if (window.UI?.playSound) window.UI.playSound('success');
                window.dispatchEvent(new CustomEvent('ghostchat:decrypt', {}));

                if (window.HistoryModule?.addMessage) {
                    window.HistoryModule.addMessage(
                        result.decrypted_message,
                        original,
                        'decryption'
                    );
                }
            } else {
                const msg = result.error || 'Decryption failed — check your key and packet.';
                this._showError(msg);
                if (window.UI?.playSound) window.UI.playSound('error');
                window.dispatchEvent(new CustomEvent('ghostchat:error', { detail: { message: msg } }));
            }
        } catch (err) {
            const msg = err?.isNetworkError ? 'You appear to be offline. Please check your connection.' : `Decryption failed: ${err.message}`;
            this._showError(msg);
            if (window.UI?.playSound) window.UI.playSound('error');
            window.dispatchEvent(new CustomEvent('ghostchat:error', { detail: { message: msg } }));
        } finally {
            this._busy = false;
            this._setLoading(false);
        }
    },

    _showResult(plaintext, algorithm) {
        const div = document.getElementById('decryptResult');
        if (!div) return;
        div.innerHTML = `
            <div style="margin-top:20px;padding:16px;
                        background:rgba(0,255,136,0.07);
                        border:1px solid rgba(0,255,136,0.2);
                        border-radius:var(--r2);">
                <p style="font-family:var(--mono);font-size:.75rem;
                           color:var(--green);margin-bottom:12px;">
                    ✓ DECRYPTION SUCCESSFUL — ${this._esc(algorithm || 'AES-256')}
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
        this._lastAuto = ''; this._detect(false);
    },

    _esc(str) {
        const d = document.createElement('div');
        d.textContent = String(str || '');
        return d.innerHTML;
    },
};
