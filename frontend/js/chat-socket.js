/**
 * GHOSTCHAT CHAT MODULE - REAL-TIME
 * Complete WhatsApp-like chat with WebSocket
 */

class GhostChatRealtime {
    constructor() {
        this.socket = null;
        this.connected = false;
        this.currentRoom = 'room';
        this.username = '';
        this.userId = '';
        this.messages = [];
        this.contacts = {};
        this.password = '';
        this.typingTimeout = null;
        this.isTyping = false;
        this.unreadCount = 0;
        this.messageQueue = [];
        this.reconnectAttempts = 0;
        this.maxReconnectAttempts = 5;
        this.isProcessingQueue = false;
        
        this.init();
    }
    
    init() {
        this.loadUserProfile();
        this.loadContacts();
        this.loadMessages();
        this.setupEventListeners();
        this.connectToSocket();
        this.renderContacts();
        this.renderMessages();
        this.setupEmojiPicker();
        this.setupMobileResponsive();
        this.setupKeyboardShortcuts();
        this.startHeartbeat();
    }
    
    startHeartbeat() {
        setInterval(() => {
            if (this.socket && this.connected) {
                this.socket.emit('ping', { timestamp: Date.now() });
            }
        }, 30000);
    }
    
    setupKeyboardShortcuts() {
        document.addEventListener('keydown', (e) => {
            // Ctrl+Enter to send message
            if (e.ctrlKey && e.key === 'Enter') {
                e.preventDefault();
                this.sendMessage();
            }
            // Escape to close modals
            if (e.key === 'Escape') {
                document.querySelectorAll('.modal.active').forEach(modal => {
                    modal.classList.remove('active');
                });
                document.getElementById('emojiPicker').style.display = 'none';
            }
            // Ctrl+K to focus search
            if (e.ctrlKey && e.key === 'k') {
                e.preventDefault();
                const searchInput = document.getElementById('contactSearchInput');
                if (searchInput) {
                    searchInput.focus();
                }
            }
        });
    }
    
    setupMobileResponsive() {
        // Mobile back button
        const backBtn = document.getElementById('mobileBackBtn');
        if (backBtn) {
            backBtn.addEventListener('click', () => {
                document.querySelector('.chat-main').classList.toggle('mobile-chat-open');
            });
        }
        
        // Contact search
        const searchInput = document.getElementById('contactSearchInput');
        if (searchInput) {
            searchInput.addEventListener('input', (e) => {
                this.filterContacts(e.target.value);
            });
        }
        
        // Handle window resize
        window.addEventListener('resize', () => {
            this.handleMobileLayout();
        });
        this.handleMobileLayout();
    }
    
    handleMobileLayout() {
        const isMobile = window.innerWidth <= 768;
        const sidebar = document.querySelector('.chat-sidebar');
        const main = document.querySelector('.chat-main');
        
        if (isMobile) {
            sidebar.classList.add('mobile-hidden');
            main.classList.remove('mobile-chat-open');
        } else {
            sidebar.classList.remove('mobile-hidden');
            main.classList.remove('mobile-chat-open');
        }
    }
    
    filterContacts(query) {
        const container = document.getElementById('contactsList');
        const items = container.querySelectorAll('.contact-item');
        const search = query.toLowerCase().trim();
        
        items.forEach(item => {
            const name = item.querySelector('.contact-name')?.textContent?.toLowerCase() || '';
            const preview = item.querySelector('.contact-preview')?.textContent?.toLowerCase() || '';
            const match = name.includes(search) || preview.includes(search);
            item.style.display = match || !search ? '' : 'none';
        });
    }
    
    loadUserProfile() {
        try {
            const user = JSON.parse(localStorage.getItem('ghostchat_user'));
            if (user) {
                this.username = user.username || 'Ghost';
                this.userId = user.id || 'user_' + Date.now();
                document.getElementById('chatUserName').textContent = user.username || 'Ghost User';
                const avatarEl = document.getElementById('chatUserAvatar');
                const initials = ((user.firstName?.[0] || '') + (user.lastName?.[0] || user.username?.[1] || '')).toUpperCase() || 'GH';
                if (avatarEl) avatarEl.textContent = initials;
                if (user.avatar) {
                    avatarEl.innerHTML = `<img src="${user.avatar}" alt="Avatar" />`;
                }
            } else {
                // Fallback for demo
                this.username = 'GhostUser';
                this.userId = 'demo_user_' + Date.now();
            }
        } catch (_) {
            this.username = 'GhostUser';
            this.userId = 'demo_user_' + Date.now();
        }
    }
    
    loadContacts() {
        const saved = localStorage.getItem('ghostchat_contacts');
        this.contacts = saved ? JSON.parse(saved) : {
            'room': { name: 'Secure Room', messages: [], unread: 0, lastMessage: '' },
            'alice': { name: 'Alice', messages: [], unread: 0, lastMessage: '' },
            'bob': { name: 'Bob', messages: [], unread: 0, lastMessage: '' }
        };
    }
    
    saveContacts() {
        localStorage.setItem('ghostchat_contacts', JSON.stringify(this.contacts));
    }
    
    loadMessages() {
        const saved = localStorage.getItem('ghostchat_chat_messages');
        this.messages = saved ? JSON.parse(saved) : [];
    }
    
    saveMessages() {
        localStorage.setItem('ghostchat_chat_messages', JSON.stringify(this.messages));
        if (this.contacts[this.currentRoom]) {
            this.contacts[this.currentRoom].messages = this.messages;
            if (this.messages.length > 0) {
                this.contacts[this.currentRoom].lastMessage = this.messages[this.messages.length - 1].text;
            }
            this.saveContacts();
        }
    }
    
    connectToSocket() {
        const socketUrl = window.location.origin;
        this.socket = io(socketUrl, {
            transports: ['websocket', 'polling'],
            withCredentials: true,
            reconnection: true,
            reconnectionAttempts: this.maxReconnectAttempts,
            reconnectionDelay: 1000,
            reconnectionDelayMax: 5000
        });
        
        this.socket.on('connect', () => {
            console.log('✅ Connected to chat server');
            this.connected = true;
            this.reconnectAttempts = 0;
            this.updateStatus(true);
            this.joinRoom(this.currentRoom);
            this.processQueue();
            this.showToast('Connected to chat server', 'success');
        });
        
        this.socket.on('connect_error', (error) => {
            console.error('Connection error:', error);
            this.reconnectAttempts++;
            if (this.reconnectAttempts >= this.maxReconnectAttempts) {
                this.showToast('Failed to connect to server', 'error');
            }
        });
        
        this.socket.on('disconnect', () => {
            console.log('❌ Disconnected from chat server');
            this.connected = false;
            this.updateStatus(false);
            this.showToast('Disconnected from chat server', 'error');
        });
        
        this.socket.on('receive_message', (data) => {
            console.log('📨 New message received:', data);
            this.handleReceivedMessage(data);
        });
        
        this.socket.on('message_delivered', (data) => {
            this.handleMessageDelivered(data);
        });
        
        this.socket.on('message_read', (data) => {
            this.handleMessageRead(data);
        });
        
        this.socket.on('connected', (data) => {
            console.log('Server acknowledged:', data);
        });
        
        this.socket.on('joined_room', (data) => {
            console.log('Joined room:', data.room);
            this.showToast(`Joined room: ${data.room}`, 'info');
        });
        
        this.socket.on('error', (data) => {
            console.error('Server error:', data);
            this.showToast(data.message || 'Server error occurred', 'error');
        });
    }
    
    updateStatus(connected) {
        const statusEl = document.querySelector('.user-status');
        if (statusEl) {
            statusEl.textContent = connected ? '🟢 Online' : '🔴 Offline';
            statusEl.style.color = connected ? 'var(--green)' : 'var(--red)';
        }
        
        const headerStatus = document.getElementById('chatHeaderStatus');
        if (headerStatus) {
            headerStatus.textContent = connected ? '🟢 Online' : '🔴 Offline';
            headerStatus.style.color = connected ? 'var(--green)' : 'var(--red)';
        }
    }
    
    joinRoom(room) {
        if (!this.socket || !this.connected) return;
        
        if (this.currentRoom) {
            this.socket.emit('leave_room', { room: this.currentRoom });
        }
        
        this.currentRoom = room;
        this.socket.emit('join_room', { room: room });
        
        // Load messages for this room
        if (this.contacts[room]) {
            this.messages = this.contacts[room].messages || [];
            // Reset unread count for this room
            this.contacts[room].unread = 0;
            this.saveContacts();
        } else {
            this.messages = [];
        }
        this.renderMessages();
        this.updateContactBadge(room);
        
        // Update header
        const contact = this.contacts[room] || { name: room };
        document.getElementById('chatHeaderName').textContent = contact.name || room;
        document.getElementById('chatHeaderAvatar').textContent = room === 'room' ? '👻' : '👤';
    }
    
    setupEventListeners() {
        // Send message
        document.getElementById('sendBtn').addEventListener('click', () => this.sendMessage());
        document.getElementById('chatInput').addEventListener('keydown', (e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                this.sendMessage();
            }
            this.handleTyping(e);
        });
        
        // Auto-resize textarea
        const input = document.getElementById('chatInput');
        input.addEventListener('input', () => {
            input.style.height = 'auto';
            input.style.height = Math.min(input.scrollHeight, 150) + 'px';
        });
        
        // Contact switching
        document.querySelectorAll('.contact-item').forEach(el => {
            el.addEventListener('click', () => {
                const contact = el.dataset.contact;
                this.switchContact(contact);
            });
        });
        
        // Clear chat
        document.getElementById('clearChatBtn').addEventListener('click', () => {
            if (confirm('Clear all messages in this chat?')) {
                this.messages = [];
                this.saveMessages();
                this.renderMessages();
                this.showToast('Chat cleared', 'info');
            }
        });
        
        // Export chat
        document.getElementById('exportChatBtn').addEventListener('click', () => {
            this.exportChat();
        });
        
        // Add contact
        document.getElementById('addContactBtn').addEventListener('click', () => {
            document.getElementById('contactModal').classList.add('active');
        });
        document.getElementById('contactModalClose').addEventListener('click', () => {
            document.getElementById('contactModal').classList.remove('active');
        });
        document.getElementById('addContactSubmitBtn').addEventListener('click', () => {
            this.addContact();
        });
        
        // Decrypt modal
        document.getElementById('decryptModalClose').addEventListener('click', () => {
            document.getElementById('decryptModal').classList.remove('active');
            document.getElementById('decryptResultArea').innerHTML = '';
        });
        document.getElementById('decryptMessageBtn').addEventListener('click', () => {
            this.decryptMessage();
        });
        document.getElementById('decryptPasswordInput').addEventListener('keydown', (e) => {
            if (e.key === 'Enter') this.decryptMessage();
        });
        
        // Logout
        document.getElementById('chatLogout').addEventListener('click', () => {
            if (confirm('Log out?')) {
                if (this.socket) {
                    this.socket.disconnect();
                }
                localStorage.removeItem('ghostchat_user');
                window.location.href = 'login.html';
            }
        });
        
        // Close modals
        document.querySelectorAll('.modal').forEach(modal => {
            modal.addEventListener('click', (e) => {
                if (e.target === modal) {
                    modal.classList.remove('active');
                }
            });
        });
        
        // Emoji picker
        const emojiBtn = document.getElementById('emojiPickerBtn');
        if (emojiBtn) {
            emojiBtn.addEventListener('click', () => {
                const picker = document.getElementById('emojiPicker');
                picker.style.display = picker.style.display === 'none' ? 'block' : 'none';
            });
        }
        
        // Image upload (placeholder)
        const attachBtn = document.getElementById('attachBtn');
        if (attachBtn) {
            attachBtn.addEventListener('click', () => {
                this.showToast('Image upload coming soon!', 'info');
            });
        }
    }
    
    setupEmojiPicker() {
        const picker = document.getElementById('emojiPicker');
        if (!picker) return;
        
        const emojis = ['😀','😁','😂','🤣','😃','😄','😅','😆','😉','😊','😋','😎','😍','😘','😗','😙','😚','🙂','🤗','🤔','😐','😑','😶','🙄','😏','😣','😥','😮','🤐','😌','😔','😪','🤤','😴','😷','🤒','🤕','🤢','🤮','🤧','🥵','🥶','🥴','😵','🤯','🤠','🥳','😎','🤓','🧐','😕','😟','🙁','😮','😯','😲','😳','🥺','😦','😧','😨','😰','😥','😢','😭','😱','😖','😣','😞','😓','😩','😫','😤','😡','😠','🤬','😈','👿','💀','☠️','💩','🤡','👹','👺','👻','👽','🤖','🎃','😺','😸','😹','😻','😼','😽','🙀','😿','😾','🙈','🙉','🙊','💋','💌','💘','💝','💖','💗','💓','💞','💕','💟','❣️','💔','❤️','🧡','💛','💚','💙','💜','🖤','🤍','🤎'];
        
        picker.innerHTML = emojis.map(e => 
            `<span class="emoji-item" onclick="window.chat.insertEmoji('${e}')">${e}</span>`
        ).join('');
    }
    
    insertEmoji(emoji) {
        const input = document.getElementById('chatInput');
        const start = input.selectionStart;
        const end = input.selectionEnd;
        const text = input.value;
        input.value = text.substring(0, start) + emoji + text.substring(end);
        input.selectionStart = input.selectionEnd = start + emoji.length;
        input.focus();
        document.getElementById('emojiPicker').style.display = 'none';
        input.dispatchEvent(new Event('input'));
    }
    
    handleTyping(e) {
        const input = document.getElementById('chatInput');
        const isCurrentlyTyping = input.value.length > 0;
        
        if (isCurrentlyTyping !== this.isTyping) {
            this.isTyping = isCurrentlyTyping;
            if (this.socket && this.connected) {
                this.socket.emit('typing', { 
                    room: this.currentRoom, 
                    is_typing: isCurrentlyTyping 
                });
            }
        }
        
        clearTimeout(this.typingTimeout);
        this.typingTimeout = setTimeout(() => {
            if (this.isTyping) {
                this.isTyping = false;
                if (this.socket && this.connected) {
                    this.socket.emit('typing', { 
                        room: this.currentRoom, 
                        is_typing: false 
                    });
                }
            }
        }, 2000);
    }
    
    sendMessage() {
        const input = document.getElementById('chatInput');
        const text = input.value.trim();
        if (!text) return;
        
        const password = prompt('Enter encryption password for this message:');
        if (!password) return;
        
        this.password = password;
        input.disabled = true;
        
        window.GhostChatAPI.encryptSimple(text, password, false)
            .then(result => {
                if (result.success) {
                    const message = {
                        id: Date.now(),
                        text: result.emoji_message,
                        original: text,
                        encrypted: true,
                        timestamp: new Date().toISOString(),
                        sender: this.username || 'me',
                        contact: this.currentRoom,
                        delivered: false,
                        read: false
                    };
                    
                    // Add to local messages
                    this.messages.push(message);
                    this.saveMessages();
                    this.renderMessages();
                    
                    // Send via WebSocket
                    if (this.socket && this.connected) {
                        this.socket.emit('send_message', {
                            room: this.currentRoom,
                            message: message.text,
                            sender: this.userId || this.username,
                            timestamp: message.timestamp,
                            message_id: message.id
                        });
                        message.delivered = true;
                        this.saveMessages();
                        this.showToast('Message sent securely!', 'success');
                    } else {
                        // Queue message for later
                        this.messageQueue.push(message);
                        this.showToast('Offline - message queued', 'warning');
                    }
                    
                    // Auto-decrypt for sender
                    setTimeout(() => {
                        const msgEl = document.querySelector(`.message[data-id="${message.id}"]`);
                        if (msgEl) {
                            const decryptedDiv = msgEl.querySelector('.msg-decrypted');
                            if (decryptedDiv) {
                                decryptedDiv.innerHTML = `<span class="msg-decrypted-label"><i class="fas fa-check-circle"></i> Decrypted</span>${this.escapeHtml(text)}`;
                                decryptedDiv.style.display = 'block';
                            }
                            const lockEl = msgEl.querySelector('.msg-lock i');
                            if (lockEl) {
                                lockEl.className = 'fas fa-lock-open';
                                lockEl.style.color = 'var(--green)';
                            }
                        }
                    }, 100);
                    
                    input.value = '';
                    input.style.height = 'auto';
                    input.disabled = false;
                    input.focus();
                    
                    // Update contact badge
                    this.updateContactBadge(this.currentRoom);
                    this.unreadCount = 0;
                    this.updateUnreadBadge();
                    
                } else {
                    this.showToast('Encryption failed: ' + (result.error || 'Unknown error'), 'error');
                    input.disabled = false;
                }
            })
            .catch(err => {
                this.showToast('Encryption error: ' + err.message, 'error');
                input.disabled = false;
            });
    }
    
    processQueue() {
        if (this.isProcessingQueue || this.messageQueue.length === 0) return;
        
        this.isProcessingQueue = true;
        const messages = [...this.messageQueue];
        this.messageQueue = [];
        
        messages.forEach(msg => {
            if (this.socket && this.connected) {
                this.socket.emit('send_message', {
                    room: msg.contact || this.currentRoom,
                    message: msg.text,
                    sender: this.userId || this.username,
                    timestamp: msg.timestamp,
                    message_id: msg.id
                });
                msg.delivered = true;
                this.saveMessages();
                this.showToast('Queued message sent!', 'success');
            } else {
                this.messageQueue.push(msg);
            }
        });
        
        this.isProcessingQueue = false;
    }
    
    handleReceivedMessage(data) {
        // Check if message already exists
        if (this.messages.some(m => m.id === data.message_id)) {
            return;
        }
        
        const message = {
            id: data.message_id || Date.now() + Math.random(),
            text: data.message,
            encrypted: true,
            timestamp: data.timestamp || new Date().toISOString(),
            sender: data.sender || 'other',
            contact: this.currentRoom,
            received: true,
            delivered: true,
            read: false
        };
        
        // Check if message is from a different room
        const room = data.room || this.currentRoom;
        if (room !== this.currentRoom && this.contacts[room]) {
            // Store in the correct room's messages
            if (!this.contacts[room].messages) {
                this.contacts[room].messages = [];
            }
            this.contacts[room].messages.push(message);
            this.contacts[room].unread = (this.contacts[room].unread || 0) + 1;
            this.saveContacts();
            this.renderContacts();
            this.updateUnreadBadge();
            this.showToast(`New message from ${message.sender} in ${room}`, 'info');
            return;
        }
        
        this.messages.push(message);
        this.saveMessages();
        this.renderMessages();
        
        // Update contact badge
        if (this.contacts[this.currentRoom]) {
            this.contacts[this.currentRoom].unread = (this.contacts[this.currentRoom].unread || 0) + 1;
            this.saveContacts();
        }
        this.updateContactBadge(this.currentRoom);
        this.updateUnreadBadge();
        
        // Show notification
        this.showToast(`New message from ${message.sender}`, 'info');
        
        // Play sound
        this.playNotificationSound();
        
        // Auto-decrypt if password is available
        if (this.password) {
            window.GhostChatAPI.decryptSimple(message.text, this.password)
                .then(result => {
                    if (result.success) {
                        message.original = result.decrypted_message;
                        message.decrypted = true;
                        this.saveMessages();
                        this.renderMessages();
                    }
                })
                .catch(() => {});
        }
    }
    
    handleMessageDelivered(data) {
        const msg = this.messages.find(m => m.id === data.message_id);
        if (msg) {
            msg.delivered = true;
            this.saveMessages();
            const msgEl = document.querySelector(`.message[data-id="${data.message_id}"]`);
            if (msgEl) {
                const statusEl = msgEl.querySelector('.msg-status');
                if (statusEl) {
                    statusEl.textContent = '✓';
                }
            }
        }
    }
    
    handleMessageRead(data) {
        const msg = this.messages.find(m => m.id === data.message_id);
        if (msg) {
            msg.read = true;
            this.saveMessages();
            const msgEl = document.querySelector(`.message[data-id="${data.message_id}"]`);
            if (msgEl) {
                const statusEl = msgEl.querySelector('.msg-status');
                if (statusEl) {
                    statusEl.textContent = '✓✓ Read';
                    statusEl.style.color = 'var(--primary)';
                }
            }
        }
    }
    
    playNotificationSound() {
        try {
            const ctx = new (window.AudioContext || window.webkitAudioContext)();
            const osc = ctx.createOscillator();
            const gain = ctx.createGain();
            osc.connect(gain);
            gain.connect(ctx.destination);
            osc.frequency.value = 660;
            gain.gain.value = 0.08;
            osc.start();
            setTimeout(() => { osc.stop(); ctx.close(); }, 150);
        } catch (_) {}
    }
    
    switchContact(contact) {
        this.currentRoom = contact;
        this.unreadCount = 0;
        this.updateUnreadBadge();
        
        document.querySelectorAll('.contact-item').forEach(el => {
            el.classList.toggle('active', el.dataset.contact === contact);
        });
        
        this.joinRoom(contact);
        
        const contactData = this.contacts[contact] || { name: contact };
        document.getElementById('chatHeaderName').textContent = contactData.name || contact;
        document.getElementById('chatHeaderAvatar').textContent = contact === 'room' ? '👻' : '👤';
        
        // Mobile: hide sidebar when chat opens
        if (window.innerWidth <= 768) {
            document.querySelector('.chat-main').classList.add('mobile-chat-open');
        }
    }
    
    updateContactBadge(contactId) {
        const unread = this.contacts[contactId]?.unread || 0;
        const badge = document.querySelector(`.contact-item[data-contact="${contactId}"] .contact-badge`);
        if (badge) {
            badge.textContent = unread;
            badge.style.display = unread > 0 ? '' : 'none';
        }
    }
    
    updateUnreadBadge() {
        const totalUnread = Object.values(this.contacts).reduce((sum, c) => sum + (c.unread || 0), 0);
        const badge = document.querySelector('.nav-badge');
        if (badge) {
            badge.textContent = totalUnread;
            badge.style.display = totalUnread > 0 ? '' : 'none';
        }
    }
    
    renderMessages() {
        const container = document.getElementById('chatMessages');
        if (!container) return;
        
        if (!this.messages.length) {
            container.innerHTML = `
                <div class="chat-welcome">
                    <i class="fas fa-ghost"></i>
                    <h3>No messages yet</h3>
                    <p>Send your first encrypted message below.</p>
                    ${this.connected ? '<p style="color:var(--green);font-size:.8rem;">🟢 Connected to secure channel</p>' : '<p style="color:var(--red);font-size:.8rem;">🔴 Offline - reconnecting...</p>'}
                </div>
            `;
            return;
        }
        
        container.innerHTML = this.messages.map(msg => {
            const isMine = msg.sender === this.username || msg.sender === 'me' || msg.sender === this.userId;
            const time = new Date(msg.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
            const isDecrypted = msg.decrypted || msg.original;
            
            const statusIcon = msg.read ? '✓✓' : (msg.delivered ? '✓' : '');
            const statusColor = msg.read ? 'var(--primary)' : 'var(--t3)';
            
            return `
                <div class="message ${isMine ? 'sent' : 'received'}" data-id="${msg.id}">
                    <div class="msg-encrypted" onclick="window.chat.decryptPrompt(${msg.id})" title="Click to decrypt">
                        ${this.escapeHtml(msg.text)}
                    </div>
                    ${isDecrypted ? `
                        <div class="msg-decrypted" style="display: block;">
                            <span class="msg-decrypted-label"><i class="fas fa-check-circle"></i> Decrypted</span>
                            ${this.escapeHtml(msg.original || msg.decrypted_text || '')}
                        </div>
                    ` : `
                        <div class="msg-decrypted" style="display: none;">
                            <span class="msg-decrypted-label"><i class="fas fa-spinner fa-spin"></i> Click lock to decrypt</span>
                        </div>
                    `}
                    <div class="msg-actions">
                        <button onclick="window.chat.copyMessage(${msg.id})" title="Copy"><i class="fas fa-copy"></i></button>
                        <button onclick="window.chat.decryptPrompt(${msg.id})" title="Decrypt"><i class="fas fa-lock"></i></button>
                        <button onclick="window.chat.reactToMessage(${msg.id})" title="React"><i class="fas fa-smile"></i></button>
                    </div>
                    <span class="msg-time">${time}</span>
                    ${isMine ? `<span class="msg-status" style="color:${statusColor}">${statusIcon}</span>` : ''}
                    ${!isMine && !isDecrypted ? '<span class="msg-lock"><i class="fas fa-lock"></i></span>' : ''}
                    ${isMine && isDecrypted ? '<span class="msg-lock"><i class="fas fa-lock-open" style="color:var(--green);"></i></span>' : ''}
                    ${msg.received && !isMine ? '<span style="font-size:10px;color:var(--t3);margin-left:4px;">📩</span>' : ''}
                    <div class="msg-reactions"></div>
                </div>
            `;
        }).join('');
        
        container.scrollTop = container.scrollHeight;
    }
    
    decryptPrompt(messageId) {
        const message = this.messages.find(m => m.id === messageId);
        if (!message) return;
        
        const modal = document.getElementById('decryptModal');
        if (!modal) return;
        
        document.getElementById('modalEncryptedText').textContent = message.text;
        document.getElementById('decryptPasswordInput').value = '';
        document.getElementById('decryptResultArea').innerHTML = '';
        modal.classList.add('active');
        modal.dataset.messageId = messageId;
    }
    
    decryptMessage() {
        const modal = document.getElementById('decryptModal');
        const messageId = parseInt(modal.dataset.messageId);
        const password = document.getElementById('decryptPasswordInput').value.trim();
        const resultArea = document.getElementById('decryptResultArea');
        
        if (!password) {
            resultArea.innerHTML = '<div class="error">Please enter the password.</div>';
            return;
        }
        
        const message = this.messages.find(m => m.id === messageId);
        if (!message) {
            resultArea.innerHTML = '<div class="error">Message not found.</div>';
            return;
        }
        
        resultArea.innerHTML = '<div class="loading">Decrypting...</div>';
        
        window.GhostChatAPI.decryptSimple(message.text, password)
            .then(result => {
                if (result.success) {
                    message.original = result.decrypted_message;
                    message.decrypted = true;
                    this.saveMessages();
                    
                    resultArea.innerHTML = `
                        <div class="success">
                            <i class="fas fa-check-circle"></i> 
                            <strong>Decrypted:</strong> ${this.escapeHtml(result.decrypted_message)}
                        </div>
                    `;
                    
                    this.renderMessages();
                    
                    setTimeout(() => {
                        modal.classList.remove('active');
                        resultArea.innerHTML = '';
                    }, 3000);
                } else {
                    resultArea.innerHTML = `<div class="error">${this.escapeHtml(result.error || 'Decryption failed. Wrong password?')}</div>`;
                }
            })
            .catch(err => {
                resultArea.innerHTML = `<div class="error">Error: ${this.escapeHtml(err.message)}</div>`;
            });
    }
    
    reactToMessage(messageId) {
        const reaction = prompt('Enter reaction (emoji):', '👍');
        if (reaction && this.socket && this.connected) {
            this.socket.emit('add_reaction', {
                message_id: messageId,
                reaction: reaction,
                room: this.currentRoom
            });
            
            const msgEl = document.querySelector(`.message[data-id="${messageId}"]`);
            if (msgEl) {
                let reactionsEl = msgEl.querySelector('.msg-reactions');
                if (!reactionsEl) {
                    reactionsEl = document.createElement('div');
                    reactionsEl.className = 'msg-reactions';
                    msgEl.appendChild(reactionsEl);
                }
                const reactionSpan = document.createElement('span');
                reactionSpan.textContent = reaction;
                reactionsEl.appendChild(reactionSpan);
            }
        }
    }
    
    copyMessage(messageId) {
        const message = this.messages.find(m => m.id === messageId);
        if (!message) return;
        
        const text = message.original || message.text;
        navigator.clipboard.writeText(text)
            .then(() => { this.showToast('Message copied!', 'success'); })
            .catch(() => {
                const ta = document.createElement('textarea');
                ta.value = text;
                document.body.appendChild(ta);
                ta.select();
                document.execCommand('copy');
                ta.remove();
                this.showToast('Message copied!', 'success');
            });
    }
    
    addContact() {
        const name = document.getElementById('contactNameInput').value.trim();
        const id = document.getElementById('contactIdInput').value.trim() || name.toLowerCase().replace(/\s/g, '_');
        
        if (!name) {
            this.showToast('Please enter a contact name.', 'error');
            return;
        }
        
        if (this.contacts[id]) {
            this.showToast('Contact already exists.', 'error');
            return;
        }
        
        this.contacts[id] = { name: name, messages: [], unread: 0, lastMessage: '' };
        this.saveContacts();
        this.renderContacts();
        
        document.getElementById('contactModal').classList.remove('active');
        document.getElementById('contactNameInput').value = '';
        document.getElementById('contactIdInput').value = '';
        
        this.showToast(`Contact "${name}" added!`, 'success');
    }
    
    renderContacts() {
        const container = document.getElementById('contactsList');
        if (!container) return;
        
        container.innerHTML = Object.entries(this.contacts).map(([id, contact]) => {
            const isActive = id === this.currentRoom;
            const unread = contact.unread || 0;
            const lastMsg = contact.lastMessage || '';
            const preview = lastMsg ? lastMsg.substring(0, 25) + (lastMsg.length > 25 ? '...' : '') : 'No messages';
            
            return `
                <div class="contact-item ${isActive ? 'active' : ''}" data-contact="${id}">
                    <div class="contact-avatar">${id === 'room' ? '👻' : '👤'}</div>
                    <div class="contact-info">
                        <div class="contact-name">${this.escapeHtml(contact.name)}</div>
                        <div class="contact-preview">${this.escapeHtml(preview)}</div>
                        <div class="contact-status">${this.connected ? '🟢 Online' : '⚪ Offline'}</div>
                    </div>
                    ${unread > 0 ? `<span class="contact-badge">${unread}</span>` : ''}
                </div>
            `;
        }).join('');
        
        container.querySelectorAll('.contact-item').forEach(el => {
            el.addEventListener('click', () => {
                const contact = el.dataset.contact;
                this.switchContact(contact);
            });
        });
    }
    
    exportChat() {
        const data = {
            contact: this.currentRoom,
            contactName: this.contacts[this.currentRoom]?.name || this.currentRoom,
            messages: this.messages.map(m => ({
                ...m,
                timestamp: m.timestamp,
                sender: m.sender
            })),
            exported: new Date().toISOString(),
            totalMessages: this.messages.length
        };
        
        const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `ghostchat_export_${this.currentRoom}_${new Date().toISOString().slice(0,10)}.json`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
        this.showToast('Chat exported!', 'success');
    }
    
    showToast(message, type = 'info') {
        if (window.UI && window.UI.showToast) {
            window.UI.showToast(message, type);
        } else {
            console.log(`[${type}] ${message}`);
        }
    }
    
    escapeHtml(text) {
        if (!text) return '';
        const div = document.createElement('div');
        div.textContent = text;
        return div.innerHTML;
    }
}

// Initialize chat
document.addEventListener('DOMContentLoaded', () => {
    window.chat = new GhostChatRealtime();
});