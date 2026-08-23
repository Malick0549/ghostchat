/**
 * GHOSTCHAT HISTORY MODULE  v3.3
 * Loads from server DB first, falls back to localStorage.
 * Stores and displays FULL encrypted message.
 *
 * FIX: this module used to overwrite #notificationCount with the total
 * message count every render — fighting with dashboard.js's actual unread
 * counter and contributing to the "badge won't stay cleared" bug. History's
 * badge concerns (message count) and Dashboard's notification concerns
 * (unread alerts) are different things that happened to share one DOM
 * element. dashboard.js now owns #notificationCount exclusively; this
 * module no longer touches it.
 */

window.HistoryModule = {
    messages: [],

    async load() {
        await this._loadMessages();
        this._setupListeners();
    },

    // ── Load ─────────────────────────────────────────────────────────────────

    async _loadMessages() {
        try {
            const d = await window.GhostChatAPI.getMessageHistory(100, 0);
            if (d.success && Array.isArray(d.messages)) {
                this.messages = d.messages;
                this._saveLocal();
                this.render();
                return;
            }
        } catch (_) {
            // fall through to localStorage
        }

        try {
            const saved = localStorage.getItem('ghostchat_message_history');
            this.messages = saved ? JSON.parse(saved) : [];
        } catch (_) {
            this.messages = [];
        }
        this.render();
    },

    _saveLocal() {
        try {
            localStorage.setItem(
                'ghostchat_message_history',
                JSON.stringify(this.messages)
            );
        } catch (_) {}
    },

    // ── Add a new message (called from encrypt.js / decrypt.js) ──────────────

    async addMessage(plaintext, encrypted, type = 'encryption') {
        const fullEncrypted = encrypted || '';

        const item = {
            id:                String(Date.now()),
            encrypted_content: fullEncrypted,
            emoji_content:     fullEncrypted,
            plaintext_preview: plaintext        ? plaintext.substring(0, 80) : '',
            plaintext_full:    plaintext        || '',
            message_type:      type,
            created_at:        new Date().toISOString(),
        };

        this.messages.unshift(item);
        if (this.messages.length > 100) this.messages.pop();
        this._saveLocal();

        try {
            await window.GhostChatAPI.saveMessage({
                encrypted_content: item.encrypted_content,
                emoji_content:     item.emoji_content,
                message_type:      item.message_type,
            });
        } catch (_) {}

        this.render();

        if (window.UI) UI.showToast('Saved to history', 'success');
    },

    // ── Render ───────────────────────────────────────────────────────────────

    render(filterQuery = '') {
        const container = document.getElementById('historyList');
        if (!container) return;

        let items = this.messages;

        if (filterQuery) {
            const q = filterQuery.toLowerCase();
            items = items.filter(m =>
                (m.encrypted_content || m.emoji_content || '').toLowerCase().includes(q) ||
                (m.plaintext_preview || '').toLowerCase().includes(q)
            );
        }

        if (!items.length) {
            container.innerHTML = `
                <div class="empty-state">
                    <i class="fas fa-inbox"></i>
                    <p>${filterQuery ? 'No messages match your search.' : 'No messages yet.<br/>Encrypt your first message to see it here.'}</p>
                </div>`;
            return;
        }

        container.innerHTML = items.map(msg => {
            const isEnc    = (msg.message_type || 'encryption') === 'encryption';
            const typeLabel = isEnc ? 'ENCRYPTED' : 'DECRYPTED';
            const typeIcon  = isEnc ? 'fa-lock' : 'fa-lock-open';
            const typeCls   = isEnc ? 'encryption' : 'decryption';

            const when    = msg.created_at
                ? new Date(msg.created_at).toLocaleString([], {
                    month: 'short', day: 'numeric',
                    hour: '2-digit', minute: '2-digit',
                  })
                : '—';

            const fullEncrypted = msg.encrypted_content || msg.emoji_content || '';
            const fullEncryptedEscaped = this._esc(fullEncrypted);

            const preview = msg.plaintext_preview
                ? this._esc(msg.plaintext_preview) + (msg.plaintext_preview.length >= 80 ? '…' : '')
                : this._esc(fullEncrypted.substring(0, 60)) + (fullEncrypted.length > 60 ? '…' : '');

            return `
            <div class="history-item" role="listitem" tabindex="0"
                 aria-label="${typeLabel} message from ${when}">
                <div class="history-header">
                    <span class="history-type ${typeCls}">
                        <i class="fas ${typeIcon}" aria-hidden="true"></i>
                        ${typeLabel}
                    </span>
                    <span class="history-time">${when}</span>
                </div>
                <div class="history-content">
                    <span class="text-muted" style="font-size:.8rem;">${preview}</span>
                    ${fullEncrypted ? `
                    <div style="margin-top: 6px;">
                        <button class="btn-copy-small" title="Copy FULL encrypted message"
                            onclick="HistoryModule._copyFull('${fullEncryptedEscaped.replace(/'/g, "\\'")}')">
                            <i class="fas fa-copy"></i> Copy Full
                        </button>
                    </div>` : ''}
                </div>
                <button class="history-delete" title="Delete"
                    onclick="HistoryModule.deleteMessage('${msg.id}')"
                    aria-label="Delete this message">
                    <i class="fas fa-trash"></i>
                </button>
            </div>`;
        }).join('');
    },

    // ── Actions ──────────────────────────────────────────────────────────────

    async deleteMessage(id) {
        this.messages = this.messages.filter(m => String(m.id) !== String(id));
        this._saveLocal();
        this.render();

        try { await window.GhostChatAPI.deleteMessage(id); } catch (_) {}

        if (window.UI) UI.showToast('Message deleted', 'info');
    },

    // ── FIX: now calls the real backend bulk-clear endpoint (POST
    // /api/messages/clear) so the history is actually gone server-side too,
    // not just wiped from localStorage and silently repopulated from the
    // server on next load. ──
    async clearAll() {
        if (!confirm('Clear ALL message history? This cannot be undone.')) return;

        // FIX: this used to swallow any failure from the server call and
        // show "History cleared" regardless — so if the delete request
        // failed for any reason (auth hiccup, network issue, server
        // error), the user got a false success message, nothing was
        // actually deleted server-side, and the next page refresh
        // correctly re-synced from a server that still had everything —
        // which looked exactly like "clearing didn't work." Now this
        // only clears the local view and shows success once the server
        // has actually confirmed the delete, and shows a real error
        // (plus logs the real cause to the console) otherwise.
        try {
            const result = await window.GhostChatAPI.clearEncryptionHistory();
            if (!result || result.success !== true) {
                throw new Error(result?.error || 'Server did not confirm the history was cleared.');
            }
        } catch (err) {
            console.error('Clear history failed:', err);
            if (window.UI) {
                UI.showToast(
                    err?.isNetworkError
                        ? 'Could not clear history — you appear to be offline.'
                        : `Failed to clear history: ${err.message || 'unknown error'}`,
                    'error'
                );
            }
            return; // don't touch the local view — it still matches the (unchanged) server state
        }

        this.messages = [];
        this._saveLocal();
        this.render();

        if (window.UI) UI.showToast('History cleared', 'success');
    },

    exportHistory() {
        const data = JSON.stringify(this.messages, null, 2);
        const blob = new Blob([data], { type: 'application/json' });
        const url  = URL.createObjectURL(blob);
        const a    = document.createElement('a');
        a.href     = url;
        a.download = `ghostchat_history_${new Date().toISOString().slice(0,10)}.json`;
        a.click();
        URL.revokeObjectURL(url);
        if (window.UI) UI.showToast('History exported', 'success');
    },

    importMessages() {
        const input    = document.createElement('input');
        input.type     = 'file';
        input.accept   = '.json';
        input.onchange = e => {
            const file = e.target.files[0];
            if (!file) return;
            const reader = new FileReader();
            reader.onload = ev => {
                try {
                    const imported = JSON.parse(ev.target.result);
                    if (!Array.isArray(imported)) throw new Error('Not an array');
                    this.messages = [...imported, ...this.messages].slice(0, 100);
                    this._saveLocal();
                    this.render();
                    if (window.UI) UI.showToast(`Imported ${imported.length} messages`, 'success');
                } catch (_) {
                    if (window.UI) UI.showToast('Invalid history file', 'error');
                }
            };
            reader.readAsText(file);
        };
        input.click();
    },

    _copyFull(text) {
        if (!text) {
            if (window.UI) UI.showToast('No message to copy', 'error');
            return;
        }

        if (window.secureCopy) {
            window.secureCopy(text);
        } else {
            navigator.clipboard.writeText(text)
                .then(() => {
                    if (window.UI) UI.showToast('Full encrypted message copied!', 'success');
                })
                .catch(() => {
                    try {
                        const ta = document.createElement('textarea');
                        ta.value = text;
                        document.body.appendChild(ta);
                        ta.select();
                        document.execCommand('copy');
                        ta.remove();
                        if (window.UI) UI.showToast('Full encrypted message copied!', 'success');
                    } catch (e) {
                        if (window.UI) UI.showToast('Failed to copy. Please select and copy manually.', 'error');
                    }
                });
        }
    },

    _setupListeners() {
        const wire = (id, fn) => {
            const el = document.getElementById(id);
            if (!el) return;
            const fresh = el.cloneNode(true);
            el.parentNode.replaceChild(fresh, el);
            fresh.onclick = fn;
        };
        wire('exportHistoryBtn', () => this.exportHistory());
        wire('clearHistoryBtn',  () => this.clearAll());
        wire('importHistoryBtn', () => this.importMessages());
    },

    // ── Utility ───────────────────────────────────────────────────────────────

    _esc(str) {
        if (!str) return '';
        const d = document.createElement('div');
        d.textContent = String(str);
        return d.innerHTML;
    },
};