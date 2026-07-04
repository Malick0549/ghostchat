/**
 * GHOSTCHAT REAL-TIME CHAT  v2.0
 * WhatsApp-like private messaging with:
 *   - Real contacts loaded from database
 *   - Private per-user SocketIO rooms
 *   - Add contact by username search (with approval)
 *   - AES-256 message encryption (emoji format)
 *   - Online/offline presence
 *   - Typing indicators
 *   - Read receipts
 *   - Message history from DB
 *   - Keyboard shortcuts
 */

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
        this._pendingIncoming = [];   // incoming connection requests awaiting my confirmation
        this.decryptData = {};

        this.init();
    }

    async init() {
        this._loadUser();
        await this._loadContacts();
        this._connectSocket();
        this._setupEventListeners();
        this._setupKeyboardShortcuts();
        this._setupMobile();
        await this._loadPendingRequests();
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
            const res = await fetch(`${this._base()}/api/contacts`, {
                credentials: 'include',
                headers: { 'X-Requested-With': 'XMLHttpRequest' },
            });
            const data = await res.json();
            if (data.success) {
                this.contacts = data.contacts || [];
            }
        } catch (_) {
            this.contacts = [];
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

    async openChat(contactId, displayName, avatar) {
        this.currentContact = { contact_id: contactId, display_name: displayName, avatar };

        const headerName = document.getElementById('chatHeaderName');
        const headerAvatar = document.getElementById('chatHeaderAvatar');
        const headerStatus = document.getElementById('chatHeaderStatus');
        if (headerName) headerName.textContent = displayName;
        if (headerStatus) headerStatus.textContent = '🔒 End-to-End Encrypted';
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
            const res = await fetch(`${this._base()}/api/chat/${contactId}/messages?limit=50`, {
                credentials: 'include',
                headers: { 'X-Requested-With': 'XMLHttpRequest' },
            });
            const data = await res.json();
            this.messages = data.messages || [];
        } catch (_) {
            this.messages = [];
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
            const content = this._esc(msg.encrypted_content || '');
            const status = isMine ? `<span class="msg-status">${msg.is_read ? '✓✓' : msg.is_delivered ? '✓✓' : '✓'}</span>` : '';
            
            const isEncrypted = /[\u{1F000}-\u{1FFFF}]|[\u2600-\u27BF]|[\u{1F300}-\u{1F5FF}]/u.test(content) && content.length > 10;

            html += `
            <div class="msg-wrapper ${isMine ? 'mine' : 'theirs'}" id="msg-${msg.id}">
                <div class="msg-bubble ${isMine ? 'bubble-mine' : 'bubble-theirs'}">
                    <div class="msg-content" id="content-${msg.id}">
                        ${isEncrypted ? '🔒 ' : ''}${content}
                    </div>
                    ${isEncrypted ? `
                        <button class="msg-decrypt-btn" onclick="window.chat.decryptMessage('${msg.id}')">
                            <i class="fas fa-lock"></i> Decrypt
                        </button>
                    ` : ''}
                    <div class="msg-meta">
                        <span class="msg-time">${time}</span>
                        ${status}
                    </div>
                </div>
            </div>`;
            
            if (isEncrypted) {
                this.decryptData[msg.id] = content;
            }
        });

        container.innerHTML = html;
        this._scrollToBottom();
    }

    async decryptMessage(msgId) {
        const password = prompt('Enter the encryption password to decrypt this message:');
        if (!password) return;

        const contentEl = document.getElementById(`content-${msgId}`);
        if (!contentEl) return;

        const encryptedContent = this.decryptData?.[msgId] || contentEl.textContent.replace('🔒 ', '');

        try {
            const res = await fetch(`${this._base()}/api/decrypt`, {
                method: 'POST',
                credentials: 'include',
                headers: { 
                    'Content-Type': 'application/json', 
                    'X-Requested-With': 'XMLHttpRequest',
                    'X-CSRF-Token': this._getCsrf(),   // ── FIX: was missing, every decrypt call got 403'd by CSRF middleware ──
                },
                body: JSON.stringify({ 
                    emoji_message: encryptedContent, 
                    password: password 
                }),
            });
            const data = await res.json();
            
            if (data.success) {
                contentEl.innerHTML = `<span style="color:var(--green);">🔓 ${this._esc(data.decrypted_message)}</span>`;
                const btn = contentEl.parentElement.querySelector('.msg-decrypt-btn');
                if (btn) btn.remove();
                this._toast('Message decrypted!', 'success');
            } else {
                this._toast('Wrong password or invalid message', 'error');
            }
        } catch (_) {
            this._toast('Decryption failed', 'error');
        }
    }

    async sendMessage() {
        const input = document.getElementById('chatInput');
        if (!input) return;
        const text = input.value.trim();
        if (!text || !this.currentContact) return;

        input.value = '';
        input.style.height = 'auto';

        let content = text;

        // Encrypt only if encryption is ON and password is set
        // If no password is set, send as plain text (user can enable later)
        if (this.encryptMessages && this.password) {
            try {
                const encResult = await fetch(`${this._base()}/api/encrypt`, {
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
                });
                const encData = await encResult.json();
                if (encData.success) {
                    content = encData.emoji_message;
                } else {
                    // Encryption failed — send as plain text with warning
                    this._toast('Encryption failed — sending as plain text', 'info');
                }
            } catch (_) {
                this._toast('Encryption unavailable — sending as plain text', 'info');
            }
        }
        // No else-block: if no password set, just send plain text normally

        const roomId = `private_${this._roomId(this.currentContact.contact_id)}`;

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

        if (this.socket && this.connected) {
            console.log('Sending message to room:', roomId);
            this.socket.emit('send_private_message', {
                room: roomId,
                content: content,
                sender_id: this.user.id,
                sender: this.user.username,
                avatar: this.user.avatar || '',
                receiver_id: this.currentContact.contact_id,
                temp_id: tempId,
            });
        } else {
            console.warn('Socket not connected, using REST fallback');
            try {
                const res = await fetch(`${this._base()}/api/chat/${this.currentContact.contact_id}/messages`, {
                    method: 'POST',
                    credentials: 'include',
                    headers: { 
                        'Content-Type': 'application/json', 
                        'X-Requested-With': 'XMLHttpRequest',
                        'X-CSRF-Token': this._getCsrf(),   // ── FIX: was missing, caused 403 on every fallback send ──
                    },
                    body: JSON.stringify({ content }),
                });
                if (!res.ok) {
                    const errData = await res.json().catch(() => ({}));
                    throw new Error(errData.error || `HTTP ${res.status}`);
                }
                const data = await res.json();
                // The REST path doesn't get a socket ack back, so replace the
                // optimistic temp message with the real saved one directly here.
                const idx = this.messages.findIndex(m => m.id === tempId);
                if (idx > -1 && data.message) {
                    this.messages[idx] = { ...this.messages[idx], id: data.message.id, is_delivered: true };
                    this._renderMessages();
                }
            } catch (error) {
                console.error('REST fallback failed:', error);
                this._toast('Failed to send message', 'error');
            }
        }

        const contact = this.contacts.find(c => c.contact_id === this.currentContact.contact_id);
        if (contact) {
            contact.last_message = { content, created_at: new Date().toISOString(), is_mine: true };
            this._renderContacts();
        }

        this._stopTyping();
    }

    _connectSocket() {
        const socketUrl = window.location.origin;
        
        try {
            this.socket = io(socketUrl, {
                // ── FIX: 'websocket' first meant the client only ever attempted
                // a raw WebSocket handshake and kept retrying that same transport
                // on every reconnect. Railway's edge was refusing/dropping it
                // (NS_ERROR_WEBSOCKET_CONNECTION_REFUSED), so the socket never
                // connected at all. Polling-first does the initial handshake over
                // plain HTTP (works through virtually any proxy), then upgrades
                // to WebSocket only if that succeeds — and just keeps using
                // polling if it doesn't. ──
                transports: ['polling', 'websocket'],
                withCredentials: true,
                reconnection: true,
                reconnectionAttempts: 10,
                reconnectionDelay: 1000,
                reconnectionDelayMax: 5000,
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

            this.socket.on('typing', data => {
                if (data.user_id !== this.user.id && this.currentContact?.contact_id === data.user_id) {
                    this._showTyping(data.username);
                }
            });
            this.socket.on('stop_typing', data => {
                if (this.currentContact?.contact_id === data.user_id) {
                    this._hideTyping();
                }
            });

            this.socket.on('user_online', data => {
                const c = this.contacts.find(x => x.contact_id === data.user_id);
                if (c) { c.is_online = true;
                    this._renderContacts(); }
            });
            this.socket.on('user_offline', data => {
                const c = this.contacts.find(x => x.contact_id === data.user_id);
                if (c) { c.is_online = false;
                    this._renderContacts(); }
            });

            // ── FIX: these now come from the SERVER (emitted by the backend
            // when a request is sent/accepted/rejected), not from the other
            // client directly — the old client-to-client emits had no backend
            // handler and never reached anyone. ──
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
        // ── FIX: this used to `return` immediately when no chat was open at all,
        // which meant the sidebar preview/unread badge never updated and the
        // message appeared to vanish until the page was reloaded. Now the
        // sidebar always updates; only the open message thread is conditional. ──
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
                    message_type: 'chat',
                    created_at: data.created_at || new Date().toISOString(),
                    is_read: false,
                    is_delivered: true,
                });
            }
            this._renderMessages();
            if (data.sender_id !== this.user.id) this._notifyNewMessage(data);
        }

        // Sidebar preview/unread — runs regardless of which chat is open
        if (data.sender_id !== this.user.id) {
            const contact = this.contacts.find(c => c.contact_id === data.sender_id);
            if (contact) {
                contact.last_message = {
                    content: data.content,
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

    // ── FIX: pending requests now live on the server (Contact.status),
    // not localStorage, so they survive across devices/browsers and are
    // visible to the invited user even if they were offline when it was sent. ──
    async _loadPendingRequests() {
        try {
            const res = await fetch(`${this._base()}/api/contacts/requests`, {
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
            const res = await fetch(`${this._base()}/api/contacts/${contactId}/respond`, {
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
            this._toast('Action failed', 'error');
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
                    const tokenRes = await fetch('/api/csrf-token', {
                        credentials: 'include',
                        headers: { 'X-Requested-With': 'XMLHttpRequest' }
                    });
                    const tokenData = await tokenRes.json();
                    csrfToken = tokenData.csrf_token;
                } catch (tokenError) {
                    console.error('Failed to fetch CSRF token:', tokenError);
                }
            }
            
            const res = await fetch(`${this._base()}/api/contacts/search?q=${encodeURIComponent(query)}`, {
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
                '<div style="padding:20px;text-align:center;color:var(--red);font-size:.875rem;">Search failed. Please try again.</div>';
        }
    }

    // ── FIX: Render search results with visible, clickable buttons ──
_renderSearchResults(users) {
    const container = document.getElementById('userSearchResults');
    if (!container) return;
    
    if (!users.length) {
        container.innerHTML = '<div class="no-results"><i class="fas fa-search" style="display:block;font-size:1.5rem;margin-bottom:8px;opacity:0.5;"></i>No users found. Try a different search.</div>';
        return;
    }
    
    container.innerHTML = users.map(u => {
        const isContact = u.is_contact || false;
        const isPending = u.is_pending || false;     // request you sent, awaiting them
        const isIncoming = u.is_incoming || false;   // they asked you — go accept it

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
    // ── FIX: sends a real request and stops there — no more instant mutual-add.
    // The chat only opens once the other person has confirmed via respondRequest(). ──
    async sendFriendRequest(userId, username) {
        try {
            const res = await fetch(`${this._base()}/api/contacts`, {
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
                    // They had already requested you — this confirmed it immediately
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
            this._toast('Failed to send request', 'error');
        }
    }

    // ── FIX: no more confirm()-dialog — it only worked if the recipient
    // happened to be looking at the screen the instant it arrived, and
    // blocked the whole tab while open. Requests now land in a proper
    // pending-requests panel (badge next to Add Contact) that persists
    // across reloads because it's backed by the server, not localStorage. ──
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
                        search.style.display = '';   // ── FIX: restore visibility if openPendingPanel() hid it last time ──
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

function openModal(id) {
    const m = document.getElementById(id);
    if (m) m.classList.add('active');
}
function closeModal(id) {
    const m = document.getElementById(id);
    if (m) m.classList.remove('active');
}

document.addEventListener('click', e => {
    if (e.target.classList.contains('modal')) {
        e.target.classList.remove('active');
    }
});

document.addEventListener('DOMContentLoaded', () => {
    window.chat = new GhostChatRealtime();
});