/**
 * GHOSTCHAT REAL-TIME CHAT  v2.1
 * WhatsApp-like private messaging with:
 *   - Real contacts loaded from database
 *   - Private per-user SocketIO rooms (server-authenticated)
 *   - Add contact by username search (with approval)
 *   - AES-256 message encryption (emoji format)
 *   - Online/offline presence
 *   - Typing indicators
 *   - Read receipts
 *   - Message history from DB
 *   - Keyboard shortcuts
 *   - Per-message action menu (tap ⋮ to reveal actions — keeps the thread clean)
 *   - Network-resilient fetch (retry + backoff) and offline send queue
 */

(function () {
    if (window.__ghostChatScriptLoaded) {
        console.warn('chat-socket.js loaded more than once — skipping re-init. ' +
                      'Check chat.html for a duplicate <script src="...chat-socket.js"> tag.');
        return;
    }
    window.__ghostChatScriptLoaded = true;

// ── Network resilience helpers ──────────────────────────────────────────────
// Retries transient failures (network drop, timeout, 5xx) with exponential
// backoff + jitter. Does NOT retry 4xx (auth/validation errors — retrying
// those just wastes time and can trigger rate limits). Designed for flaky
// mobile connections where a single dropped packet shouldn't fail a request
// outright.
async function resilientFetch(url, options = {}, { retries = 3, baseDelay = 600 } = {}) {
    let lastErr;
    for (let attempt = 0; attempt <= retries; attempt++) {
        try {
            const controller = new AbortController();
            const timeout = setTimeout(() => controller.abort(), 15000);
            const res = await fetch(url, { ...options, signal: controller.signal });
            clearTimeout(timeout);

            // Retry on server errors and rate limiting, not on client errors
            if (res.status >= 500 || res.status === 429) {
                throw new Error(`Server error ${res.status}`);
            }
            return res;
        } catch (err) {
            lastErr = err;
            if (attempt === retries) break;
            const delay = baseDelay * Math.pow(2, attempt) + Math.random() * 300;
            await new Promise(r => setTimeout(r, delay));
        }
    }
    throw lastErr;
}

class GhostChatRealtime {
    constructor() {
        this.socket          = null;
        this.connected       = false;
        this.currentContact  = null;
        this.contacts        = [];
        this.messages        = [];
        this.user            = null;
        this.typingTimer     = null;
        this.isTyping        = false;
        this.encryptMessages = true;
        this.password        = '';
        this.reconnectAttempts = 0;
        this.maxReconnectAttempts = 5;
        this._pendingIncoming = [];
        this.decryptData = {};
        this._plainData = {};
        this._msgViewState = {}; // 'plain' | 'encrypted'
        this._openMenuId = null; // which message's ⋮ menu is currently open
        this._sendQueue = [];    // messages queued while offline
        this._isOnline = navigator.onLine;

        this.init();
    }

    async init() {
        this._loadUser();
        await this._loadContacts();
        this._connectSocket();
        this._setupEventListeners();
        this._setupKeyboardShortcuts();
        this._setupMobile();
        this._setupNetworkMonitor();
        await this._loadPendingRequests();
    }

    // ── Network status monitor ──────────────────────────────────────────────
    _setupNetworkMonitor() {
        window.addEventListener('online', () => {
            this._isOnline = true;
            this._toast('Back online — syncing…', 'success');
            this._flushSendQueue();
            if (this.socket && !this.connected) this.socket.connect();
        });
        window.addEventListener('offline', () => {
            this._isOnline = false;
            this._toast('You are offline. Messages will send when reconnected.', 'info');
        });
    }

    async _flushSendQueue() {
        if (!this._sendQueue.length) return;
        const queue = [...this._sendQueue];
        this._sendQueue = [];
        for (const item of queue) {
            await this._deliverMessage(item.content, item.tempId, item.contactId);
        }
    }

    _loadUser() {
        try {
            this.user = JSON.parse(localStorage.getItem('ghostchat_user') || '{}');
            if (!this.user.id) {
                window.location.href = 'login.html';
                return;
            }
            const nameEl = document.getElementById('chatUserName');
            const avatarEl = document.getElementById('chatUserAvatar');
            if (nameEl) nameEl.textContent = this.user.username || 'Ghost User';
            if (avatarEl) {
                if (this.user.avatar && this.user.avatar !== '/assets/images/default-avatar.png') {
                    avatarEl.innerHTML = `<img src="${this.user.avatar}" alt="Avatar" onerror="this.outerHTML='<span>${(this.user.username||'G')[0].toUpperCase()}</span>';" />`;
                } else {
                    avatarEl.textContent = (this.user.username || 'G')[0].toUpperCase();
                }
            }
        } catch (_) {
            window.location.href = 'login.html';
        }
    }

    async _loadContacts() {
        try {
            const res = await resilientFetch(`${this._base()}/api/contacts`, {
                credentials: 'include',
                headers: { 'X-Requested-With': 'XMLHttpRequest' },
            });
            const data = await res.json();
            if (data.success) {
                this.contacts = data.contacts || [];
            }
        } catch (_) {
            this.contacts = [];
            if (!this._isOnline) {
                this._toast('Offline — showing cached contacts', 'info');
            }
        }
        this._renderContacts();
    }

    _renderContacts() {
        const list = document.getElementById('contactsList');
        if (!list) return;

        if (!this.contacts.length) {
            list.innerHTML = `
                <div style="padding:24px 16px;text-align:center;color:var(--t3);">
                    <i class="fas fa-user-plus" style="font-size:2rem;margin-bottom:12px;display:block;color:var(--primary);opacity:.5;"></i>
                    <p style="font-size:.875rem;">No contacts yet.</p>
                    <p style="font-size:.8125rem;margin-top:4px;">Press <strong>Alt+N</strong> or click <strong>+</strong> to add someone.</p>
                </div>`;
            return;
        }

        list.innerHTML = this.contacts.map(c => {
            const initials = (c.display_name || c.username || '?')[0].toUpperCase();
            const avatarHtml = c.avatar && c.avatar !== '/assets/images/default-avatar.png'
                ? `<img src="${c.avatar}" alt="${initials}" onerror="this.outerHTML='<span>${initials}</span>';" />`
                : `<span>${initials}</span>`;

            const lastMsg = c.last_message?.content ? this._truncate(c.last_message.content, 36) : 'Start a secure conversation';
            const lastTime = c.last_message?.created_at ? this._formatTime(c.last_message.created_at) : '';
            const unread = c.unread_count > 0 ? `<span class="contact-unread">${c.unread_count > 99 ? '99+' : c.unread_count}</span>` : '';
            const online = c.is_online ? '<span class="online-dot"></span>' : '';

            const isActive = this.currentContact?.contact_id === c.contact_id;

            return `
            <div class="contact-item ${isActive ? 'active' : ''}"
                 data-id="${c.contact_id}"
                 data-name="${this._esc(c.display_name || c.username)}"
                 role="button" tabindex="0"
                 onclick="window.chat.openChat('${c.contact_id}', '${this._esc(c.display_name || c.username)}', '${c.avatar || ''}')">
                <div class="contact-avatar">
                    ${avatarHtml}
                    ${online}
                </div>
                <div class="contact-info">
                    <div class="contact-header">
                        <span class="contact-name">${this._esc(c.display_name || c.username)}</span>
                        <span class="contact-time">${lastTime}</span>
                    </div>
                    <div class="contact-footer">
                        <span class="contact-preview">${this._esc(lastMsg)}</span>
                        ${unread}
                    </div>
                </div>
            </div>`;
        }).join('');
    }

    _renderHeaderStatus(contactId) {
        const headerStatus = document.getElementById('chatHeaderStatus');
        if (!headerStatus) return;
        const contact = this.contacts.find(c => c.contact_id === contactId);
        if (contact?.is_online) {
            headerStatus.innerHTML = `<span class="online-dot"></span> Online`;
        } else if (contact?.last_seen) {
            headerStatus.textContent = `Last seen ${this._formatTime(contact.last_seen)}`;
        } else {
            headerStatus.textContent = 'Offline';
        }
    }

    async openChat(contactId, displayName, avatar) {
        this.currentContact = { contact_id: contactId, display_name: displayName, avatar };
        this._openMenuId = null;

        const headerName = document.getElementById('chatHeaderName');
        const headerAvatar = document.getElementById('chatHeaderAvatar');
        if (headerName) headerName.textContent = displayName;
        this._renderHeaderStatus(contactId);
        if (headerAvatar) {
            if (avatar && avatar !== '/assets/images/default-avatar.png') {
                headerAvatar.innerHTML = `<img src="${avatar}" alt="${displayName[0]}" style="width:100%;height:100%;object-fit:cover;border-radius:50%;" onerror="this.outerHTML='<span>${displayName[0].toUpperCase()}</span>';" />`;
            } else {
                headerAvatar.textContent = displayName[0].toUpperCase();
            }
        }

        if (this.socket && this.connected) {
            const roomId = `private_${this._roomId(contactId)}`;
            console.log('Joining room:', roomId);
            this.socket.emit('join_room', { room: roomId });
        }

        await this._loadMessages(contactId);

        document.querySelectorAll('.contact-item').forEach(el => {
            el.classList.toggle('active', el.dataset.id === contactId);
        });

        document.querySelector('.chat-main')?.classList.add('mobile-chat-open');
        document.getElementById('chatInput')?.focus();
    }

    async _loadMessages(contactId) {
        const container = document.getElementById('chatMessages');
        if (!container) return;

        container.innerHTML = `<div style="display:flex;justify-content:center;padding:32px;"><div class="spinner"></div></div>`;

        try {
            const res = await resilientFetch(`${this._base()}/api/chat/${contactId}/messages?limit=50`, {
                credentials: 'include',
                headers: { 'X-Requested-With': 'XMLHttpRequest' },
            });
            const data = await res.json();
            this.messages = data.messages || [];
        } catch (_) {
            this.messages = [];
            if (!this._isOnline) {
                container.innerHTML = `
                    <div class="chat-welcome">
                        <i class="fas fa-wifi" style="opacity:.4;"></i>
                        <h3>You're offline</h3>
                        <p>Messages will load once you're back online.</p>
                    </div>`;
                return;
            }
        }

        this._renderMessages();
    }

    _renderMessages() {
        const container = document.getElementById('chatMessages');
        if (!container) return;

        if (!this.messages.length) {
            container.innerHTML = `
                <div class="chat-welcome">
                    <i class="fas fa-ghost"></i>
                    <h3>Start a secure conversation</h3>
                    <p>Messages are encrypted with AES-256 before sending.</p>
                    <p style="font-size:.75rem;color:var(--t3);margin-top:8px;">
                        <kbd>Alt+N</kbd> Add contact · <kbd>Alt+E</kbd> Toggle encryption
                    </p>
                </div>`;
            return;
        }

        let html = '';
        let lastDate = '';

        this.messages.forEach(msg => {
            const isMine = msg.sender_id === this.user.id;
            const msgDate = new Date(msg.created_at).toLocaleDateString();

            if (msgDate !== lastDate) {
                lastDate = msgDate;
                html += `<div class="msg-date-sep"><span>${this._formatDate(msg.created_at)}</span></div>`;
            }

            const time = this._formatTime(msg.created_at);
            const status = isMine ? (
                msg.is_read
                    ? '<span class="msg-status read">✓✓</span>'
                    : msg.is_delivered
                        ? '<span class="msg-status delivered">✓✓</span>'
                        : '<span class="msg-status sent">✓</span>'
            ) : '';

            const menuOpen = this._openMenuId === msg.id;

            // ── Media messages (image/audio/video) render as their own bubble type ──
            if (['image', 'audio', 'video'].includes(msg.message_type)) {
                const url = msg.media_url || (msg.id ? `/api/media/${msg.id}` : '');
                const caption = msg.encrypted_content ? `<div class="msg-content">${this._esc(msg.encrypted_content)}</div>` : '';
                let mediaHtml = '';
                if (msg.message_type === 'image') {
                    mediaHtml = `<img class="msg-media-image" src="${url}" alt="Shared image" onclick="window.open('${url}', '_blank')">`;
                } else if (msg.message_type === 'audio') {
                    mediaHtml = `<audio class="msg-media-audio" controls src="${url}"></audio>`;
                } else {
                    mediaHtml = `<video class="msg-media-video" controls src="${url}"></video>`;
                }
                html += `
                <div class="msg-wrapper ${isMine ? 'mine' : 'theirs'}" id="msg-${msg.id}">
                    <div class="msg-bubble ${isMine ? 'bubble-mine' : 'bubble-theirs'}">
                        ${mediaHtml}
                        ${caption}
                        <button class="msg-menu-toggle" title="Message actions" aria-label="Message actions"
                            onclick="window.chat.toggleMsgMenu('${msg.id}', event)">
                            <i class="fas fa-ellipsis-vertical"></i>
                        </button>
                        <div class="msg-crypto-actions ${menuOpen ? 'menu-open' : ''}" id="crypto-actions-${msg.id}">
                            <a class="msg-decrypt-btn msg-crypto-btn" href="${url}?download=1" download="${this._esc(msg.file_name || msg.message_type)}" title="Download">
                                <i class="fas fa-download"></i> Download
                            </a>
                            <button class="msg-decrypt-btn msg-crypto-btn" onclick="window.chat.openForwardPicker('${msg.id}')" title="Forward to another contact">
                                <i class="fas fa-share"></i> Forward
                            </button>
                            <button class="msg-decrypt-btn msg-crypto-btn" onclick="window.chat.deleteMessage('${msg.id}', ${isMine})" title="Delete">
                                <i class="fas fa-trash"></i> Delete
                            </button>
                        </div>
                        <div class="msg-meta">
                            <span class="msg-time">${time}</span>
                            ${status}
                        </div>
                    </div>
                </div>`;
                return;
            }

            const rawContent = msg.encrypted_content || '';

            const looksEncrypted = /[\u{1F000}-\u{1FFFF}]|[\u2600-\u27BF]|[\u{1F300}-\u{1F5FF}]/u.test(rawContent) && rawContent.length > 10;

            if (looksEncrypted && !(msg.id in this.decryptData)) {
                this.decryptData[msg.id] = rawContent;
            }
            if (!looksEncrypted && !(msg.id in this._plainData)) {
                this._plainData[msg.id] = rawContent;
            }

            if (!(msg.id in this._msgViewState)) {
                this._msgViewState[msg.id] = looksEncrypted ? 'encrypted' : 'plain';
            }
            const state = this._msgViewState[msg.id];
            const displayContent = state === 'encrypted'
                ? this._esc(this.decryptData[msg.id] ?? rawContent)
                : this._esc(this._plainData[msg.id] ?? rawContent);

            html += `
            <div class="msg-wrapper ${isMine ? 'mine' : 'theirs'}" id="msg-${msg.id}">
                <div class="msg-bubble ${isMine ? 'bubble-mine' : 'bubble-theirs'}">
                    <div class="msg-content" id="content-${msg.id}">
                        ${state === 'encrypted' ? '🔒 ' : ''}${displayContent}
                    </div>
                    <button class="msg-menu-toggle" title="Message actions" aria-label="Message actions"
                        onclick="window.chat.toggleMsgMenu('${msg.id}', event)">
                        <i class="fas fa-ellipsis-vertical"></i>
                    </button>
                    <div class="msg-crypto-actions ${menuOpen ? 'menu-open' : ''}" id="crypto-actions-${msg.id}">
                        <button class="msg-decrypt-btn msg-crypto-btn" id="crypto-toggle-${msg.id}" onclick="window.chat.${state === 'encrypted' ? 'decryptMessage' : 'encryptMessageBubble'}('${msg.id}')">
                            <i class="fas fa-${state === 'encrypted' ? 'lock' : 'lock-open'}"></i> ${state === 'encrypted' ? 'Decrypt' : 'Encrypt'}
                        </button>
                        ${state === 'encrypted' ? `
                        <button class="msg-decrypt-btn msg-crypto-btn" id="crypto-copy-${msg.id}" onclick="window.chat.copyRawPacket('${msg.id}')" title="Copy the exact encrypted packet — safe to paste into the Dashboard decrypt tool">
                            <i class="fas fa-copy"></i> Copy
                        </button>` : ''}
                        <button class="msg-decrypt-btn msg-crypto-btn" onclick="window.chat.openForwardPicker('${msg.id}')" title="Forward to another contact">
                            <i class="fas fa-share"></i> Forward
                        </button>
                        <button class="msg-decrypt-btn msg-crypto-btn" onclick="window.chat.deleteMessage('${msg.id}', ${isMine})" title="Delete">
                            <i class="fas fa-trash"></i> Delete
                        </button>
                    </div>
                    <div class="msg-meta">
                        <span class="msg-time">${time}</span>
                        ${status}
                    </div>
                </div>
            </div>`;
        });

        container.innerHTML = html;
        this._scrollToBottom();
    }

    // ── Per-message ⋮ menu — only one open at a time, closes on outside click ──
    toggleMsgMenu(msgId, event) {
        if (event) event.stopPropagation();
        this._openMenuId = this._openMenuId === msgId ? null : msgId;

        document.querySelectorAll('.msg-crypto-actions.menu-open').forEach(el => {
            if (el.id !== `crypto-actions-${this._openMenuId}`) el.classList.remove('menu-open');
        });
        const target = document.getElementById(`crypto-actions-${msgId}`);
        if (target) target.classList.toggle('menu-open', this._openMenuId === msgId);
    }

    _closeAllMsgMenus() {
        if (!this._openMenuId) return;
        this._openMenuId = null;
        document.querySelectorAll('.msg-crypto-actions.menu-open').forEach(el => el.classList.remove('menu-open'));
    }

    async decryptMessage(msgId) {
        const password = prompt('Enter the encryption password to decrypt this message:');
        if (!password) return;

        const contentEl = document.getElementById(`content-${msgId}`);
        if (!contentEl) return;

        const encryptedContent = this.decryptData?.[msgId] || contentEl.textContent.replace('🔒 ', '').trim();

        try {
            const res = await resilientFetch(`${this._base()}/api/decrypt`, {
                method: 'POST',
                credentials: 'include',
                headers: {
                    'Content-Type': 'application/json',
                    'X-Requested-With': 'XMLHttpRequest',
                    'X-CSRF-Token': this._getCsrf(),
                },
                body: JSON.stringify({
                    emoji_message: encryptedContent,
                    password: password
                }),
            });
            const data = await res.json();

            if (data.success) {
                this._plainData[msgId] = data.decrypted_message;
                this._msgViewState[msgId] = 'plain';

                contentEl.innerHTML = `<span style="color:var(--green);">🔓 ${this._esc(data.decrypted_message)}</span>`;
                this._swapCryptoButton(msgId, 'plain');
                this._toast('Message decrypted!', 'success');
            } else {
                this._toast('Wrong password or invalid message', 'error');
            }
        } catch (_) {
            this._toast(this._isOnline ? 'Decryption failed' : 'You are offline', 'error');
        }
    }

    async encryptMessageBubble(msgId) {
        const password = this.password || prompt('Enter a password to encrypt this message:');
        if (!password) return;

        const contentEl = document.getElementById(`content-${msgId}`);
        if (!contentEl) return;

        const plainText = this._plainData?.[msgId] ?? contentEl.textContent.replace('🔓 ', '').trim();
        if (!plainText) {
            this._toast('Nothing to encrypt', 'error');
            return;
        }

        try {
            const res = await resilientFetch(`${this._base()}/api/encrypt`, {
                method: 'POST',
                credentials: 'include',
                headers: {
                    'Content-Type': 'application/json',
                    'X-Requested-With': 'XMLHttpRequest',
                    'X-CSRF-Token': this._getCsrf(),
                },
                body: JSON.stringify({ message: plainText, password: password, use_decoys: false }),
            });
            const data = await res.json();

            if (data.success) {
                this.decryptData[msgId] = data.emoji_message;
                this._msgViewState[msgId] = 'encrypted';

                contentEl.innerHTML = `🔒 ${this._esc(data.emoji_message)}`;
                this._swapCryptoButton(msgId, 'encrypted');
                this._toast('Message encrypted', 'success');
            } else {
                this._toast(data.error || 'Encryption failed', 'error');
            }
        } catch (_) {
            this._toast(this._isOnline ? 'Encryption failed' : 'You are offline', 'error');
        }
    }

    _swapCryptoButton(msgId, newState) {
        const toggleBtn = document.getElementById(`crypto-toggle-${msgId}`);
        const actions = document.getElementById(`crypto-actions-${msgId}`);
        if (!toggleBtn || !actions) return;

        if (newState === 'encrypted') {
            toggleBtn.innerHTML = '<i class="fas fa-lock"></i> Decrypt';
            toggleBtn.setAttribute('onclick', `window.chat.decryptMessage('${msgId}')`);
            if (!document.getElementById(`crypto-copy-${msgId}`)) {
                const copyBtn = document.createElement('button');
                copyBtn.className = 'msg-decrypt-btn msg-crypto-btn';
                copyBtn.id = `crypto-copy-${msgId}`;
                copyBtn.title = 'Copy the exact encrypted packet — safe to paste into the Dashboard decrypt tool';
                copyBtn.innerHTML = '<i class="fas fa-copy"></i> Copy';
                copyBtn.onclick = () => this.copyRawPacket(msgId);
                actions.insertBefore(copyBtn, actions.children[1] || null);
            }
        } else {
            toggleBtn.innerHTML = '<i class="fas fa-lock-open"></i> Encrypt';
            toggleBtn.setAttribute('onclick', `window.chat.encryptMessageBubble('${msgId}')`);
            document.getElementById(`crypto-copy-${msgId}`)?.remove();
        }
    }

    copyRawPacket(msgId) {
        const packet = this.decryptData?.[msgId];
        if (!packet) {
            this._toast('Nothing to copy', 'error');
            return;
        }
        if (window.secureCopy) {
            window.secureCopy(packet, 0);
        } else {
            navigator.clipboard.writeText(packet)
                .then(() => this._toast('Encrypted packet copied', 'success'))
                .catch(() => this._toast('Copy failed', 'error'));
            return;
        }
        this._toast('Encrypted packet copied — paste it into Dashboard → Decrypt', 'success');
    }

    async sendMessage() {
        const input = document.getElementById('chatInput');
        if (!input) return;
        const text = input.value.trim();
        if (!text || !this.currentContact) return;

        input.value = '';
        input.style.height = 'auto';

        let content = text;

        if (this.encryptMessages && this.password) {
            try {
                const encResult = await resilientFetch(`${this._base()}/api/encrypt`, {
                    method: 'POST',
                    credentials: 'include',
                    headers: {
                        'Content-Type': 'application/json',
                        'X-Requested-With': 'XMLHttpRequest',
                        'X-CSRF-Token': this._getCsrf(),
                    },
                    body: JSON.stringify({
                        message: text,
                        password: this.password,
                        use_decoys: false,
                    }),
                }, { retries: 1 }); // encryption itself shouldn't hang the send flow long
                const encData = await encResult.json();
                if (encData.success) {
                    content = encData.emoji_message;
                } else {
                    this._toast('Encryption failed — sending as plain text', 'info');
                }
            } catch (_) {
                this._toast('Encryption unavailable — sending as plain text', 'info');
            }
        }

        const tempId = 'temp_' + Date.now();
        const tempMsg = {
            id: tempId,
            sender_id: this.user.id,
            receiver_id: this.currentContact.contact_id,
            encrypted_content: content,
            message_type: 'chat',
            created_at: new Date().toISOString(),
            is_read: false,
            is_delivered: false,
        };
        this.messages.push(tempMsg);
        this._renderMessages();

        if (!this._isOnline) {
            this._sendQueue.push({ content, tempId, contactId: this.currentContact.contact_id });
            this._toast('Offline — message queued and will send automatically', 'info');
            return;
        }

        await this._deliverMessage(content, tempId, this.currentContact.contact_id);
    }

    // ── Actual delivery, split out so the offline queue can replay it later ──
    async _deliverMessage(content, tempId, contactId) {
        const roomId = `private_${this._roomId(contactId)}`;

        if (this.socket && this.connected) {
            console.log('Sending message to room:', roomId);
            this.socket.emit('send_private_message', {
                room: roomId,
                content: content,
                sender_id: this.user.id,
                sender: this.user.username,
                avatar: this.user.avatar || '',
                receiver_id: contactId,
                temp_id: tempId,
            });
        } else {
            console.warn('Socket not connected, using REST fallback');
            try {
                const res = await resilientFetch(`${this._base()}/api/chat/${contactId}/messages`, {
                    method: 'POST',
                    credentials: 'include',
                    headers: {
                        'Content-Type': 'application/json',
                        'X-Requested-With': 'XMLHttpRequest',
                        'X-CSRF-Token': this._getCsrf(),
                    },
                    body: JSON.stringify({ content }),
                });
                if (!res.ok) {
                    const errData = await res.json().catch(() => ({}));
                    throw new Error(errData.error || `HTTP ${res.status}`);
                }
                const data = await res.json();
                const idx = this.messages.findIndex(m => m.id === tempId);
                if (idx > -1 && data.message) {
                    this.messages[idx] = { ...this.messages[idx], id: data.message.id, is_delivered: true };
                    this._renderMessages();
                }
            } catch (error) {
                console.error('REST fallback failed:', error);
                if (!this._isOnline) {
                    this._sendQueue.push({ content, tempId, contactId });
                    this._toast('Connection lost — message queued', 'info');
                } else {
                    this._toast('Failed to send message', 'error');
                }
                return;
            }
        }

        const contact = this.contacts.find(c => c.contact_id === contactId);
        if (contact) {
            contact.last_message = { content, created_at: new Date().toISOString(), is_mine: true };
            this._renderContacts();
        }

        this._stopTyping();
    }

    // ── Media sharing: images, video (file picker), voice notes (recorded) ──

    _mediaLimits() {
        return { image: 8 * 1024 * 1024, audio: 15 * 1024 * 1024, video: 40 * 1024 * 1024 };
    }

    async _uploadMedia(file, mediaType) {
        if (!this.currentContact) {
            this._toast('Open a chat first', 'error');
            return;
        }
        if (!this._isOnline) {
            this._toast('You are offline — cannot send media right now', 'error');
            return;
        }
        const limit = this._mediaLimits()[mediaType];
        if (file.size > limit) {
            this._toast(`${mediaType} must be under ${Math.round(limit / (1024 * 1024))}MB`, 'error');
            return;
        }

        this._toast(`Sending ${mediaType}…`, 'info');

        const form = new FormData();
        form.append('file', file, file.name || `${mediaType}_${Date.now()}`);
        form.append('media_type', mediaType);

        try {
            const res = await resilientFetch(`${this._base()}/api/chat/${this.currentContact.contact_id}/media`, {
                method: 'POST',
                credentials: 'include',
                headers: {
                    'X-Requested-With': 'XMLHttpRequest',
                    'X-CSRF-Token': this._getCsrf(),
                },
                body: form,
            }, { retries: 1 }); // large uploads shouldn't silently re-send multiple times
            const data = await res.json();
            if (!res.ok || !data.success) {
                this._toast(data.error || `Failed to send ${mediaType}`, 'error');
                return;
            }
            this._toast(`${mediaType[0].toUpperCase()}${mediaType.slice(1)} sent`, 'success');
        } catch (err) {
            console.error('Media upload failed:', err);
            this._toast(`Failed to send ${mediaType}`, 'error');
        }
    }

    async _startVoiceRecording() {
        if (!this.currentContact) {
            this._toast('Open a chat first', 'error');
            return;
        }
        if (!navigator.mediaDevices?.getUserMedia) {
            this._toast('Voice recording is not supported in this browser', 'error');
            return;
        }
        try {
            const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
            const mimeType = MediaRecorder.isTypeSupported('audio/webm') ? 'audio/webm' : '';
            this._recorder = mimeType ? new MediaRecorder(stream, { mimeType }) : new MediaRecorder(stream);
            this._recordedChunks = [];
            this._recorder.ondataavailable = e => { if (e.data.size > 0) this._recordedChunks.push(e.data); };
            this._recorder.onstop = () => { stream.getTracks().forEach(t => t.stop()); };
            this._recorder.start();

            document.getElementById('chatInputBar').style.display = 'none';
            document.getElementById('recordingBar').style.display = 'flex';
            this._recordingSeconds = 0;
            const timeEl = document.getElementById('recordingTime');
            this._recordingTimer = setInterval(() => {
                this._recordingSeconds++;
                const m = Math.floor(this._recordingSeconds / 60);
                const s = String(this._recordingSeconds % 60).padStart(2, '0');
                if (timeEl) timeEl.textContent = `${m}:${s}`;
            }, 1000);
        } catch (err) {
            console.error('Microphone access failed:', err);
            this._toast('Microphone access denied', 'error');
        }
    }

    _stopVoiceRecording(shouldSend) {
        clearInterval(this._recordingTimer);
        document.getElementById('recordingBar').style.display = 'none';
        document.getElementById('chatInputBar').style.display = 'flex';

        if (!this._recorder) return;
        const recorder = this._recorder;
        const mimeType = recorder.mimeType || 'audio/webm';

        recorder.onstop = () => {
            recorder.stream.getTracks().forEach(t => t.stop());
            if (shouldSend && this._recordedChunks.length) {
                const blob = new Blob(this._recordedChunks, { type: mimeType });
                const ext = mimeType.includes('webm') ? 'webm' : 'ogg';
                const file = new File([blob], `voice_${Date.now()}.${ext}`, { type: mimeType });
                this._uploadMedia(file, 'audio');
            }
            this._recorder = null;
            this._recordedChunks = [];
        };
        recorder.stop();
    }

    _connectSocket() {
        const socketUrl = window.location.origin;

        try {
            this.socket = io(socketUrl, {
                transports: ['polling', 'websocket'],
                withCredentials: true,
                reconnection: true,
                reconnectionAttempts: Infinity,   // ── FIX: unstable mobile networks need to keep retrying, not give up after 10 ──
                reconnectionDelay: 1000,
                reconnectionDelayMax: 10000,
                timeout: 20000,
                path: '/socket.io',
            });

            this.socket.on('connect', () => {
                console.log('✅ Socket connected');
                this.connected = true;
                this.reconnectAttempts = 0;
                this._updateOnlineStatus(true);

                this.socket.emit('join_user_room', { user_id: this.user.id });
                console.log('Joined user room:', `user_${this.user.id}`);

                if (this.currentContact) {
                    const roomId = `private_${this._roomId(this.currentContact.contact_id)}`;
                    console.log('Re-joining room:', roomId);
                    this.socket.emit('join_room', { room: roomId });
                }

                const statusEl = document.getElementById('userStatus');
                if (statusEl) {
                    statusEl.textContent = '🟢 Online';
                    statusEl.style.color = 'var(--green)';
                }

                // Reconnect after a drop — replay anything queued while disconnected
                this._flushSendQueue();
            });

            this.socket.on('room_join_denied', data => {
                console.error('Room join denied:', data.reason);
                this._toast('Session issue — please refresh the page', 'error');
            });

            this.socket.on('disconnect', () => {
                console.log('❌ Socket disconnected');
                this.connected = false;
                this._updateOnlineStatus(false);
                const statusEl = document.getElementById('userStatus');
                if (statusEl) {
                    statusEl.textContent = '🔴 Offline';
                    statusEl.style.color = 'var(--red)';
                }
            });

            this.socket.on('connect_error', (error) => {
                console.error('Socket connection error:', error);
                this.connected = false;
                this.reconnectAttempts++;
                const statusEl = document.getElementById('userStatus');
                if (statusEl) {
                    statusEl.textContent = '🔄 Reconnecting...';
                    statusEl.style.color = 'var(--amber)';
                }
            });

            this.socket.on('receive_message', data => {
                console.log('📨 Message received:', data);
                this._handleReceivedMessage(data);
            });

            this.socket.on('message_failed', data => {
                this._toast(data.error || 'Message failed to send', 'error');
                const idx = this.messages.findIndex(m => m.id === data.temp_id);
                if (idx > -1) {
                    this.messages[idx].is_delivered = false;
                    this.messages[idx]._failed = true;
                    this._renderMessages();
                }
            });

            this.socket.on('typing', data => {
                console.log('⌨️ typing event received:', data);
                if (data.user_id !== this.user.id && this.currentContact?.contact_id === data.user_id) {
                    this._showTyping(data.username);
                    const headerStatus = document.getElementById('chatHeaderStatus');
                    if (headerStatus) headerStatus.textContent = `${data.username} is typing…`;
                }
            });
            this.socket.on('stop_typing', data => {
                console.log('⌨️ stop_typing event received:', data);
                if (this.currentContact?.contact_id === data.user_id) {
                    this._hideTyping();
                    this._renderHeaderStatus(data.user_id);
                }
            });

            this.socket.on('user_online', data => {
                console.log('🟢 user_online event received:', data);
                const c = this.contacts.find(x => x.contact_id === data.user_id);
                if (c) { c.is_online = true;
                    this._renderContacts();
                    if (this.currentContact?.contact_id === data.user_id) this._renderHeaderStatus(data.user_id);
                } else {
                    console.warn('user_online received for a contact_id not in this.contacts:', data.user_id);
                }
            });
            this.socket.on('user_offline', data => {
                console.log('⚫ user_offline event received:', data);
                const c = this.contacts.find(x => x.contact_id === data.user_id);
                if (c) { c.is_online = false;
                    this._renderContacts();
                    if (this.currentContact?.contact_id === data.user_id) this._renderHeaderStatus(data.user_id);
                }
            });

            this.socket.on('message_deleted', data => {
                this.messages = this.messages.filter(m => m.id !== data.message_id);
                this._renderMessages();
            });

            this.socket.on('message_restored', () => {
                if (this.currentContact) this._loadMessages(this.currentContact.contact_id);
            });

            this.socket.on('friend_request', data => {
                console.log('📨 Connection request received:', data);
                this._handleFriendRequest(data);
            });

            this.socket.on('friend_request_accepted', data => {
                console.log('✅ Connection request accepted:', data);
                this._toast(`${data.username} accepted your connection request!`, 'success');
                this._loadContacts();
            });

            this.socket.on('friend_request_rejected', data => {
                console.log('❌ Connection request declined');
                this._pendingSent = (this._pendingSent || []).filter(id => id !== data.from);
            });

        } catch (error) {
            console.error('Failed to create socket:', error);
        }
    }

    _handleReceivedMessage(data) {
        const isCurrentChat = !!this.currentContact && (
            (data.sender_id === this.currentContact.contact_id && data.receiver_id === this.user.id) ||
            (data.receiver_id === this.currentContact.contact_id && data.sender_id === this.user.id)
        );

        if (isCurrentChat) {
            const idx = this.messages.findIndex(m => m.id === data.temp_id);
            if (idx > -1) {
                this.messages[idx] = { ...this.messages[idx], id: data.id, is_delivered: true };
            } else if (!this.messages.some(m => m.id === data.id)) {
                this.messages.push({
                    id: data.id,
                    sender_id: data.sender_id,
                    receiver_id: data.receiver_id || this.user.id,
                    encrypted_content: data.content,
                    message_type: data.message_type || 'chat',
                    media_url: data.media_url || null,
                    file_name: data.file_name || null,
                    file_size: data.file_size || null,
                    created_at: data.created_at || new Date().toISOString(),
                    is_read: false,
                    is_delivered: true,
                });
            }
            this._renderMessages();
            if (data.sender_id !== this.user.id) {
                this._notifyNewMessage(data);
                this.socket?.emit('mark_read', { contact_id: data.sender_id });
            }
        }

        if (data.sender_id !== this.user.id) {
            const contact = this.contacts.find(c => c.contact_id === data.sender_id);
            if (contact) {
                const mediaLabels = { image: '📷 Photo', audio: '🎤 Voice note', video: '🎥 Video' };
                contact.last_message = {
                    content: mediaLabels[data.message_type] || data.content,
                    created_at: data.created_at,
                    is_mine: false,
                };
                if (!isCurrentChat || !document.hasFocus()) {
                    contact.unread_count = (contact.unread_count || 0) + 1;
                }
                this._renderContacts();
            }
        }
    }

    async _loadPendingRequests() {
        try {
            const res = await resilientFetch(`${this._base()}/api/contacts/requests`, {
                credentials: 'include',
                headers: { 'X-Requested-With': 'XMLHttpRequest' },
            });
            const data = await res.json();
            this._pendingIncoming = data.requests || [];
        } catch (_) {
            this._pendingIncoming = [];
        }
        this._renderPendingBadge();
    }

    _renderPendingBadge() {
        const badge = document.getElementById('pendingBadge');
        if (!badge) return;
        const n = (this._pendingIncoming || []).length;
        badge.style.display = n ? 'flex' : 'none';
        badge.textContent = n > 99 ? '99+' : n;
    }

    openForwardPicker(msgId) {
        this._closeAllMsgMenus();
        this._forwardingMsgId = msgId;
        const container = document.getElementById('userSearchResults');
        const searchInput = document.getElementById('newChatSearch');
        if (!container) return;
        if (searchInput) searchInput.style.display = 'none';

        const contacts = this.contacts || [];
        container.innerHTML = contacts.length
            ? contacts.map(c => `
                <div class="search-result-item">
                    <div class="result-avatar">
                        ${c.avatar && c.avatar !== '/assets/images/default-avatar.png'
                            ? `<img src="${c.avatar}" alt="${(c.display_name || c.username)[0]}" onerror="this.outerHTML='<span>${(c.display_name || c.username)[0].toUpperCase()}</span>';" />`
                            : `<span>${(c.display_name || c.username)[0].toUpperCase()}</span>`}
                    </div>
                    <div class="result-info">
                        <div class="result-name">${this._esc(c.display_name || c.username)}</div>
                    </div>
                    <button class="btn-add-contact" onclick="window.chat.forwardMessage('${c.contact_id}', '${this._esc(c.display_name || c.username)}')">
                        <i class="fas fa-share"></i> Forward here
                    </button>
                </div>`).join('')
            : '<div class="no-results" style="padding:20px;text-align:center;color:var(--t3);">No contacts to forward to yet</div>';

        openModal('newChatModal');
    }

    async forwardMessage(toContactId, username) {
        const msgId = this._forwardingMsgId;
        if (!msgId) return;
        try {
            const res = await resilientFetch(`${this._base()}/api/messages/${msgId}/forward`, {
                method: 'POST',
                credentials: 'include',
                headers: {
                    'Content-Type': 'application/json',
                    'X-Requested-With': 'XMLHttpRequest',
                    'X-CSRF-Token': this._getCsrf(),
                },
                body: JSON.stringify({ contact_id: toContactId }),
            });
            const data = await res.json();
            if (data.success) {
                this._toast(`Forwarded to ${username}`, 'success');
                closeModal('newChatModal');
                if (this.currentContact?.contact_id === toContactId) await this._loadMessages(toContactId);
            } else {
                this._toast(data.error || 'Forward failed', 'error');
            }
        } catch (_) {
            this._toast(this._isOnline ? 'Forward failed' : 'You are offline', 'error');
        }
        this._forwardingMsgId = null;
    }

    async deleteMessage(msgId, isMine) {
        this._closeAllMsgMenus();
        const scope = await this._showDeleteChoice(isMine);
        if (!scope) return;

        try {
            const res = await resilientFetch(`${this._base()}/api/chat/messages/${msgId}?scope=${scope}`, {
                method: 'DELETE',
                credentials: 'include',
                headers: {
                    'X-Requested-With': 'XMLHttpRequest',
                    'X-CSRF-Token': this._getCsrf(),
                },
            });
            const data = await res.json();
            if (data.success) {
                this.messages = this.messages.filter(m => m.id !== msgId);
                this._renderMessages();
                const label = scope === 'everyone' ? 'Deleted for everyone' : 'Deleted for you';
                this._showUndoToast(label, () => this._undoDeleteMessage(msgId));
            } else {
                this._toast(data.error || 'Delete failed', 'error');
            }
        } catch (_) {
            this._toast(this._isOnline ? 'Delete failed' : 'You are offline', 'error');
        }
    }

    _showDeleteChoice(isMine) {
        return new Promise(resolve => {
            document.getElementById('deleteChoiceOverlay')?.remove();

            const overlay = document.createElement('div');
            overlay.id = 'deleteChoiceOverlay';
            overlay.style.cssText = `
                position: fixed; inset: 0; background: rgba(0,0,0,.55);
                display: flex; align-items: center; justify-content: center; z-index: 10000;
            `;

            const panel = document.createElement('div');
            panel.style.cssText = `
                background: var(--bg3, #14181f); border: 1px solid var(--border, #2a2f3a);
                border-radius: 12px; padding: 20px; width: min(320px, 90vw);
                box-shadow: 0 12px 32px rgba(0,0,0,.5);
            `;

            const btnStyle = `
                display: block; width: 100%; text-align: left; padding: 12px 14px;
                margin-bottom: 8px; border-radius: 8px; border: 1px solid var(--border, #2a2f3a);
                background: var(--bg2, #0f1319); color: var(--t1, #fff); cursor: pointer;
                font-size: .875rem;
            `;

            panel.innerHTML = `
                <div style="font-weight:600;margin-bottom:14px;">Delete message?</div>
                ${isMine ? `<button id="delChoiceEveryone" style="${btnStyle}color:var(--red,#ff3b5c);">
                    <i class="fas fa-trash"></i> Delete for everyone
                </button>` : ''}
                <button id="delChoiceMe" style="${btnStyle}">
                    <i class="fas fa-user"></i> Delete for me
                </button>
                <button id="delChoiceCancel" style="${btnStyle}margin-bottom:0;color:var(--t2,#aaa);">
                    Cancel
                </button>
            `;

            overlay.appendChild(panel);
            document.body.appendChild(overlay);

            const finish = scope => { overlay.remove(); resolve(scope); };
            document.getElementById('delChoiceEveryone')?.addEventListener('click', () => finish('everyone'));
            document.getElementById('delChoiceMe').addEventListener('click', () => finish('me'));
            document.getElementById('delChoiceCancel').addEventListener('click', () => finish(null));
            overlay.addEventListener('click', e => { if (e.target === overlay) finish(null); });
        });
    }

    _showUndoToast(message, onUndo) {
        document.getElementById('undoToast')?.remove();

        const el = document.createElement('div');
        el.id = 'undoToast';
        el.style.cssText = `
            position: fixed; bottom: 24px; left: 50%; transform: translateX(-50%);
            background: var(--bg3, #14181f); border: 1px solid var(--border, #2a2f3a);
            border-radius: 10px; padding: 12px 18px; display: flex; align-items: center;
            gap: 16px; z-index: 9999; box-shadow: 0 8px 24px rgba(0,0,0,.4);
            color: var(--t1, #fff); font-size: .875rem;
        `;
        el.innerHTML = `<span>${this._esc(message)}</span>
            <button style="background:none;border:none;color:var(--primary,#00d4ff);font-weight:600;cursor:pointer;font-size:.875rem;padding:0;">Undo</button>`;
        document.body.appendChild(el);

        const timer = setTimeout(() => el.remove(), 5000);
        el.querySelector('button').addEventListener('click', () => {
            clearTimeout(timer);
            el.remove();
            onUndo();
        });
    }

    async _undoDeleteMessage(msgId) {
        try {
            const res = await resilientFetch(`${this._base()}/api/chat/messages/${msgId}/undo-delete`, {
                method: 'POST',
                credentials: 'include',
                headers: {
                    'X-Requested-With': 'XMLHttpRequest',
                    'X-CSRF-Token': this._getCsrf(),
                },
            });
            const data = await res.json();
            if (data.success) {
                this._toast('Delete undone', 'success');
                if (this.currentContact) await this._loadMessages(this.currentContact.contact_id);
            } else {
                this._toast(data.error || 'Could not undo — the window may have expired', 'error');
            }
        } catch (_) {
            this._toast('Could not undo', 'error');
        }
    }

    // ── Clear Chat — persists via /api/chat/<id>/clear (delete-for-me, bulk) ──
    async clearChat() {
        if (!this.currentContact) return;
        if (!confirm(`Clear this conversation with ${this.currentContact.display_name}? ` +
                     `This removes it from your view only — the other person keeps their copy. This cannot be undone.`)) {
            return;
        }
        try {
            const res = await resilientFetch(`${this._base()}/api/chat/${this.currentContact.contact_id}/clear`, {
                method: 'POST',
                credentials: 'include',
                headers: {
                    'Content-Type': 'application/json',
                    'X-Requested-With': 'XMLHttpRequest',
                    'X-CSRF-Token': this._getCsrf(),
                },
            });
            const data = await res.json();
            if (data.success) {
                this.messages = [];
                this._renderMessages();
                this._toast(`Chat cleared (${data.cleared} message${data.cleared === 1 ? '' : 's'})`, 'success');
            } else {
                this._toast(data.error || 'Failed to clear chat', 'error');
            }
        } catch (_) {
            this._toast(this._isOnline ? 'Failed to clear chat' : 'You are offline', 'error');
        }
    }

    openPendingPanel() {
        const container = document.getElementById('userSearchResults');
        const searchInput = document.getElementById('newChatSearch');
        if (!container) return;
        if (searchInput) searchInput.style.display = 'none';

        const requests = this._pendingIncoming || [];
        container.innerHTML = requests.length
            ? requests.map(r => `
                <div class="search-result-item">
                    <div class="result-avatar">
                        ${r.avatar && r.avatar !== '/assets/images/default-avatar.png'
                            ? `<img src="${r.avatar}" alt="${r.username[0]}" onerror="this.outerHTML='<span>${r.username[0].toUpperCase()}</span>';" />`
                            : `<span>${r.username[0].toUpperCase()}</span>`}
                    </div>
                    <div class="result-info">
                        <div class="result-name">${this._esc(r.username)}</div>
                        <div class="result-status">wants to connect</div>
                    </div>
                    <button class="btn-add-contact" onclick="window.chat.respondRequest('${r.contact_id}','accept','${this._esc(r.username)}')">
                        <i class="fas fa-check"></i> Accept
                    </button>
                    <button class="btn-add-contact" style="background:var(--red);margin-left:6px;" onclick="window.chat.respondRequest('${r.contact_id}','reject','${this._esc(r.username)}')">
                        <i class="fas fa-times"></i> Decline
                    </button>
                </div>`).join('')
            : '<div class="no-results" style="padding:20px;text-align:center;color:var(--t3);">No pending requests</div>';

        openModal('newChatModal');
    }

    async respondRequest(contactId, action, username) {
        try {
            const res = await resilientFetch(`${this._base()}/api/contacts/${contactId}/respond`, {
                method: 'POST',
                credentials: 'include',
                headers: {
                    'Content-Type': 'application/json',
                    'X-Requested-With': 'XMLHttpRequest',
                    'X-CSRF-Token': this._getCsrf(),
                },
                body: JSON.stringify({ action }),
            });
            const data = await res.json();
            if (data.success) {
                this._toast(
                    action === 'accept' ? `You're now connected with ${username}` : `Declined ${username}`,
                    action === 'accept' ? 'success' : 'info'
                );
                this._pendingIncoming = (this._pendingIncoming || []).filter(r => r.contact_id !== contactId);
                this._renderPendingBadge();
                this.openPendingPanel();
                if (action === 'accept') await this._loadContacts();
            } else {
                this._toast(data.error || 'Action failed', 'error');
            }
        } catch (_) {
            this._toast(this._isOnline ? 'Action failed' : 'You are offline', 'error');
        }
    }

    async searchUsers(query) {
        console.log('🔍 Searching for:', query);
        const resultsContainer = document.getElementById('userSearchResults');
        if (!resultsContainer) return;

        if (query.length < 2) {
            resultsContainer.innerHTML = '<div style="padding:20px;text-align:center;color:var(--t3);font-size:.875rem;">Type at least 2 characters</div>';
            return;
        }

        try {
            resultsContainer.innerHTML = '<div style="padding:20px;text-align:center;color:var(--t3);font-size:.875rem;">Searching...</div>';

            let csrfToken = this._getCsrf();
            if (!csrfToken) {
                try {
                    const tokenRes = await resilientFetch('/api/csrf-token', {
                        credentials: 'include',
                        headers: { 'X-Requested-With': 'XMLHttpRequest' }
                    });
                    const tokenData = await tokenRes.json();
                    csrfToken = tokenData.csrf_token;
                } catch (tokenError) {
                    console.error('Failed to fetch CSRF token:', tokenError);
                }
            }

            const res = await resilientFetch(`${this._base()}/api/contacts/search?q=${encodeURIComponent(query)}`, {
                credentials: 'include',
                headers: {
                    'Content-Type': 'application/json',
                    'X-Requested-With': 'XMLHttpRequest',
                    'X-CSRF-Token': csrfToken || ''
                },
            });

            if (res.status === 401 || res.status === 403) {
                resultsContainer.innerHTML = '<div style="padding:20px;text-align:center;color:var(--red);font-size:.875rem;">Session expired. Please refresh the page.</div>';
                return;
            }

            const data = await res.json();
            console.log('Search results:', data);

            if (data.success) {
                this._renderSearchResults(data.users || []);
            } else {
                resultsContainer.innerHTML =
                    `<div style="padding:20px;text-align:center;color:var(--red);font-size:.875rem;">${data.error || 'Search failed'}</div>`;
            }
        } catch (error) {
            console.error('Search error:', error);
            resultsContainer.innerHTML =
                `<div style="padding:20px;text-align:center;color:var(--red);font-size:.875rem;">${this._isOnline ? 'Search failed. Please try again.' : 'You are offline.'}</div>`;
        }
    }

    _renderSearchResults(users) {
        const container = document.getElementById('userSearchResults');
        if (!container) return;

        if (!users.length) {
            container.innerHTML = '<div class="no-results"><i class="fas fa-search" style="display:block;font-size:1.5rem;margin-bottom:8px;opacity:0.5;"></i>No users found. Try a different search.</div>';
            return;
        }

        container.innerHTML = users.map(u => {
            const isContact = u.is_contact || false;
            const isPending = u.is_pending || false;
            const isIncoming = u.is_incoming || false;

            let actionHtml = '';
            if (isContact) {
                actionHtml = `<span class="contact-badge"><i class="fas fa-check-circle"></i> Connected</span>`;
            } else if (isPending) {
                actionHtml = `<span class="pending-badge"><i class="fas fa-clock"></i> Pending</span>`;
            } else if (isIncoming) {
                actionHtml = `<button class="btn-add-contact" onclick="window.chat.respondRequest('${u.id}','accept','${this._esc(u.username)}')">
                    <i class="fas fa-check"></i> Accept request
                </button>`;
            } else {
                actionHtml = `<button class="btn-add-contact" onclick="window.chat.sendFriendRequest('${u.id}', '${this._esc(u.username)}')">
                    <i class="fas fa-user-plus"></i> Add
                </button>`;
            }

            return `
            <div class="search-result-item">
                <div class="result-avatar">
                    ${u.avatar && u.avatar !== '/assets/images/default-avatar.png'
                        ? `<img src="${u.avatar}" alt="${u.username[0]}" onerror="this.outerHTML='<span>${u.username[0].toUpperCase()}</span>';" />`
                        : `<span>${u.username[0].toUpperCase()}</span>`}
                </div>
                <div class="result-info">
                    <div class="result-name">${this._esc(u.username)}</div>
                    <div class="result-status">${u.is_online ? '🟢 Online' : '⚫ Offline'}</div>
                </div>
                ${actionHtml}
            </div>`;
        }).join('');
    }

    async sendFriendRequest(userId, username) {
        try {
            const res = await resilientFetch(`${this._base()}/api/contacts`, {
                method: 'POST',
                credentials: 'include',
                headers: {
                    'Content-Type': 'application/json',
                    'X-Requested-With': 'XMLHttpRequest',
                    'X-CSRF-Token': this._getCsrf(),
                },
                body: JSON.stringify({ contact_id: userId }),
            });
            const data = await res.json();
            console.log('Connection request response:', data);

            if (data.success) {
                if (data.status === 'accepted') {
                    this._toast(`You're now connected with ${username}!`, 'success');
                    closeModal('newChatModal');
                    await this._loadContacts();
                    this.openChat(userId, username, data.avatar || '');
                } else {
                    this._toast(`Connection request sent to ${username}`, 'success');
                    closeModal('newChatModal');
                }
            } else {
                this._toast(data.error || 'Failed to send request', 'error');
            }
        } catch (error) {
            console.error('Connection request error:', error);
            this._toast(this._isOnline ? 'Failed to send request' : 'You are offline', 'error');
        }
    }

    _handleFriendRequest(data) {
        this._pendingIncoming = this._pendingIncoming || [];
        if (!this._pendingIncoming.some(r => r.contact_id === data.from)) {
            this._pendingIncoming.push({ contact_id: data.from, username: data.username, avatar: data.avatar });
        }
        this._renderPendingBadge();
        this._toast(`${data.username} wants to connect — check pending requests`, 'info');
    }

    _setupEventListeners() {
        document.getElementById('sendBtn')?.addEventListener('click', () => this.sendMessage());

        const input = document.getElementById('chatInput');
        input?.addEventListener('keydown', e => {
            if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                this.sendMessage();
            } else if (e.key !== 'Escape') {
                this._handleTyping();
            }
        });
        input?.addEventListener('input', () => {
            if (input.tagName === 'TEXTAREA') {
                input.style.height = 'auto';
                input.style.height = Math.min(input.scrollHeight, 150) + 'px';
            }
        });

        document.getElementById('attachBtn')?.addEventListener('click', e => {
            e.stopPropagation();
            const menu = document.getElementById('attachMenu');
            if (menu) menu.style.display = menu.style.display === 'none' ? 'block' : 'none';
        });
        document.addEventListener('click', e => {
            const menu = document.getElementById('attachMenu');
            if (menu && menu.style.display !== 'none' && !menu.contains(e.target) && e.target.id !== 'attachBtn') {
                menu.style.display = 'none';
            }
            // Close any open per-message menu when clicking elsewhere
            if (!e.target.closest('.msg-crypto-actions') && !e.target.closest('.msg-menu-toggle')) {
                this._closeAllMsgMenus();
            }
        });

        document.getElementById('attachImageBtn')?.addEventListener('click', () => {
            document.getElementById('attachMenu').style.display = 'none';
            document.getElementById('imageFileInput')?.click();
        });
        document.getElementById('attachVideoBtn')?.addEventListener('click', () => {
            document.getElementById('attachMenu').style.display = 'none';
            document.getElementById('videoFileInput')?.click();
        });
        document.getElementById('attachSongBtn')?.addEventListener('click', () => {
            document.getElementById('attachMenu').style.display = 'none';
            document.getElementById('songFileInput')?.click();
        });
        document.getElementById('songFileInput')?.addEventListener('change', e => {
            const file = e.target.files?.[0];
            if (file) this._uploadMedia(file, 'audio');
            e.target.value = '';
        });
        document.getElementById('imageFileInput')?.addEventListener('change', e => {
            const file = e.target.files?.[0];
            if (file) this._uploadMedia(file, 'image');
            e.target.value = '';
        });
        document.getElementById('videoFileInput')?.addEventListener('change', e => {
            const file = e.target.files?.[0];
            if (file) this._uploadMedia(file, 'video');
            e.target.value = '';
        });

        document.getElementById('attachAudioBtn')?.addEventListener('click', () => {
            document.getElementById('attachMenu').style.display = 'none';
            this._startVoiceRecording();
        });
        document.getElementById('stopRecordingBtn')?.addEventListener('click', () => this._stopVoiceRecording(true));
        document.getElementById('cancelRecordingBtn')?.addEventListener('click', () => this._stopVoiceRecording(false));

        const addBtn = document.getElementById('addContactBtn');
        if (addBtn) {
            const newBtn = addBtn.cloneNode(true);
            addBtn.parentNode.replaceChild(newBtn, addBtn);

            newBtn.addEventListener('click', function(e) {
                e.preventDefault();
                e.stopPropagation();
                console.log('➕ Add Contact button clicked');
                document.getElementById('userSearchResults').innerHTML = '';
                openModal('newChatModal');
                setTimeout(() => {
                    const search = document.getElementById('newChatSearch');
                    if (search) {
                        search.style.display = '';
                        search.value = '';
                        search.focus();
                        search.select();
                    }
                }, 150);
            });
        } else {
            console.warn('Add Contact button not found in DOM');
        }

        document.getElementById('newChatSearch')?.addEventListener('input', e => {
            this.searchUsers(e.target.value.trim());
        });

        document.getElementById('contactSearch')?.addEventListener('input', e => {
            this._filterContacts(e.target.value.trim());
        });

        document.getElementById('chatLogout')?.addEventListener('click', async () => {
            await window.GhostChatAPI?.logout();
            window.location.href = 'login.html';
        });

        document.getElementById('encryptToggle')?.addEventListener('click', () => {
            this._toggleEncryption();
        });

        document.getElementById('setPasswordBtn')?.addEventListener('click', () => {
            const pw = prompt('Set encryption password (shared with your contact):');
            if (pw) {
                this.password = pw;
                this.encryptMessages = true;
                this._toast('Encryption password set. Messages will be encrypted.', 'success');
            }
        });

        document.getElementById('mobileBackBtn')?.addEventListener('click', () => {
            document.querySelector('.chat-main')?.classList.remove('mobile-chat-open');
        });

        document.getElementById('chatMenuBtn')?.addEventListener('click', () => {
            const panel = document.getElementById('infoPanel');
            if (panel) panel.style.display = panel.style.display === 'none' ? 'flex' : 'none';
        });
    }

    _setupKeyboardShortcuts() {
        document.addEventListener('keydown', e => {
            if (e.key === 'Escape') {
                document.querySelectorAll('.modal.active').forEach(m => m.classList.remove('active'));
                const picker = document.getElementById('emojiPicker');
                if (picker) picker.style.display = 'none';
                document.querySelector('.chat-main')?.classList.remove('mobile-chat-open');
                this._closeAllMsgMenus();
            }
            if ((e.ctrlKey || e.metaKey) && e.key === 'k') {
                e.preventDefault();
                const search = document.getElementById('contactSearch');
                if (search) { search.focus();
                    search.select(); }
            }
            if (e.altKey && e.key === 'n') {
                e.preventDefault();
                console.log('Alt+N pressed');
                openModal('newChatModal');
                setTimeout(() => document.getElementById('newChatSearch')?.focus(), 100);
            }
            if (e.altKey && e.key === 'e') {
                e.preventDefault();
                this._toggleEncryption();
            }
        });
    }

    _setupMobile() {
        const handleResize = () => {
            const isMobile = window.innerWidth <= 768;
            const sidebar = document.querySelector('.chat-sidebar');
            if (!sidebar) return;
            if (isMobile && this.currentContact) {
                sidebar.classList.add('mobile-hidden');
            } else {
                sidebar.classList.remove('mobile-hidden');
            }
        };
        window.addEventListener('resize', handleResize);
        handleResize();
    }

    _handleTyping() {
        if (!this.socket || !this.connected || !this.currentContact) return;
        if (!this.isTyping) {
            this.isTyping = true;
            this.socket.emit('typing', {
                room: `private_${this._roomId(this.currentContact.contact_id)}`,
                user_id: this.user.id,
                username: this.user.username,
            });
        }
        clearTimeout(this.typingTimer);
        this.typingTimer = setTimeout(() => this._stopTyping(), 2500);
    }

    _stopTyping() {
        if (!this.isTyping || !this.socket || !this.currentContact) return;
        this.isTyping = false;
        this.socket.emit('stop_typing', {
            room: `private_${this._roomId(this.currentContact.contact_id)}`,
            user_id: this.user.id,
        });
    }

    _showTyping(username) {
        let el = document.getElementById('typingIndicator');
        if (!el) {
            el = document.createElement('div');
            el.id = 'typingIndicator';
            el.className = 'typing-indicator-wrap';
            document.getElementById('chatMessages')?.appendChild(el);
        }
        el.innerHTML = `
            <div class="typing-bubble">
                <span class="dot"></span><span class="dot"></span><span class="dot"></span>
            </div>
            <span class="typing-text">${this._esc(username)} is typing…</span>`;
        this._scrollToBottom();
        clearTimeout(this._typingDisplayTimer);
        this._typingDisplayTimer = setTimeout(() => this._hideTyping(), 4000);
    }

    _hideTyping() {
        document.getElementById('typingIndicator')?.remove();
        if (this.currentContact) this._renderHeaderStatus(this.currentContact.contact_id);
    }

    _toggleEncryption() {
        if (!this.password && !this.encryptMessages) {
            const pw = prompt('Enter a shared encryption password:');
            if (!pw) return;
            this.password = pw;
            this.encryptMessages = true;
        } else {
            this.encryptMessages = !this.encryptMessages;
        }
        const btn = document.getElementById('encryptToggle');
        if (btn) {
            btn.innerHTML = this.encryptMessages
                ? '<i class="fas fa-lock" style="color:var(--green)"></i>'
                : '<i class="fas fa-lock-open" style="color:var(--t3)"></i>';
            btn.title = this.encryptMessages ? 'Encryption ON (Alt+E)' : 'Encryption OFF (Alt+E)';
        }
        this._toast(
            this.encryptMessages ? 'Messages will be encrypted' : 'Encryption disabled',
            this.encryptMessages ? 'success' : 'info'
        );
    }

    _updateOnlineStatus(online) {
        const el = document.getElementById('userStatus');
        if (el) {
            el.textContent = online ? '🟢 Online' : '🔴 Offline';
            el.style.color = online ? 'var(--green)' : 'var(--red)';
        }
    }

    _filterContacts(query) {
        document.querySelectorAll('.contact-item').forEach(el => {
            const name = el.dataset.name?.toLowerCase() || '';
            el.style.display = !query || name.includes(query.toLowerCase()) ? '' : 'none';
        });
    }

    _notifyNewMessage(data) {
        if (window.UI) UI.showToast(`New message from ${data.sender || 'Someone'}`, 'info');
        if (window.UI && window.UI.playSound) UI.playSound('info');
    }

    _scrollToBottom() {
        const el = document.getElementById('chatMessages');
        if (el) setTimeout(() => { el.scrollTop = el.scrollHeight; }, 50);
    }

    _base() {
        return window.location.origin.includes('localhost')
            ? 'http://127.0.0.1:5000'
            : window.location.origin;
    }

    _roomId(contactId) {
        return [this.user.id, contactId].sort().join('_');
    }

    _getCsrf() {
        const match = document.cookie.match(/(?:^|;\s*)gc_csrf=([^;]+)/);
        return match ? decodeURIComponent(match[1]) : '';
    }

    _truncate(str, n) {
        return str.length > n ? str.substring(0, n) + '…' : str;
    }

    _esc(str) {
        const d = document.createElement('div');
        d.textContent = String(str || '');
        return d.innerHTML;
    }

    _formatTime(iso) {
        return new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    }

    _formatDate(iso) {
        const d = new Date(iso);
        const now = new Date();
        const diff = Math.floor((now - d) / 86400000);
        if (diff === 0) return 'Today';
        if (diff === 1) return 'Yesterday';
        return d.toLocaleDateString();
    }

    _toast(msg, type = 'info') {
        if (window.UI) UI.showToast(msg, type);
    }
}

window.openModal = function (id) {
    const m = document.getElementById(id);
    if (m) m.classList.add('active');
};
window.closeModal = function (id) {
    const m = document.getElementById(id);
    if (m) m.classList.remove('active');
};

document.addEventListener('click', e => {
    if (e.target.classList.contains('modal')) {
        e.target.classList.remove('active');
    }
});

window.GhostChatRealtime = GhostChatRealtime;

document.addEventListener('DOMContentLoaded', () => {
    window.chat = new GhostChatRealtime();
});

})();
