/**
 * GHOSTCHAT HISTORY MODULE - IMPROVED
 * Handles saving and displaying message history
 */

window.HistoryModule = {
    messages: [],
    
    async load() {
        await this.loadMessages();
        this.setupEventListeners();
        this.updateNotificationCount();
    },
    
    async loadMessages() {
        // Try to load from server first
        try {
            const response = await fetch('/api/messages', {
                method: 'GET',
                headers: { 'Content-Type': 'application/json' },
                credentials: 'include'
            });
            
            if (response.ok) {
                const data = await response.json();
                if (data.success && data.messages) {
                    this.messages = data.messages;
                    this.saveMessages();
                    this.render();
                    return;
                }
            }
        } catch (error) {
            console.log('Server history not available, using local storage');
        }
        
        // Fallback to localStorage
        const saved = localStorage.getItem('ghostchat_history');
        if (saved) {
            this.messages = JSON.parse(saved);
        } else {
            this.messages = [];
        }
        this.render();
    },
    
    saveMessages() {
        localStorage.setItem('ghostchat_history', JSON.stringify(this.messages));
        
        // Also try to save to server
        for (const msg of this.messages.slice(0, 10)) {
            this.saveToServer(msg);
        }
    },
    
    async saveToServer(message) {
        try {
            await fetch('/api/messages', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                credentials: 'include',
                body: JSON.stringify({
                    encrypted_content: message.encrypted || message.encrypted_content || '',
                    emoji_content: message.emoji_content || '',
                    message_type: message.type || 'encryption'
                })
            });
        } catch (error) {
            console.log('Server save failed, keeping locally');
        }
    },
    
    addMessage(plaintext, encrypted, type = 'encryption') {
        const now = new Date();
        const timestamp = now.toISOString();
        const displayTime = now.toLocaleString();
        
        const newMessage = {
            id: Date.now(),
            plaintext: plaintext,
            encrypted: encrypted,
            emoji_content: encrypted,
            encrypted_content: encrypted,
            type: type,
            timestamp: timestamp,
            displayTime: displayTime,
            date_created: timestamp,
            created_at: timestamp
        };
        
        this.messages.unshift(newMessage);
        
        // Keep only last 100 messages
        if (this.messages.length > 100) {
            this.messages = this.messages.slice(0, 100);
        }
        
        this.saveMessages();
        this.render();
        this.updateNotificationCount();
        this.showToast(`${type === 'encryption' ? 'Encrypted' : 'Decrypted'} message saved to history`, 'success');
    },
    
    render() {
        const container = document.getElementById('historyList');
        if (!container) return;
        
        if (this.messages.length === 0) {
            container.innerHTML = `
                <div class="empty-state">
                    <i class="fas fa-inbox"></i>
                    <p>No messages yet. Encrypt or decrypt your first message!</p>
                </div>
            `;
            return;
        }
        
        container.innerHTML = this.messages.map(msg => `
            <div class="history-item glass" data-id="${msg.id}">
                <div class="history-header">
                    <span class="history-type ${msg.type}">
                        <i class="fas ${msg.type === 'encryption' ? 'fa-lock' : 'fa-unlock-alt'}"></i>
                        ${msg.type === 'encryption' ? 'ENCRYPTED' : 'DECRYPTED'}
                    </span>
                    <span class="history-time">${msg.displayTime || new Date(msg.timestamp).toLocaleString()}</span>
                </div>
                <div class="history-content">
                    <div class="history-plaintext">
                        <strong>${msg.type === 'encryption' ? 'Original Message:' : 'Decrypted Message:'}</strong>
                        <pre style="white-space: pre-wrap; word-break: break-word; margin: .5rem 0 0 0; padding: .75rem; background: rgba(255,255,255,0.06); border-radius: 8px;">${this.escapeHtml(msg.plaintext || '')}</pre>
                    </div>
                    <div class="history-encrypted" style="margin-top: 1rem;">
                        <strong>${msg.type === 'encryption' ? 'Encrypted (Emoji) Output:' : 'Encrypted Message Received:'}</strong>
                        <pre style="white-space: pre-wrap; word-break: break-word; max-height: 160px; overflow: auto; margin: .5rem 0 0 0; padding: .75rem; background: rgba(255,255,255,0.06); border-radius: 8px;">${this.escapeHtml(msg.encrypted || msg.emoji_content || '')}</pre>
                        <button class="btn-copy-small" onclick="HistoryModule.copyToClipboard('${this.escapeHtml(msg.encrypted || msg.emoji_content || '').replace(/'/g, "\\'")}')">
                            <i class="fas fa-copy"></i> Copy
                        </button>
                    </div>
                </div>
                <button class="history-delete" onclick="HistoryModule.deleteMessage(${msg.id})">
                    <i class="fas fa-trash"></i>
                </button>
            </div>
        `).join('');
    },
    
    async copyToClipboard(text) {
        try {
            await navigator.clipboard.writeText(text);
            this.showToast('Copied to clipboard!', 'success');
        } catch (err) {
            // Fallback for older browsers
            const textarea = document.createElement('textarea');
            textarea.value = text;
            document.body.appendChild(textarea);
            textarea.select();
            document.execCommand('copy');
            document.body.removeChild(textarea);
            this.showToast('Copied to clipboard!', 'success');
        }
    },
    
    async deleteMessage(id) {
        if (confirm('Are you sure you want to delete this message?')) {
            this.messages = this.messages.filter(m => m.id !== id);
            localStorage.setItem('ghostchat_history', JSON.stringify(this.messages));
            this.render();
            this.showToast('Message deleted', 'info');
            
            // Try to delete from server
            try {
                await fetch(`/api/messages/${id}`, {
                    method: 'DELETE',
                    credentials: 'include'
                });
            } catch (error) {
                console.log('Server delete failed');
            }
        }
    },
    
    clearAll() {
        if (confirm('Are you sure you want to clear ALL message history? This cannot be undone.')) {
            this.messages = [];
            localStorage.removeItem('ghostchat_history');
            this.render();
            this.showToast('All messages cleared', 'info');
        }
    },
    
    exportHistory() {
        const data = JSON.stringify(this.messages, null, 2);
        const blob = new Blob([data], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `ghostchat_history_${new Date().toISOString().slice(0, 19).replace(/:/g, '-')}.json`;
        a.click();
        URL.revokeObjectURL(url);
        this.showToast('History exported', 'success');
    },
    
    importMessages() {
        const input = document.createElement('input');
        input.type = 'file';
        input.accept = '.json';
        input.onchange = async (e) => {
            const file = e.target.files[0];
            if (!file) return;
            
            const reader = new FileReader();
            reader.onload = (event) => {
                try {
                    const importedMessages = JSON.parse(event.target.result);
                    if (Array.isArray(importedMessages)) {
                        this.messages = [...importedMessages, ...this.messages];
                        if (this.messages.length > 100) {
                            this.messages = this.messages.slice(0, 100);
                        }
                        this.saveMessages();
                        this.render();
                        this.showToast(`Imported ${importedMessages.length} messages`, 'success');
                    } else {
                        this.showToast('Invalid file format', 'error');
                    }
                } catch (err) {
                    this.showToast('Failed to parse file', 'error');
                }
            };
            reader.readAsText(file);
        };
        input.click();
    },
    
    updateNotificationCount() {
        const count = this.messages.filter(m => !m.read).length;
        const badge = document.getElementById('notificationCount');
        if (badge) {
            badge.textContent = count;
            badge.style.display = count > 0 ? 'flex' : 'none';
        }
    },
    
    setupEventListeners() {
        const exportBtn = document.getElementById('exportHistoryBtn');
        if (exportBtn) {
            const newBtn = exportBtn.cloneNode(true);
            exportBtn.parentNode.replaceChild(newBtn, exportBtn);
            newBtn.onclick = () => this.exportHistory();
        }
        
        const clearBtn = document.getElementById('clearHistoryBtn');
        if (clearBtn) {
            const newBtn = clearBtn.cloneNode(true);
            clearBtn.parentNode.replaceChild(newBtn, clearBtn);
            newBtn.onclick = () => this.clearAll();
        }
        
        const importBtn = document.getElementById('importHistoryBtn');
        if (importBtn) {
            const newBtn = importBtn.cloneNode(true);
            importBtn.parentNode.replaceChild(newBtn, importBtn);
            newBtn.onclick = () => this.importMessages();
        }
    },
    
    showToast(message, type) {
        if (window.UI && window.UI.showToast) {
            window.UI.showToast(message, type);
        } else {
            // Simple fallback toast
            const toast = document.createElement('div');
            toast.style.cssText = `position:fixed;bottom:20px;right:20px;background:#00f0ff;color:#000;padding:10px 20px;border-radius:8px;z-index:9999;`;
            toast.textContent = message;
            document.body.appendChild(toast);
            setTimeout(() => toast.remove(), 3000);
        }
    },
    
    escapeHtml(text) {
        if (!text) return '';
        const div = document.createElement('div');
        div.textContent = text;
        return div.innerHTML;
    }
};
