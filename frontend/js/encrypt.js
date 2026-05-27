/**
 * GHOSTCHAT ENCRYPTION MODULE
 */

window.EncryptionModule = {
    lastEncryptedMessage: null,
    lastEncryptedPackage: null,
    lastEncryptedEmojiPackage: null,
    lastMetadata: null,
    
    init() {
        this.setupEventListeners();
    },
    
    setupEventListeners() {
        const encryptBtn = document.getElementById('encryptBtn');
        if (encryptBtn) {
            const newBtn = encryptBtn.cloneNode(true);
            encryptBtn.parentNode.replaceChild(newBtn, encryptBtn);
            newBtn.addEventListener('click', () => this.encryptMessage());
        }
        
        const plaintext = document.getElementById('plaintext');
        if (plaintext) {
            plaintext.addEventListener('input', () => this.clearResult());
            plaintext.addEventListener('keydown', (e) => {
                if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
                    e.preventDefault();
                    this.encryptMessage();
                }
            });
        }
        
        // Export buttons
        const exportWhatsApp = document.getElementById('exportWhatsApp');
        if (exportWhatsApp) {
            const newBtn = exportWhatsApp.cloneNode(true);
            exportWhatsApp.parentNode.replaceChild(newBtn, exportWhatsApp);
            newBtn.addEventListener('click', () => this.exportToWhatsApp());
        }
        
        const exportTelegram = document.getElementById('exportTelegram');
        if (exportTelegram) {
            const newBtn = exportTelegram.cloneNode(true);
            exportTelegram.parentNode.replaceChild(newBtn, exportTelegram);
            newBtn.addEventListener('click', () => this.exportToTelegram());
        }
        
        const exportDiscord = document.getElementById('exportDiscord');
        if (exportDiscord) {
            const newBtn = exportDiscord.cloneNode(true);
            exportDiscord.parentNode.replaceChild(newBtn, exportDiscord);
            newBtn.addEventListener('click', () => this.exportToDiscord());
        }
        
        const exportSMS = document.getElementById('exportSMS');
        if (exportSMS) {
            const newBtn = exportSMS.cloneNode(true);
            exportSMS.parentNode.replaceChild(newBtn, exportSMS);
            newBtn.addEventListener('click', () => this.exportToSMS());
        }
        
        const exportEmail = document.getElementById('exportEmail');
        if (exportEmail) {
            const newBtn = exportEmail.cloneNode(true);
            exportEmail.parentNode.replaceChild(newBtn, exportEmail);
            newBtn.addEventListener('click', () => this.exportToEmail());
        }
        
        const exportCopy = document.getElementById('exportCopy');
        if (exportCopy) {
            const newBtn = exportCopy.cloneNode(true);
            exportCopy.parentNode.replaceChild(newBtn, exportCopy);
            newBtn.addEventListener('click', () => this.copyToClipboard());
        }
        
        const exportSave = document.getElementById('exportSave');
        if (exportSave) {
            const newBtn = exportSave.cloneNode(true);
            exportSave.parentNode.replaceChild(newBtn, exportSave);
            newBtn.addEventListener('click', () => this.saveToFile());
        }
    },
    
    async encryptMessage() {
        const plaintext = document.getElementById('plaintext').value;
        const password = document.getElementById('encryptPassword').value;
        const useDecoys = document.getElementById('useDecoys')?.checked || false;
        
        if (!plaintext) {
            this.showError('Please enter a message to encrypt');
            return;
        }
        
        if (!password) {
            this.showError('Please enter an encryption password');
            return;
        }
        
        this.setLoading(true);
        
        try {
            const result = await window.GhostChatAPI.encryptSimple(plaintext, password, useDecoys);
            
            if (result.success) {
                this.lastEncryptedMessage = result.emoji_message;
                this.lastMetadata = result.metadata;
                this.lastEncryptedPackage = result.metadata ? {
                    emojis: result.emoji_message,
                    iv: result.metadata.iv,
                    signature: result.metadata.signature,
                    key_id: result.metadata.key_id,
                    salt: result.metadata.salt,
                } : null;
                this.lastEncryptedEmojiPackage = result.emoji_package || null;
                this.displayResult(result);
                this.showExportSection(true);
                this.showToast('Message encrypted successfully!', 'success');
                
                if (window.HistoryModule && window.HistoryModule.addMessage) {
                    window.HistoryModule.addMessage(plaintext, result.emoji_message, 'encryption');
                }
            } else {
                this.showError(result.error || 'Encryption failed');
                this.showExportSection(false);
            }
        
        } catch (error) {
            console.error('Encryption error:', error);
            this.showError(`Encryption failed: ${error.message}`);
            this.showExportSection(false);
        } finally {
            this.setLoading(false);
        }
    },
    
    displayResult(result) {
        const resultDiv = document.getElementById('encryptResult');
        if (resultDiv) {
            resultDiv.innerHTML = `
                <div class="result-header" style="margin-top: 20px; padding: 15px; background: rgba(0,255,136,0.1); border-radius: 8px;">
                    <i class="fas fa-check-circle" style="color: #00ff88;"></i>
                    <h3 style="display: inline; margin-left: 10px;">Message Encrypted</h3>
                </div>
                <div class="result-content" style="margin-top: 15px;">
                    <div class="info-group">
                        <label style="display: block; margin-bottom: 5px; color: #00f0ff;">Encrypted Message (Copy & Share):</label>
                        <pre style="word-wrap: break-word; white-space: pre-wrap; background: rgba(0,0,0,0.3); padding: 15px; border-radius: 8px; font-family: monospace;">${this.escapeHtml(result.emoji_message || 'No output')}</pre>
                    </div>
                    <div class="info-group" style="margin-top: 10px; font-size: 12px; color: #666;">
                        <span>Share this emoji message. Recipient needs the same password to decrypt.</span>
                        <div><strong>Emojis Used:</strong> ${result.emoji_count || 0}</div>
                    </div>
                </div>
            `;
        }
    },
    
    showExportSection(show) {
        const exportSection = document.getElementById('exportSection');
        if (exportSection) {
            exportSection.style.display = show ? 'block' : 'none';
        }
    },
    
    exportToWhatsApp() {
        if (!this.lastEncryptedMessage) return;
        const phone = prompt('Enter phone number (with country code):');
        if (phone) {
            const url = `https://wa.me/${phone.replace(/\D/g, '')}?text=${encodeURIComponent(this.lastEncryptedMessage)}`;
            window.open(url, '_blank');
            this.showToast('Opening WhatsApp...', 'success');
        }
    },
    
    exportToTelegram() {
        if (!this.lastEncryptedMessage) return;
        const username = prompt('Enter Telegram username (without @):');
        if (username) {
            const url = `https://t.me/${username}?text=${encodeURIComponent(this.lastEncryptedMessage)}`;
            window.open(url, '_blank');
            this.showToast('Opening Telegram...', 'success');
        }
    },
    
    exportToDiscord() {
        if (!this.lastEncryptedMessage) return;
        navigator.clipboard.writeText(this.lastEncryptedMessage);
        this.showToast('Message copied! You can paste it in Discord.', 'success');
    },
    
    exportToSMS() {
        if (!this.lastEncryptedMessage) return;
        const phone = prompt('Enter phone number:');
        if (phone) {
            window.location.href = `sms:${phone}?body=${encodeURIComponent(this.lastEncryptedMessage)}`;
            this.showToast('Opening SMS...', 'success');
        }
    },
    
    exportToEmail() {
        if (!this.lastEncryptedMessage) return;
        const email = prompt('Enter email address:');
        if (email) {
            const subject = 'Encrypted GhostChat Message';
            window.location.href = `mailto:${email}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(this.lastEncryptedMessage)}`;
            this.showToast('Opening email client...', 'success');
        }
    },
    
    copyToClipboard() {
        const emojiText = this.lastEncryptedMessage;
        if (!emojiText) return;
        
        const textarea = document.createElement('textarea');
        textarea.value = emojiText;
        textarea.style.position = 'fixed';
        textarea.style.opacity = '0';
        document.body.appendChild(textarea);
        textarea.select();
        textarea.setSelectionRange(0, 99999);
        
        try {
            document.execCommand('copy');
            this.showToast('Emoji message copied! Share with recipient.', 'success');
        } catch (err) {
            navigator.clipboard.writeText(emojiText).then(() => {
                this.showToast('Emoji message copied!', 'success');
            }).catch(() => {
                this.showError('Failed to copy');
            });
        }
        
        document.body.removeChild(textarea);
    },
    
    saveToFile() {
        const content = this.lastEncryptedEmojiPackage
            || (this.lastEncryptedPackage ? JSON.stringify(this.lastEncryptedPackage, null, 2) : this.lastEncryptedMessage);
        if (!content) return;
        const blob = new Blob([content], { type: 'text/plain' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `ghostchat_encrypted_${Date.now()}.txt`;
        a.click();
        URL.revokeObjectURL(url);
        this.showToast('Saved to file!', 'success');
    },
    
    setLoading(isLoading) {
        const btn = document.getElementById('encryptBtn');
        if (btn) {
            if (isLoading) {
                btn.disabled = true;
                btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Encrypting...';
            } else {
                btn.disabled = false;
                btn.innerHTML = '<i class="fas fa-ghost"></i> Encrypt & Obfuscate';
            }
        }
    },
    
    clearResult() {
        const resultDiv = document.getElementById('encryptResult');
        if (resultDiv) {
            resultDiv.innerHTML = '';
        }
        this.showExportSection(false);
        this.lastEncryptedMessage = null;
        this.lastEncryptedPackage = null;
        this.lastEncryptedEmojiPackage = null;
    },
    
    showError(message) {
        const resultDiv = document.getElementById('encryptResult');
        if (resultDiv) {
            resultDiv.innerHTML = `
                <div class="error-message" style="color: #ff0055; padding: 1rem; background: rgba(255,0,85,0.1); border-radius: 8px; margin-top: 20px;">
                    <i class="fas fa-exclamation-triangle"></i>
                    <span style="margin-left: 10px;">${message}</span>
                </div>
            `;
        }
    },
    
    showToast(message, type) {
        if (window.UI && window.UI.showToast) {
            window.UI.showToast(message, type);
        } else {
            console.log(`[${type}] ${message}`);
            alert(message);
        }
    },
    
    escapeHtml(text) {
        const div = document.createElement('div');
        div.textContent = text;
        return div.innerHTML;
    }
};
