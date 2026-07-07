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

// ── FIX: this whole file used to declare `class GhostChatRealtime` directly
// in the global scope. If it ever gets loaded twice — a stray duplicate
// <script> tag, a stale cached copy served alongside the fresh one, a
// service worker re-injecting it — the second load throws a fatal
// SyntaxError ("Identifier has already been declared"), which kills ALL
// script execution on the page, including whatever hides the loading
// spinner. Wrapping everything in an IIFE with a load-guard means a second
// load is a harmless no-op instead of a page-breaking crash. ──
(function () {
    if (window.__ghostChatScriptLoaded) {
        console.warn('chat-socket.js loaded more than once — skipping re-init. ' +
                      'Check chat.html for a duplicate <script src="...chat-socket.js"> tag.');
        return;
    }
    window.__ghostChatScriptLoaded = true;

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
        this._plainData = {};    // known plaintext per message id (originally-plain or decrypted)
        this._msgViewState = {}; // 'plain' | 'encrypted' — manual toggle overrides the default

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

    // ── FIX: single source of truth for the header status line so presence
    // and typing updates both route through it instead of one hardcoded string. ──
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

        const headerName = document.getElementById('chatHeaderName');
        const headerAvatar = document.getElementById('chatHeaderAvatar');
        if (headerName) headerName.textContent = displayName;
        this._renderHeaderStatus(contactId);   // ── FIX: was hardcoded to "End-to-End Encrypted" and never updated ──
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
            const status = isMine ? (
                msg.is_read
                    ? '<span class="msg-status read">✓✓</span>'
                    : msg.is_delivered
                        ? '<span class="msg-status delivered">✓✓</span>'
                        : '<span class="msg-status sent">✓</span>'
            ) : '';

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
                        <div class="msg-crypto-actions">
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

            // Remember the raw ciphertext / plaintext the first time we see this message
            if (looksEncrypted && !(msg.id in this.decryptData)) {
                this.decryptData[msg.id] = rawContent;
            }
            if (!looksEncrypted && !(msg.id in this._plainData)) {
                this._plainData[msg.id] = rawContent;
            }

            // ── FIX: view state persists across re-renders so a manual encrypt/decrypt
            // toggle sticks, instead of decrypt being a one-way reveal with no way back,
            // and plaintext messages having no way to be hidden/encrypted at all. ──
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
                    <div class="msg-crypto-actions" id="crypto-actions-${msg.id}">
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

    async decryptMessage(msgId) {
        const password = prompt('Enter the encryption password to decrypt this message:');
        if (!password) return;

        const contentEl = document.getElementById(`content-${msgId}`);
        if (!contentEl) return;

        const encryptedContent = this.decryptData?.[msgId] || contentEl.textContent.replace('🔒 ', '').trim();

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
                // ── FIX: decrypt used to be one-way (it removed the button entirely).
                // Now it keeps the plaintext around and flips the toggle so the
                // message can be re-encrypted/hidden again with one click. ──
                this._plainData[msgId] = data.decrypted_message;
                this._msgViewState[msgId] = 'plain';

                contentEl.innerHTML = `<span style="color:var(--green);">🔓 ${this._esc(data.decrypted_message)}</span>`;
                this._swapCryptoButton(msgId, 'plain');
                this._toast('Message decrypted!', 'success');
            } else {
                this._toast('Wrong password or invalid message', 'error');
            }
        } catch (_) {
            this._toast('Decryption failed', 'error');
        }
    }

    // ── FIX: lets a message be locked back up after decrypting, or lets a
    // message that was sent as plain text be encrypted for on-screen display.
    // Uses the same /api/encrypt endpoint sendMessage() already relies on. ──
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
            const res = await fetch(`${this._base()}/api/encrypt`, {
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
            this._toast('Encryption failed', 'error');
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
                actions.appendChild(copyBtn);
            }
        } else {
            toggleBtn.innerHTML = '<i class="fas fa-lock-open"></i> Encrypt';
            toggleBtn.setAttribute('onclick', `window.chat.encryptMessageBubble('${msgId}')`);
            document.getElementById(`crypto-copy-${msgId}`)?.remove();
        }
    }

    // ── FIX: copies the exact raw packet (no UI decoration like the 🔒 display
    // prefix) so it can be safely pasted into the Dashboard's decrypt tool —
    // manually selecting the bubble text was grabbing that prefix too, which
    // EmojiMapper can't parse and made decryption fail every time. ──
    copyRawPacket(msgId) {
        const packet = this.decryptData?.[msgId];
        if (!packet) {
            this._toast('Nothing to copy', 'error');
            return;
        }
        if (window.secureCopy) {
            window.secureCopy(packet, 0);   // 0 = don't auto-clear, this needs to survive a page navigation to the dashboard
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

    // ── Media sharing: images, video (file picker), voice notes (recorded) ──

    _mediaLimits() {
        return { image: 8 * 1024 * 1024, audio: 15 * 1024 * 1024, video: 40 * 1024 * 1024 };
    }

    async _uploadMedia(file, mediaType) {
        if (!this.currentContact) {
            this._toast('Open a chat first', 'error');
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
            const res = await fetch(`${this._base()}/api/chat/${this.currentContact.contact_id}/media`, {
                method: 'POST',
                credentials: 'include',
                headers: {
                    'X-Requested-With': 'XMLHttpRequest',
                    'X-CSRF-Token': this._getCsrf(),
                },
                body: form,
            });
            const data = await res.json();
            if (!res.ok || !data.success) {
                this._toast(data.error || `Failed to send ${mediaType}`, 'error');
                return;
            }
            // The socket 'receive_message' event (emitted server-side to both
            // personal rooms) handles rendering — including for our own tab —
            // so nothing else to do here on success.
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
                // ── FIX: without this, messages received while the chat is
                // already open never get marked read/logged server-side —
                // get_chat_messages() only does that on a fresh chat open. ──
                this.socket?.emit('mark_read', { contact_id: data.sender_id });
            }
        }

        // Sidebar preview/unread — runs regardless of which chat is open
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

    // ── Forward a message (text or media) to another contact ──
    openForwardPicker(msgId) {
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
            const res = await fetch(`${this._base()}/api/messages/${msgId}/forward`, {
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
            this._toast('Forward failed', 'error');
        }
        this._forwardingMsgId = null;
    }

    // ── Delete a message — "for me" hides it only in your own view;
    // "for everyone" (sender only) erases it for both sides. ──
    // ── FIX: the old confirm() dialog only had OK/Cancel, so "Cancel" was
    // silently treated as "delete for me" — there was no way to actually
    // back out of deleting at all. This shows a real 3-option picker. ──
    async deleteMessage(msgId, isMine) {
        const scope = await this._showDeleteChoice(isMine);
        if (!scope) return;   // true Cancel — nothing happens

        try {
            const res = await fetch(`${this._base()}/api/chat/messages/${msgId}?scope=${scope}`, {
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
            this._toast('Delete failed', 'error');
        }
    }

    // ── Small custom overlay with real Delete-for-everyone / Delete-for-me /
    // Cancel options — resolves to a scope string ('everyone'|'me') or null
    // if the user backs out via Cancel or clicking outside. ──
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

    // ── Small custom toast with an actual Undo button — the shared UI.showToast
    // helper is plain text/no-action, so this is a lightweight one-off for
    // exactly this case. Auto-dismisses after 5s if not clicked. ──
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
            const res = await fetch(`${this._base()}/api/chat/messages/${msgId}/undo-delete`, {
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

        // ── Media sharing: attach menu, file pickers, voice recording ──
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

// ── FIX: these are called from raw onclick="openModal(...)" attributes in
// chat.html, which execute in global scope — being inside the IIFE now
// means they must be attached to window explicitly, or every modal
// open/close button in the HTML breaks. ──
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

// ── FIX: chat.html has an inline <script> after this file that patches
// GhostChatRealtime.prototype directly (openChat, setEncryptPassword,
// clearChat, exportChat, blockContact) — it needs the class itself as a
// global, not just the window.chat instance. ──
window.GhostChatRealtime = GhostChatRealtime;

document.addEventListener('DOMContentLoaded', () => {
    window.chat = new GhostChatRealtime();
});

})();  // end of duplicate-load guard IIFE