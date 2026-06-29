/**
 * GHOSTCHAT HISTORY MODULE  v3.2
 * Loads from server DB first, falls back to localStorage.
 * FIXED: Stores and displays FULL encrypted message.
 */

window.HistoryModule = {
    messages: [],

    async load() {
        await this._loadMessages();
        this._setupListeners();
        this._updateBadge();
    },

    // ── Load ─────────────────────────────────────────────────────────────────

    async _loadMessages() {
        // Try server first
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

        // localStorage fallback
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
        // FIXED: Store the FULL encrypted message
        const fullEncrypted = encrypted || '';
        
        const item = {
            id:                String(Date.now()),
            encrypted_content: fullEncrypted,   // FULL encrypted message
            emoji_content:     fullEncrypted,   // FULL encrypted message
            plaintext_preview: plaintext        ? plaintext.substring(0, 80) : '',
            plaintext_full:    plaintext        || '',
            message_type:      type,
            created_at:        new Date().toISOString(),
        };

        this.messages.unshift(item);
        if (this.messages.length > 100) this.messages.pop();
        this._saveLocal();

        // Persist to server (non-blocking)
        try {
            await window.GhostChatAPI.saveMessage({
                encrypted_content: item.encrypted_content,
                emoji_content:     item.emoji_content,
                message_type:      item.message_type,
            });
        } catch (_) {}

        this.render();
        this._updateBadge();

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

            // FIXED: Show the FULL encrypted message for copying
            const fullEncrypted = msg.encrypted_content || msg.emoji_content || '';
            const fullEncryptedEscaped = this._esc(fullEncrypted);
            
            // Preview for display (truncated)
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
                    <button class="btn-copy-small" title="Copy FULL encrypted message"
                        onclick="HistoryModule._copyFull('${fullEncryptedEscaped.replace(/'/g, "\\'")}')">
                        <i class="fas fa-copy"></i> Copy Full
                    </button>` : ''}
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
        this._updateBadge();

        try { await window.GhostChatAPI.deleteMessage(id); } catch (_) {}

        if (window.UI) UI.showToast('Message deleted', 'info');
    },

    clearAll() {
        if (!confirm('Clear ALL message history? This cannot be undone.')) return;
        this.messages = [];
        this._saveLocal();
        this.render();
        this._updateBadge();

        if (window.UI) UI.showToast('History cleared', 'info');
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
                    this._updateBadge();
                    if (window.UI) UI.showToast(`Imported ${imported.length} messages`, 'success');
                } catch (_) {
                    if (window.UI) UI.showToast('Invalid history file', 'error');
                }
            };
            reader.readAsText(file);
        };
        input.click();
    },

    // FIXED: New method to copy FULL encrypted message
    _copyFull(text) {
        if (window.secureCopy) {
            window.secureCopy(text);
        } else {
            navigator.clipboard.writeText(text)
                .then(() => { if (window.UI) UI.showToast('Full encrypted message copied!', 'success'); })
                .catch(() => {
                    // Fallback
                    const ta = document.createElement('textarea');
                    ta.value = text;
                    document.body.appendChild(ta);
                    ta.select();
                    document.execCommand('copy');
                    ta.remove();
                    if (window.UI) UI.showToast('Full encrypted message copied!', 'success');
                });
        }
    },

    // ── Badge + listeners ─────────────────────────────────────────────────────

    _updateBadge() {
        const count = this.messages.length;
        const badge = document.getElementById('notificationCount');
        if (badge) {
            badge.textContent   = count > 99 ? '99+' : count;
            badge.style.display = count > 0 ? '' : 'none';
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
};/**
 * GHOSTCHAT HISTORY MODULE  v3.2
 * Loads from server DB first, falls back to localStorage.
 * FIXED: Stores and displays FULL encrypted message.
 */

window.HistoryModule = {
    messages: [],

    async load() {
        await this._loadMessages();
        this._setupListeners();
        this._updateBadge();
    },

    // ── Load ─────────────────────────────────────────────────────────────────

    async _loadMessages() {
        // Try server first
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

        // localStorage fallback
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
        // FIXED: Store the FULL encrypted message
        const fullEncrypted = encrypted || '';
        
        const item = {
            id:                String(Date.now()),
            encrypted_content: fullEncrypted,   // FULL encrypted message
            emoji_content:     fullEncrypted,   // FULL encrypted message
            plaintext_preview: plaintext        ? plaintext.substring(0, 80) : '',
            plaintext_full:    plaintext        || '',
            message_type:      type,
            created_at:        new Date().toISOString(),
        };

        this.messages.unshift(item);
        if (this.messages.length > 100) this.messages.pop();
        this._saveLocal();

        // Persist to server (non-blocking)
        try {
            await window.GhostChatAPI.saveMessage({
                encrypted_content: item.encrypted_content,
                emoji_content:     item.emoji_content,
                message_type:      item.message_type,
            });
        } catch (_) {}

        this.render();
        this._updateBadge();

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

            // FIXED: Show the FULL encrypted message for copying
            const fullEncrypted = msg.encrypted_content || msg.emoji_content || '';
            const fullEncryptedEscaped = this._esc(fullEncrypted);
            
            // Preview for display (truncated)
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
                    <button class="btn-copy-small" title="Copy FULL encrypted message"
                        onclick="HistoryModule._copyFull('${fullEncryptedEscaped.replace(/'/g, "\\'")}')">
                        <i class="fas fa-copy"></i> Copy Full
                    </button>` : ''}
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
        this._updateBadge();

        try { await window.GhostChatAPI.deleteMessage(id); } catch (_) {}

        if (window.UI) UI.showToast('Message deleted', 'info');
    },

    clearAll() {
        if (!confirm('Clear ALL message history? This cannot be undone.')) return;
        this.messages = [];
        this._saveLocal();
        this.render();
        this._updateBadge();

        if (window.UI) UI.showToast('History cleared', 'info');
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
                    this._updateBadge();
                    if (window.UI) UI.showToast(`Imported ${imported.length} messages`, 'success');
                } catch (_) {
                    if (window.UI) UI.showToast('Invalid history file', 'error');
                }
            };
            reader.readAsText(file);
        };
        input.click();
    },

    // FIXED: New method to copy FULL encrypted message
    _copyFull(text) {
        if (window.secureCopy) {
            window.secureCopy(text);
        } else {
            navigator.clipboard.writeText(text)
                .then(() => { if (window.UI) UI.showToast('Full encrypted message copied!', 'success'); })
                .catch(() => {
                    // Fallback
                    const ta = document.createElement('textarea');
                    ta.value = text;
                    document.body.appendChild(ta);
                    ta.select();
                    document.execCommand('copy');
                    ta.remove();
                    if (window.UI) UI.showToast('Full encrypted message copied!', 'success');
                });
        }
    },

    // ── Badge + listeners ─────────────────────────────────────────────────────

    _updateBadge() {
        const count = this.messages.length;
        const badge = document.getElementById('notificationCount');
        if (badge) {
            badge.textContent   = count > 99 ? '99+' : count;
            badge.style.display = count > 0 ? '' : 'none';
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