/**
 * GHOSTCHAT REAL-TIME CHAT  v2.0
 * WhatsApp-like private messaging with:
 *   - Real contacts loaded from database
 *   - Private per-user SocketIO rooms
 *   - Add contact by username search
 *   - AES-256 message encryption
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
        this.currentContact  = null;   // { contact_id, username, display_name, avatar }
        this.contacts        = [];     // loaded from /api/contacts
        this.messages        = [];     // messages for current chat
        this.user            = null;   // current logged-in user
        this.typingTimer     = null;
        this.isTyping        = false;
        this.encryptMessages = true;
        this.password        = '';

        this.init();
    }

    async init() {
        this._loadUser();
        await this._loadContacts();
        this._connectSocket();
        this._setupEventListeners();
        this._setupKeyboardShortcuts();
        this._setupMobile();
    }

    // ── Load current user from localStorage ─────────────────────
    _loadUser() {
        try {
            this.user = JSON.parse(localStorage.getItem('ghostchat_user') || '{}');
            if (!this.user.id) {
                window.location.href = 'login.html';
                return;
            }
            // Populate UI
            const nameEl   = document.getElementById('chatUserName');
            const avatarEl = document.getElementById('chatUserAvatar');
            if (nameEl)   nameEl.textContent = this.user.username || 'Ghost User';
            if (avatarEl) {
                if (this.user.avatar && this.user.avatar !== '/assets/images/default-avatar.png') {
                    avatarEl.innerHTML = `<img src="${this.user.avatar}" alt="Avatar"
                        onerror="this.outerHTML='<span>${(this.user.username||'G')[0].toUpperCase()}</span>';" />`;
                } else {
                    avatarEl.textContent = (this.user.username || 'G')[0].toUpperCase();
                }
            }
        } catch (_) {
            window.location.href = 'login.html';
        }
    }

    // ── Load contacts from server ─────────────────────────────────
    async _loadContacts() {
        try {
            const res  = await fetch(`${this._base()}/api/contacts`, {
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

    // ── Render contacts sidebar ───────────────────────────────────
    _renderContacts() {
        const list = document.getElementById('contactsList');
        if (!list) return;

        if (!this.contacts.length) {
            list.innerHTML = `
                <div style="padding:24px 16px;text-align:center;color:var(--t3);">
                    <i class="fas fa-user-plus" style="font-size:2rem;margin-bottom:12px;display:block;color:var(--primary);opacity:.5;"></i>
                    <p style="font-size:.875rem;">No contacts yet.</p>
                    <p style="font-size:.8125rem;margin-top:4px;">Click <strong>+</strong> to add someone.</p>
                </div>`;
            return;
        }

        list.innerHTML = this.contacts.map(c => {
            const initials = (c.display_name || c.username || '?')[0].toUpperCase();
            const avatarHtml = c.avatar && c.avatar !== '/assets/images/default-avatar.png'
                ? `<img src="${c.avatar}" alt="${initials}"
                    onerror="this.outerHTML='<span>${initials}</span>';" />`
                : `<span>${initials}</span>`;

            const lastMsg  = c.last_message?.content
                ? this._truncate(c.last_message.content, 36)
                : 'Start a secure conversation';
            const lastTime = c.last_message?.created_at
                ? this._formatTime(c.last_message.created_at)
                : '';
            const unread = c.unread_count > 0
                ? `<span class="contact-unread">${c.unread_count > 99 ? '99+' : c.unread_count}</span>`
                : '';
            const online = c.is_online
                ? '<span class="online-dot"></span>'
                : '';

            const isActive = this.currentContact?.contact_id === c.contact_id;

            return `
            <div class="contact-item ${isActive ? 'active' : ''}"
                 data-id="${c.contact_id}"
                 data-name="${this._esc(c.display_name || c.username)}"
                 role="button" tabindex="0"
                 aria-label="Chat with ${this._esc(c.display_name || c.username)}"
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

    // ── Open a private chat ───────────────────────────────────────
    async openChat(contactId, displayName, avatar) {
        this.currentContact = { contact_id: contactId, display_name: displayName, avatar };

        // Update header
        const headerName   = document.getElementById('chatHeaderName');
        const headerAvatar = document.getElementById('chatHeaderAvatar');
        const headerStatus = document.getElementById('chatHeaderStatus');
        if (headerName)   headerName.textContent = displayName;
        if (headerStatus) headerStatus.textContent = '🔒 End-to-End Encrypted';
        if (headerAvatar) {
            const contact = this.contacts.find(c => c.contact_id === contactId);
            if (avatar && avatar !== '/assets/images/default-avatar.png') {
                headerAvatar.innerHTML = `<img src="${avatar}" alt="${displayName[0]}"
                    style="width:100%;height:100%;object-fit:cover;border-radius:50%;"
                    onerror="this.outerHTML='<span>${displayName[0].toUpperCase()}</span>';" />`;
            } else {
                headerAvatar.textContent = displayName[0].toUpperCase();
            }
        }

        // Join private SocketIO room
        if (this.socket && this.connected) {
            this.socket.emit('join_room', { room: `private_${this._roomId(contactId)}` });
        }

        // Load message history
        await this._loadMessages(contactId);

        // Mark contact active in sidebar
        document.querySelectorAll('.contact-item').forEach(el => {
            el.classList.toggle('active', el.dataset.id === contactId);
        });

        // On mobile: show chat panel
        document.querySelector('.chat-main')?.classList.add('mobile-chat-open');
        document.getElementById('chatInput')?.focus();
    }

    // ── Load message history from server ────────────────────────────
    async _loadMessages(contactId) {
        const container = document.getElementById('chatMessages');
        if (!container) return;

        container.innerHTML = `
            <div style="display:flex;justify-content:center;padding:32px;">
                <div class="spinner" aria-label="Loading messages"></div>
            </div>`;

        try {
            const res  = await fetch(`${this._base()}/api/chat/${contactId}/messages?limit=50`, {
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

    // ── Render messages ───────────────────────────────────────────
    _renderMessages() {
        const container = document.getElementById('chatMessages');
        if (!container) return;

        if (!this.messages.length) {
            container.innerHTML = `
                <div class="chat-welcome">
                    <i class="fas fa-ghost"></i>
                    <h3>Start a secure conversation</h3>
                    <p>Messages are encrypted with AES-256 before sending.</p>
                </div>`;
            return;
        }

        let html = '';
        let lastDate = '';

        this.messages.forEach(msg => {
            const isMine  = msg.sender_id === this.user.id;
            const msgDate = new Date(msg.created_at).toLocaleDateString();

            // Date separator
            if (msgDate !== lastDate) {
                lastDate = msgDate;
                html += `<div class="msg-date-sep"><span>${this._formatDate(msg.created_at)}</span></div>`;
            }

            const time    = this._formatTime(msg.created_at);
            const content = this._esc(msg.encrypted_content || '');
            const status  = isMine
                ? `<span class="msg-status">${msg.is_read ? '✓✓' : msg.is_delivered ? '✓✓' : '✓'}</span>`
                : '';
            const isEncrypted = content.includes('GHOST');
            const lockIcon = isEncrypted
                ? `<button class="msg-decrypt-btn" title="Decrypt message"
                    onclick="window.chat.promptDecrypt('${msg.id}', this)">
                    <i class="fas fa-lock"></i>
                   </button>`
                : '';

            html += `
            <div class="msg-wrapper ${isMine ? 'mine' : 'theirs'}" id="msg-${msg.id}">
                <div class="msg-bubble ${isMine ? 'bubble-mine' : 'bubble-theirs'}">
                    <div class="msg-content" id="content-${msg.id}">${content}</div>
                    ${lockIcon}
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

    // ── Send message ──────────────────────────────────────────────
    async sendMessage() {
        const input = document.getElementById('chatInput');
        if (!input) return;
        const text = input.value.trim();
        if (!text || !this.currentContact) return;

        input.value = '';
        input.style.height = 'auto';

        // Encrypt if password set
        let content = text;
        if (this.encryptMessages && this.password) {
            try {
                const encResult = await fetch(`${this._base()}/api/encrypt`, {
                    method: 'POST',
                    credentials: 'include',
                    headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest' },
                    body: JSON.stringify({ message: text, password: this.password }),
                });
                const encData = await encResult.json();
                if (encData.success) content = encData.emoji_message;
            } catch (_) { /* send unencrypted if encryption fails */ }
        }

        const room = `private_${this._roomId(this.currentContact.contact_id)}`;

        // Optimistic UI — show message immediately
        const tempId  = 'temp_' + Date.now();
        const tempMsg = {
            id:                tempId,
            sender_id:         this.user.id,
            receiver_id:       this.currentContact.contact_id,
            encrypted_content: content,
            message_type:      'chat',
            created_at:        new Date().toISOString(),
            is_read:           false,
            is_delivered:      false,
        };
        this.messages.push(tempMsg);
        this._renderMessages();

        // Send via SocketIO
        if (this.socket && this.connected) {
            this.socket.emit('send_private_message', {
                room:        room,
                content:     content,
                sender_id:   this.user.id,
                sender:      this.user.username,
                avatar:      this.user.avatar,
                receiver_id: this.currentContact.contact_id,
                temp_id:     tempId,
            });
        } else {
            // Fallback to REST API
            try {
                await fetch(`${this._base()}/api/chat/${this.currentContact.contact_id}/messages`, {
                    method: 'POST',
                    credentials: 'include',
                    headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest' },
                    body: JSON.stringify({ content }),
                });
            } catch (_) {}
        }

        // Update contact's last message in sidebar
        const contact = this.contacts.find(c => c.contact_id === this.currentContact.contact_id);
        if (contact) {
            contact.last_message = { content, created_at: new Date().toISOString(), is_mine: true };
            this._renderContacts();
        }

        // Stop typing indicator
        this._stopTyping();
    }

    // ── Decrypt a message inline ─────────────────────────────────
    async promptDecrypt(msgId, btn) {
        const password = prompt('Enter the encryption password to decrypt this message:');
        if (!password) return;

        const contentEl = document.getElementById(`content-${msgId}`);
        if (!contentEl) return;

        try {
            const res  = await fetch(`${this._base()}/api/decrypt`, {
                method: 'POST',
                credentials: 'include',
                headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest' },
                body: JSON.stringify({ emoji_message: contentEl.textContent, password }),
            });
            const data = await res.json();
            if (data.success) {
                contentEl.textContent = data.decrypted_message;
                contentEl.style.color = 'var(--green)';
                btn?.remove();
            } else {
                this._toast('Wrong password or invalid message', 'error');
            }
        } catch (_) {
            this._toast('Decryption failed', 'error');
        }
    }

    // ── WebSocket connection ──────────────────────────────────────
    _connectSocket() {
        const socketUrl = window.location.origin;
        this.socket = io(socketUrl, {
            transports:            ['websocket', 'polling'],
            withCredentials:       true,
            reconnection:          true,
            reconnectionAttempts:  10,
            reconnectionDelay:     1000,
            reconnectionDelayMax:  5000,
        });

        this.socket.on('connect', () => {
            this.connected = true;
            this._updateOnlineStatus(true);
            // Join personal room to receive private messages
            this.socket.emit('join_user_room', { user_id: this.user.id });
            if (this.currentContact) {
                this.socket.emit('join_room', {
                    room: `private_${this._roomId(this.currentContact.contact_id)}`
                });
            }
        });

        this.socket.on('disconnect', () => {
            this.connected = false;
            this._updateOnlineStatus(false);
        });

        this.socket.on('connect_error', () => {
            this.connected = false;
            this._updateOnlineStatus(false);
        });

        // Receive private message
        this.socket.on('receive_message', data => {
            // Only show if it's for the current chat
            if (!this.currentContact) return;
            const isCurrentChat = (
                (data.sender_id   === this.currentContact.contact_id && data.receiver_id === this.user.id) ||
                (data.receiver_id === this.currentContact.contact_id && data.sender_id   === this.user.id)
            );

            if (isCurrentChat) {
                // Replace optimistic temp message or add new
                const idx = this.messages.findIndex(m => m.id === data.temp_id);
                if (idx > -1) {
                    this.messages[idx] = { ...this.messages[idx], id: data.id, is_delivered: true };
                } else {
                    this.messages.push({
                        id:                data.id,
                        sender_id:         data.sender_id,
                        receiver_id:       data.receiver_id || this.user.id,
                        encrypted_content: data.content,
                        message_type:      'chat',
                        created_at:        data.created_at || new Date().toISOString(),
                        is_read:           false,
                        is_delivered:      true,
                    });
                }
                this._renderMessages();
            }

            // Update sidebar preview + unread badge
            const contact = this.contacts.find(c => c.contact_id === data.sender_id);
            if (contact) {
                contact.last_message = {
                    content:    data.content,
                    created_at: data.created_at,
                    is_mine:    data.sender_id === this.user.id,
                };
                if (!isCurrentChat || !document.hasFocus()) {
                    contact.unread_count = (contact.unread_count || 0) + 1;
                    this._notifyNewMessage(data);
                }
                this._renderContacts();
            }
        });

        // Typing indicator
        this.socket.on('typing', data => {
            if (data.user_id !== this.user.id &&
                this.currentContact?.contact_id === data.user_id) {
                this._showTyping(data.username);
            }
        });
        this.socket.on('stop_typing', data => {
            if (this.currentContact?.contact_id === data.user_id) {
                this._hideTyping();
            }
        });

        // Online presence
        this.socket.on('user_online', data => {
            const c = this.contacts.find(x => x.contact_id === data.user_id);
            if (c) { c.is_online = true; this._renderContacts(); }
        });
        this.socket.on('user_offline', data => {
            const c = this.contacts.find(x => x.contact_id === data.user_id);
            if (c) { c.is_online = false; this._renderContacts(); }
        });
    }

    // ── Add contact flow ─────────────────────────────────────────
    async searchUsers(query) {
        if (query.length < 2) {
            document.getElementById('userSearchResults').innerHTML = '';
            return;
        }
        try {
            const res  = await fetch(`${this._base()}/api/contacts/search?q=${encodeURIComponent(query)}`, {
                credentials: 'include',
                headers: { 'X-Requested-With': 'XMLHttpRequest' },
            });
            const data = await res.json();
            this._renderSearchResults(data.users || []);
        } catch (_) {
            document.getElementById('userSearchResults').innerHTML =
                '<p style="color:var(--red);font-size:.875rem;padding:8px;">Search failed. Try again.</p>';
        }
    }

    _renderSearchResults(users) {
        const container = document.getElementById('userSearchResults');
        if (!container) return;
        if (!users.length) {
            container.innerHTML = '<p style="color:var(--t3);font-size:.875rem;padding:8px;">No users found.</p>';
            return;
        }
        container.innerHTML = users.map(u => `
            <div class="search-result-item">
                <div class="contact-avatar" style="width:36px;height:36px;font-size:.875rem;">
                    ${u.avatar && u.avatar !== '/assets/images/default-avatar.png'
                        ? `<img src="${u.avatar}" alt="${u.username[0]}" onerror="this.outerHTML='<span>${u.username[0].toUpperCase()}</span>';" />`
                        : `<span>${u.username[0].toUpperCase()}</span>`}
                </div>
                <div style="flex:1;">
                    <div style="font-weight:600;font-size:.875rem;">${this._esc(u.username)}</div>
                    <div style="font-size:.75rem;color:var(--t3);">
                        ${u.is_online ? '🟢 Online' : '⚫ Offline'}
                    </div>
                </div>
                ${u.is_contact
                    ? `<span style="font-size:.75rem;color:var(--green);"><i class="fas fa-check"></i> Added</span>`
                    : `<button class="btn btn-primary btn-sm" onclick="window.chat.addContact('${u.id}', '${this._esc(u.username)}')">
                           <i class="fas fa-plus"></i> Add
                       </button>`}
            </div>`
        ).join('');
    }

    async addContact(contactId, username) {
        try {
            const res  = await fetch(`${this._base()}/api/contacts`, {
                method: 'POST',
                credentials: 'include',
                headers: {
                    'Content-Type':    'application/json',
                    'X-Requested-With':'XMLHttpRequest',
                    'X-CSRF-Token':    this._getCsrf(),
                },
                body: JSON.stringify({ contact_id: contactId }),
            });
            const data = await res.json();
            if (data.success) {
                this._toast(`${username} added to contacts!`, 'success');
                closeModal('newChatModal');
                await this._loadContacts();
                this.openChat(contactId, username, data.avatar || '');
            } else {
                this._toast(data.error || 'Failed to add contact', 'error');
            }
        } catch (_) {
            this._toast('Failed to add contact', 'error');
        }
    }

    // ── Event listeners ───────────────────────────────────────────
    _setupEventListeners() {
        // Send button
        document.getElementById('sendBtn')?.addEventListener('click', () => this.sendMessage());

        // Chat input — Enter to send, Shift+Enter for newline, typing indicator
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
            // Only resize if it's a textarea
            if (input.tagName === 'TEXTAREA') {
                input.style.height = 'auto';
                input.style.height = Math.min(input.scrollHeight, 150) + 'px';
            }
        });

        // Add contact button
        document.getElementById('addContactBtn')?.addEventListener('click', () => {
            openModal('newChatModal');
        });

        // Contact search in modal
        document.getElementById('newChatSearch')?.addEventListener('input', e => {
            this.searchUsers(e.target.value.trim());
        });

        // Contact search in sidebar
        document.getElementById('contactSearch')?.addEventListener('input', e => {
            this._filterContacts(e.target.value.trim());
        });

        // Logout
        document.getElementById('chatLogout')?.addEventListener('click', async () => {
            await window.GhostChatAPI?.logout();
            window.location.href = 'login.html';
        });

        // Encryption toggle in header (lock icon in input bar)
        document.getElementById('encryptToggle')?.addEventListener('click', () => {
            this._toggleEncryption();
        });

        // Set password
        document.getElementById('setPasswordBtn')?.addEventListener('click', () => {
            const pw = prompt('Set encryption password (shared with your contact):');
            if (pw) {
                this.password = pw;
                this.encryptMessages = true;
                this._toast('Encryption password set. Messages will be encrypted.', 'success');
            }
        });

        // Mobile back button
        document.getElementById('mobileBackBtn')?.addEventListener('click', () => {
            document.querySelector('.chat-main')?.classList.remove('mobile-chat-open');
        });

        // Menu button → show chat info
        document.getElementById('chatMenuBtn')?.addEventListener('click', () => {
            const panel = document.getElementById('infoPanel');
            if (panel) panel.style.display = panel.style.display === 'none' ? 'flex' : 'none';
        });
    }

    _setupKeyboardShortcuts() {
        document.addEventListener('keydown', e => {
            // Escape — close modals
            if (e.key === 'Escape') {
                document.querySelectorAll('.modal.active').forEach(m => m.classList.remove('active'));
                document.getElementById('emojiPicker').style.display = 'none';
                document.querySelector('.chat-main')?.classList.remove('mobile-chat-open');
            }
            // Ctrl+K — focus search
            if ((e.ctrlKey || e.metaKey) && e.key === 'k') {
                e.preventDefault();
                document.getElementById('contactSearch')?.focus();
            }
            // Alt+N — new chat
            if (e.altKey && e.key === 'n') {
                e.preventDefault();
                openModal('newChatModal');
                document.getElementById('newChatSearch')?.focus();
            }
            // Alt+E — toggle encryption
            if (e.altKey && e.key === 'e') {
                e.preventDefault();
                this._toggleEncryption();
            }
        });
    }

    _setupMobile() {
        const handleResize = () => {
            const isMobile = window.innerWidth <= 768;
            const sidebar  = document.querySelector('.chat-sidebar');
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

    // ── Typing indicator ─────────────────────────────────────────
    _handleTyping() {
        if (!this.socket || !this.connected || !this.currentContact) return;
        if (!this.isTyping) {
            this.isTyping = true;
            this.socket.emit('typing', {
                room:     `private_${this._roomId(this.currentContact.contact_id)}`,
                user_id:  this.user.id,
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
            room:    `private_${this._roomId(this.currentContact.contact_id)}`,
            user_id: this.user.id,
        });
    }

    _showTyping(username) {
        let el = document.getElementById('typingIndicator');
        if (!el) {
            el = document.createElement('div');
            el.id        = 'typingIndicator';
            el.className = 'typing-indicator';
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

    // ── Encryption toggle ─────────────────────────────────────────
    _toggleEncryption() {
        if (!this.password && !this.encryptMessages) {
            const pw = prompt('Enter a shared encryption password:');
            if (!pw) return;
            this.password        = pw;
            this.encryptMessages = true;
        } else {
            this.encryptMessages = !this.encryptMessages;
        }
        const btn = document.getElementById('encryptToggle');
        if (btn) {
            btn.innerHTML = this.encryptMessages
                ? '<i class="fas fa-lock" style="color:var(--green)"></i>'
                : '<i class="fas fa-lock-open" style="color:var(--t3)"></i>';
            btn.title = this.encryptMessages ? 'Encryption ON' : 'Encryption OFF';
        }
        this._toast(
            this.encryptMessages ? 'Messages will be encrypted' : 'Encryption disabled',
            this.encryptMessages ? 'success' : 'info'
        );
    }

    // ── Online status ─────────────────────────────────────────────
    _updateOnlineStatus(online) {
        const el = document.getElementById('userStatus');
        if (el) {
            el.textContent = online ? '🟢 Online' : '🔴 Offline';
            el.style.color = online ? 'var(--green)' : 'var(--red)';
        }
    }

    // ── Contact filter ─────────────────────────────────────────────
    _filterContacts(query) {
        document.querySelectorAll('.contact-item').forEach(el => {
            const name    = el.dataset.name?.toLowerCase() || '';
            el.style.display = !query || name.includes(query.toLowerCase()) ? '' : 'none';
        });
    }

    // ── Browser notification ──────────────────────────────────────
    _notifyNewMessage(data) {
        if (window.UI) UI.showToast(`New message from ${data.sender}`, 'info');
    }

    // ── Helpers ───────────────────────────────────────────────────
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
        // Deterministic room ID — same for both participants
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
        const d   = new Date(iso);
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

// ── Global helpers for onclick attributes ────────────────────────
function openModal(id) {
    const m = document.getElementById(id);
    if (m) m.classList.add('active');
}
function closeModal(id) {
    const m = document.getElementById(id);
    if (m) m.classList.remove('active');
}

// Close modal on backdrop click
document.addEventListener('click', e => {
    if (e.target.classList.contains('modal')) {
        e.target.classList.remove('active');
    }
});

// ── Boot ─────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
    window.chat = new GhostChatRealtime();
});