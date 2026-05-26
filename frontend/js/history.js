/**
 * GHOSTCHAT HISTORY MODULE
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
        const now = new Date().toISOString();
        const newMessage = {
            id: Date.now(),
            plaintext: plaintext.substring(0, 500),
            encrypted: encrypted,
            emoji_content: encrypted,
            encrypted_content: encrypted,
            type: type,
            timestamp: now,
            date_created: now,
            created_at: now
        };
        
        this.messages.unshift(newMessage);
        
        // Keep only last 100 messages
        if (this.messages.length > 100) {
            this.messages = this.messages.slice(0, 100);
        }
        
        this.saveMessages();
        this.render();
        this.updateNotificationCount();
        this.showToast('Message saved to history', 'success');
    },
    
    render() {
        const container = document.getElementById('historyList');
        if (!container) return;
        
        if (this.messages.length === 0) {
            container.innerHTML = `
                <div class="empty-state">
                    <i class="fas fa-inbox"></i>
                    <p>No messages yet. Encrypt your first message!</p>
                </div>
            `;
            return;
        }
        
        container.innerHTML = this.messages.map(msg => `
            <div class="history-item glass" data-id="${msg.id}">
                <div class="history-header">
                    <span class="history-type ${msg.type}">
                        <i class="fas ${msg.type === 'encryption' ? 'fa-lock' : 'fa-unlock'}"></i>
                        ${msg.type === 'encryption' ? 'ENCRYPTED' : 'DECRYPTED'}
                    </span>
                    <span class="history-time" style="font-size: 0.85rem; opacity: 0.8;">${msg.timestamp ? new Date(msg.timestamp).toLocaleString() : 'N/A'}</span>
                </div>
                <div class="history-content">
                    <div class="history-plaintext">
                        <strong>Plaintext:</strong>
                        <pre style="white-space: pre-wrap; word-break: break-word; margin: .5rem 0 0 0; padding: .75rem; background: rgba(255,255,255,0.06); border-radius: 8px;">${this.escapeHtml(msg.plaintext || msg.decrypted_message || '')}</pre>
                    </div>
                    <div class="history-encrypted" style="margin-top: 1rem;">
                        <strong>Encrypted/Package:</strong>
                        <pre style="white-space: pre-wrap; word-break: break-word; max-height: 160px; overflow: auto; margin: .5rem 0 0 0; padding: .75rem; background: rgba(255,255,255,0.06); border-radius: 8px;">${this.escapeHtml(msg.encrypted || msg.emoji_content || '')}</pre>
                        <button class="btn-copy-small" onclick="HistoryModule.copyEncrypted('${this.escapeHtml(msg.encrypted || msg.emoji_content || '').replace(/'/g, "\\'")}')">
                            <i class="fas fa-copy"></i>
                        </button>
                    </div>
                </div>
                <button class="history-delete" onclick="HistoryModule.deleteMessage(${msg.id})">
                    <i class="fas fa-trash"></i>
                </button>
            </div>
        `).join('');
    },
    
    async deleteMessage(id) {
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
    },
    
    clearAll() {
        if (confirm('Are you sure you want to clear all message history?')) {
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
        a.download = `ghostchat_history_${new Date().toISOString().slice(0,19)}.json`;
        a.click();
        URL.revokeObjectURL(url);
        this.showToast('History exported', 'success');
    },
    
    copyEncrypted(text) {
        navigator.clipboard.writeText(text);
        this.showToast('Copied to clipboard', 'success');
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
    
    showToast(message, type) {
        if (window.UI && window.UI.showToast) {
            window.UI.showToast(message, type);
        } else {
            console.log(`[${type}] ${message}`);
            // Create simple toast
            const toast = document.createElement('div');
            toast.style.cssText = 'position:fixed;bottom:20px;right:20px;background:#00f0ff;color:#000;padding:10px20px;border-radius:8px;z-index:9999;';
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