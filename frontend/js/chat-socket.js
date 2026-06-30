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
    }
    
    loadUserProfile() {
        try {
            const user = JSON.parse(localStorage.getItem('ghostchat_user'));
            if (user) {
                this.username = user.username || 'Ghost';
                this.userId = user.id;
                document.getElementById('chatUserName').textContent = user.username || 'Ghost User';
                const avatarEl = document.getElementById('chatUserAvatar');
                const initials = ((user.firstName?.[0] || '') + (user.lastName?.[0] || user.username?.[1] || '')).toUpperCase() || 'GH';
                if (avatarEl) avatarEl.textContent = initials;
                if (user.avatar) {
                    avatarEl.innerHTML = `<img src="${user.avatar}" alt="Avatar" />`;
                }
            }
        } catch (_) {}
    }
    
    loadContacts() {
        const saved = localStorage.getItem('ghostchat_contacts');
        this.contacts = saved ? JSON.parse(saved) : {
            room: { name: 'Secure Room', messages: [], unread: 0 }
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
            this.saveContacts();
        }
    }
    
    connectToSocket() {
        const socketUrl = window.location.origin;
        this.socket = io(socketUrl, {
            transports: ['websocket', 'polling'],
            withCredentials: true
        });
        
        this.socket.on('connect', () => {
            console.log('Connected to chat server');
            this.connected = true;
            this.updateStatus(true);
            
            // Authenticate
            this.socket.emit('authenticate', {
                user_id: this.userId,
                token: localStorage.getItem('gc_token') || ''
            });
            
            // Join current room
            this.joinRoom(this.currentRoom);
        });
        
        this.socket.on('authenticated', (data) => {
            console.log('Authenticated:', data);
        });
        
        this.socket.on('disconnect', () => {
            console.log('Disconnected from chat server');
            this.connected = false;
            this.updateStatus(false);
        });
        
        this.socket.on('new_message', (data) => {
            console.log('New message received:', data);
            this.handleNewMessage(data);
        });
        
        this.socket.on('message_read', (data) => {
            this.handleMessageRead(data);
        });
        
        this.socket.on('user_typing', (data) => {
            this.handleTypingIndicator(data);
        });
        
        this.socket.on('user_online', (data) => {
            this.updateUserStatus(data.user_id, true);
        });
        
        this.socket.on('user_offline', (data) => {
            this.updateUserStatus(data.user_id, false);
        });
        
        this.socket.on('reaction_added', (data) => {
            this.handleReaction(data);
        });
        
        this.socket.on('message_deleted', (data) => {
            this.handleMessageDeleted(data);
        });
    }
    
    updateStatus(connected) {
        const statusEl = document.querySelector('.user-status');
        if (statusEl) {
            statusEl.textContent = connected ? '🟢 Online' : '🔴 Offline';
            statusEl.style.color = connected ? 'var(--green)' : 'var(--red)';
        }
    }
    
    updateUserStatus(userId, isOnline) {
        // Update contact status
        document.querySelectorAll('.contact-item').forEach(el => {
            if (el.dataset.contact === userId) {
                const statusEl = el.querySelector('.contact-status');
                if (statusEl) {
                    statusEl.textContent = isOnline ? '🟢 Online' : '⚪ Offline';
                    statusEl.style.color = isOnline ? 'var(--green)' : 'var(--t3)';
                }
            }
        });
    }
    
    joinRoom(room) {
        if (!this.socket || !this.connected) return;
        
        if (this.currentRoom) {
            this.socket.emit('leave_chat', {
                chat_id: this.currentRoom,
                chat_type: 'private'
            });
        }
        
        this.currentRoom = room;
        this.socket.emit('join_chat', {
            chat_id: room,
            chat_type: 'private'
        });
        
        // Load messages for this room
        if (this.contacts[room]) {
            this.messages = this.contacts[room].messages || [];
        } else {
            this.messages = [];
        }
        this.renderMessages();
        
        // Update header
        const contact = this.contacts[room] || { name: room };
        document.getElementById('chatHeaderName').textContent = contact.name || room;
        document.getElementById('chatHeaderAvatar').textContent = room === 'room' ? '👻' : '👤';
    }
    
    setupEventListeners() {
        // Send message
        document.getElementById('sendBtn').addEventListener('click', () => this.sendMessage());
        document.getElementById('chatInput').addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
                e.preventDefault();
                this.sendMessage();
            }
            this.handleTyping(e);
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
        document.getElementById('emojiPickerBtn').addEventListener('click', () => {
            const picker = document.getElementById('emojiPicker');
            picker.style.display = picker.style.display === 'none' ? 'block' : 'none';
        });
        
        // Voice recording (placeholder)
        document.getElementById('voiceBtn')?.addEventListener('click', () => {
            if (window.UI) UI.showToast('Voice recording coming soon!', 'info');
        });
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
        input.value += emoji;
        input.focus();
        document.getElementById('emojiPicker').style.display = 'none';
    }
    
    handleTyping(e) {
        const input = document.getElementById('chatInput');
        const isCurrentlyTyping = input.value.length > 0;
        
        if (isCurrentlyTyping !== this.isTyping) {
            this.isTyping = isCurrentlyTyping;
            this.socket.emit('typing', {
                chat_id: this.currentRoom,
                chat_type: 'private',
                is_typing: isCurrentlyTyping
            });
        }
        
        clearTimeout(this.typingTimeout);
        this.typingTimeout = setTimeout(() => {
            if (this.isTyping) {
                this.isTyping = false;
                this.socket.emit('typing', {
                    chat_id: this.currentRoom,
                    chat_type: 'private',
                    is_typing: false
                });
            }
        }, 2000);
    }
    
    handleTypingIndicator(data) {
        const statusEl = document.getElementById('chatHeaderStatus');
        if (data.is_typing) {
            statusEl.textContent = 'typing...';
            statusEl.style.color = 'var(--primary)';
        } else {
            statusEl.textContent = 'online';
            statusEl.style.color = 'var(--green)';
        }
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
                    
                    // Send via WebSocket
                    if (this.socket && this.connected) {
                        this.socket.emit('send_message', {
                            chat_type: 'private',
                            receiver_id: this.currentRoom,
                            encrypted_content: message.text,
                            sender_id: this.userId,
                            timestamp: message.timestamp
                        });
                    }
                    
                    // Add to local messages
                    this.messages.push(message);
                    this.saveMessages();
                    this.renderMessages();
                    
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
                    input.disabled = false;
                    input.focus();
                    
                    // Update contact badge
                    this.updateContactBadge(this.currentRoom);
                } else {
                    alert('Encryption failed: ' + (result.error || 'Unknown error'));
                    input.disabled = false;
                }
            })
            .catch(err => {
                alert('Encryption error: ' + err.message);
                input.disabled = false;
            });
    }
    
    handleNewMessage(data) {
        const message = {
            id: data.id || Date.now() + Math.random(),
            text: data.encrypted_content,
            encrypted: true,
            timestamp: data.timestamp || new Date().toISOString(),
            sender: data.sender || 'other',
            contact: this.currentRoom,
            received: true,
            delivered: true,
            read: false
        };
        
        this.messages.push(message);
        this.saveMessages();
        this.renderMessages();
        
        // Send read receipt
        this.socket.emit('mark_read', {
            message_id: message.id,
            user_id: this.userId
        });
        
        // Update contact badge
        this.updateContactBadge(this.currentRoom);
        
        // Show notification
        if (window.UI) {
            UI.showToast(`New message from ${data.sender}`, 'info');
        }
        
        // Play sound
        const settings = localStorage.getItem('ghostchat_settings');
        const soundEffects = settings ? JSON.parse(settings).soundEffects : false;
        if (soundEffects) {
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
    }
    
    handleMessageRead(data) {
        const msgEl = document.querySelector(`.message[data-id="${data.message_id}"]`);
        if (msgEl) {
            const statusEl = msgEl.querySelector('.msg-status');
            if (statusEl) {
                statusEl.textContent = '✓✓ Read';
                statusEl.style.color = 'var(--primary)';
            }
        }
    }
    
    handleReaction(data) {
        const msgEl = document.querySelector(`.message[data-id="${data.message_id}"]`);
        if (msgEl) {
            let reactionsEl = msgEl.querySelector('.msg-reactions');
            if (!reactionsEl) {
                reactionsEl = document.createElement('div');
                reactionsEl.className = 'msg-reactions';
                msgEl.appendChild(reactionsEl);
            }
            const reactionSpan = document.createElement('span');
            reactionSpan.textContent = data.reaction;
            reactionsEl.appendChild(reactionSpan);
        }
    }
    
    handleMessageDeleted(data) {
        const msgEl = document.querySelector(`.message[data-id="${data.message_id}"]`);
        if (msgEl) {
            msgEl.style.opacity = '0.4';
            const contentEl = msgEl.querySelector('.msg-encrypted');
            if (contentEl) {
                contentEl.textContent = 'This message was deleted';
                contentEl.style.fontStyle = 'italic';
            }
        }
    }
    
    switchContact(contact) {
        this.currentRoom = contact;
        
        document.querySelectorAll('.contact-item').forEach(el => {
            el.classList.toggle('active', el.dataset.contact === contact);
        });
        
        this.joinRoom(contact);
        
        const contactData = this.contacts[contact] || { name: contact };
        document.getElementById('chatHeaderName').textContent = contactData.name || contact;
        document.getElementById('chatHeaderAvatar').textContent = contact === 'room' ? '👻' : '👤';
    }
    
    updateContactBadge(contactId) {
        const unread = this.messages.filter(m => !m.read && m.received).length;
        const badge = document.querySelector(`.contact-item[data-contact="${contactId}"] .contact-badge`);
        if (badge) {
            badge.textContent = unread;
            badge.style.display = unread > 0 ? '' : 'none';
        }
    }
    
    renderMessages() {
        const container = document.getElementById('chatMessages');
        
        if (!this.messages.length) {
            container.innerHTML = `
                <div class="chat-welcome">
                    <i class="fas fa-ghost"></i>
                    <h3>No messages yet</h3>
                    <p>Send your first encrypted message below.</p>
                    ${this.connected ? '<p style="color:var(--green);font-size:.8rem;">🟢 Connected to secure channel</p>' : '<p style="color:var(--red);font-size:.8rem;">🔴 Disconnected - check your connection</p>'}
                </div>
            `;
            return;
        }
        
        container.innerHTML = this.messages.map(msg => {
            const isMine = msg.sender === this.username || msg.sender === 'me';
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
                        <button onclick="window.chat.copyMessage(${msg.id})"><i class="fas fa-copy"></i></button>
                        <button onclick="window.chat.decryptPrompt(${msg.id})"><i class="fas fa-lock"></i></button>
                        <button onclick="window.chat.reactToMessage(${msg.id})"><i class="fas fa-smile"></i></button>
                    </div>
                    <span class="msg-time">${time}</span>
                    ${isMine ? `<span class="msg-status" style="color:${statusColor}">${statusIcon}</span>` : ''}
                    <span class="msg-lock"><i class="fas ${isDecrypted ? 'fa-lock-open' : 'fa-lock'}"></i></span>
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
        if (reaction) {
            this.socket.emit('add_reaction', {
                message_id: messageId,
                reaction: reaction,
                user_id: this.userId
            });
        }
    }
    
    copyMessage(messageId) {
        const message = this.messages.find(m => m.id === messageId);
        if (!message) return;
        
        const text = message.original || message.text;
        navigator.clipboard.writeText(text)
            .then(() => { if (window.UI) UI.showToast('Message copied!', 'success'); })
            .catch(() => {
                const ta = document.createElement('textarea');
                ta.value = text;
                document.body.appendChild(ta);
                ta.select();
                document.execCommand('copy');
                ta.remove();
                if (window.UI) UI.showToast('Message copied!', 'success');
            });
    }
    
    addContact() {
        const name = document.getElementById('contactNameInput').value.trim();
        const id = document.getElementById('contactIdInput').value.trim() || name.toLowerCase().replace(/\s/g, '_');
        
        if (!name) {
            alert('Please enter a contact name.');
            return;
        }
        
        if (this.contacts[id]) {
            alert('Contact already exists.');
            return;
        }
        
        this.contacts[id] = { name: name, messages: [], unread: 0 };
        this.saveContacts();
        this.renderContacts();
        
        document.getElementById('contactModal').classList.remove('active');
        document.getElementById('contactNameInput').value = '';
        document.getElementById('contactIdInput').value = '';
        
        if (window.UI) UI.showToast(`Contact "${name}" added!`, 'success');
    }
    
    renderContacts() {
        const container = document.getElementById('contactsList');
        container.innerHTML = Object.entries(this.contacts).map(([id, contact]) => {
            const isActive = id === this.currentRoom;
            const count = contact.messages ? contact.messages.filter(m => m.received && !m.read).length : 0;
            const preview = contact.messages && contact.messages.length > 0 
                ? (contact.messages[contact.messages.length - 1].text || '').substring(0, 20) + '...'
                : 'No messages';
            
            return `
                <div class="contact-item ${isActive ? 'active' : ''}" data-contact="${id}">
                    <div class="contact-avatar">${id === 'room' ? '👻' : '👤'}</div>
                    <div class="contact-info">
                        <div class="contact-name">${this.escapeHtml(contact.name)}</div>
                        <div class="contact-preview">${this.escapeHtml(preview)}</div>
                        <div class="contact-status">🟢 Online</div>
                    </div>
                    ${count > 0 ? `<span class="contact-badge">${count}</span>` : ''}
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
            messages: this.messages,
            exported: new Date().toISOString()
        };
        
        const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `ghostchat_export_${this.currentRoom}_${new Date().toISOString().slice(0,10)}.json`;
        a.click();
        URL.revokeObjectURL(url);
        if (window.UI) UI.showToast('Chat exported!', 'success');
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