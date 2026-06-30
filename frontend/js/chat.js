/**
 * GHOSTCHAT CHAT MODULE
 * Real-time encrypted chat interface
 */

class GhostChat {
    constructor() {
        this.messages = [];
        this.currentContact = 'room';
        this.contacts = {};
        this.password = '';
        this.isDecrypting = false;
        
        this.init();
    }
    
    init() {
        this.loadContacts();
        this.loadMessages();
        this.setupEventListeners();
        this.loadUserProfile();
        this.renderMessages();
    }
    
    loadUserProfile() {
        const avatarEl = document.getElementById('chatUserAvatar');
        const nameEl = document.getElementById('chatUserName');
        
        try {
            const user = JSON.parse(localStorage.getItem('ghostchat_user'));
            if (user) {
                const initials = ((user.firstName?.[0] || '') + (user.lastName?.[0] || user.username?.[1] || '')).toUpperCase() || 'GH';
                if (avatarEl) avatarEl.textContent = initials;
                if (nameEl) nameEl.textContent = [user.firstName, user.lastName].filter(Boolean).join(' ') || user.username || 'Ghost User';
                
                if (user.avatar) {
                    avatarEl.innerHTML = `<img src="${user.avatar}" alt="Avatar" />`;
                }
            }
        } catch (_) {}
    }
    
    loadContacts() {
        const saved = localStorage.getItem('ghostchat_contacts');
        this.contacts = saved ? JSON.parse(saved) : {
            room: { name: 'Secure Room', messages: [] },
            alice: { name: 'Alice', messages: [] },
            bob: { name: 'Bob', messages: [] }
        };
        this.renderContacts();
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
        // Also save to contact
        if (this.contacts[this.currentContact]) {
            this.contacts[this.currentContact].messages = this.messages;
            this.saveContacts();
        }
    }
    
    setupEventListeners() {
        // Send message
        document.getElementById('sendBtn').addEventListener('click', () => this.sendMessage());
        document.getElementById('chatInput').addEventListener('keydown', (e) => {
            if (e.key === 'Enter') this.sendMessage();
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
        
        // Close modals on backdrop click
        document.querySelectorAll('.modal').forEach(modal => {
            modal.addEventListener('click', (e) => {
                if (e.target === modal) {
                    modal.classList.remove('active');
                }
            });
        });
    }
    
    sendMessage() {
        const input = document.getElementById('chatInput');
        const text = input.value.trim();
        if (!text) return;
        
        // Get password
        const password = prompt('Enter encryption password for this message:');
        if (!password) return;
        
        input.disabled = true;
        
        // Encrypt the message
        window.GhostChatAPI.encryptSimple(text, password, false)
            .then(result => {
                if (result.success) {
                    const message = {
                        id: Date.now(),
                        text: result.emoji_message,
                        original: text,
                        encrypted: true,
                        timestamp: new Date().toISOString(),
                        sender: 'me',
                        contact: this.currentContact
                    };
                    
                    this.messages.push(message);
                    this.saveMessages();
                    this.renderMessages();
                    
                    // Auto-decrypt with same password for the sender
                    // Store the password temporarily for this message
                    const msgId = message.id;
                    const msgPassword = password;
                    const msgText = text;
                    
                    // Allow sender to see their own message
                    setTimeout(() => {
                        const msgEl = document.querySelector(`.message[data-id="${msgId}"]`);
                        if (msgEl) {
                            const decryptedDiv = msgEl.querySelector('.msg-decrypted');
                            if (decryptedDiv) {
                                decryptedDiv.innerHTML = `<span class="msg-decrypted-label"><i class="fas fa-check-circle"></i> Decrypted</span>${this.escapeHtml(msgText)}`;
                            }
                        }
                    }, 100);
                    
                    input.value = '';
                    input.disabled = false;
                    input.focus();
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
    
    switchContact(contact) {
        this.currentContact = contact;
        
        // Update active state
        document.querySelectorAll('.contact-item').forEach(el => {
            el.classList.toggle('active', el.dataset.contact === contact);
        });
        
        // Load messages for this contact
        if (this.contacts[contact]) {
            this.messages = this.contacts[contact].messages || [];
            this.renderMessages();
            
            // Update header
            document.getElementById('chatHeaderName').textContent = this.contacts[contact].name;
            document.getElementById('chatHeaderAvatar').textContent = contact === 'room' ? '👻' : '👤';
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
                </div>
            `;
            return;
        }
        
        container.innerHTML = this.messages.map(msg => {
            const isMine = msg.sender === 'me';
            const time = new Date(msg.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
            
            return `
                <div class="message ${isMine ? 'sent' : 'received'}" data-id="${msg.id}">
                    <div class="msg-encrypted" onclick="chat.decryptPrompt(${msg.id})" title="Click to decrypt">
                        ${this.escapeHtml(msg.text)}
                    </div>
                    <div class="msg-decrypted" style="display: none;">
                        <span class="msg-decrypted-label"><i class="fas fa-spinner fa-spin"></i> Click lock to decrypt</span>
                    </div>
                    <div class="msg-actions">
                        <button onclick="chat.copyMessage(${msg.id})"><i class="fas fa-copy"></i> Copy</button>
                        <button onclick="chat.decryptPrompt(${msg.id})"><i class="fas fa-lock"></i> Decrypt</button>
                    </div>
                    <span class="msg-time">${time}</span>
                </div>
            `;
        }).join('');
        
        // Scroll to bottom
        container.scrollTop = container.scrollHeight;
    }
    
    decryptPrompt(messageId) {
        const message = this.messages.find(m => m.id === messageId);
        if (!message) return;
        
        // Show the decrypt modal
        const modal = document.getElementById('decryptModal');
        document.getElementById('modalEncryptedText').textContent = message.text;
        document.getElementById('decryptPasswordInput').value = '';
        document.getElementById('decryptResultArea').innerHTML = '';
        modal.classList.add('active');
        
        // Store the message ID for decryption
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
                    // Update the message in the list
                    message.original = result.decrypted_message;
                    message.decrypted = true;
                    this.saveMessages();
                    
                    resultArea.innerHTML = `
                        <div class="success">
                            <i class="fas fa-check-circle"></i> 
                            <strong>Decrypted:</strong> ${this.escapeHtml(result.decrypted_message)}
                        </div>
                    `;
                    
                    // Update the message in the UI
                    this.renderMessages();
                    
                    // Close modal after 2 seconds
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
    
    copyMessage(messageId) {
        const message = this.messages.find(m => m.id === messageId);
        if (!message) return;
        
        const text = message.original || message.text;
        navigator.clipboard.writeText(text)
            .then(() => {
                if (window.UI) UI.showToast('Message copied!', 'success');
            })
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
        
        this.contacts[id] = { name: name, messages: [] };
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
            const isActive = id === this.currentContact;
            const count = contact.messages ? contact.messages.length : 0;
            const preview = contact.messages && contact.messages.length > 0 
                ? (contact.messages[contact.messages.length - 1].text || '').substring(0, 20) + '...'
                : 'No messages';
            
            return `
                <div class="contact-item ${isActive ? 'active' : ''}" data-contact="${id}">
                    <div class="contact-avatar">${id === 'room' ? '👻' : '👤'}</div>
                    <div class="contact-info">
                        <div class="contact-name">${this.escapeHtml(contact.name)}</div>
                        <div class="contact-preview">${this.escapeHtml(preview)}</div>
                    </div>
                    ${count > 0 ? `<span class="contact-badge">${count}</span>` : ''}
                </div>
            `;
        }).join('');
        
        // Re-bind click events
        container.querySelectorAll('.contact-item').forEach(el => {
            el.addEventListener('click', () => {
                const contact = el.dataset.contact;
                this.switchContact(contact);
            });
        });
    }
    
    exportChat() {
        const data = {
            contact: this.currentContact,
            messages: this.messages,
            exported: new Date().toISOString()
        };
        
        const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `ghostchat_export_${this.currentContact}_${new Date().toISOString().slice(0,10)}.json`;
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
    window.chat = new GhostChat();
});