window.DecryptionModule = {
    init() {
        this.setupEventListeners();
    },
    
    setupEventListeners() {
        const decryptBtn = document.getElementById('decryptBtn');
        if (decryptBtn) {
            const newBtn = decryptBtn.cloneNode(true);
            decryptBtn.parentNode.replaceChild(newBtn, decryptBtn);
            newBtn.addEventListener('click', () => this.decryptMessage());
        }
        
        const ciphertext = document.getElementById('ciphertext');
        if (ciphertext) {
            ciphertext.addEventListener('keydown', (e) => {
                if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
                    e.preventDefault();
                    this.decryptMessage();
                }
            });
        }
        
        const importBtn = document.getElementById('importBtn');
        if (importBtn) {
            const newImportBtn = importBtn.cloneNode(true);
            importBtn.parentNode.replaceChild(newImportBtn, importBtn);
            newImportBtn.addEventListener('click', () => this.importFromFile());
        }
        
        const importFile = document.getElementById('importFile');
        if (importFile) {
            importFile.addEventListener('change', (e) => this.handleFileSelect(e));
        }
    },
    
    importFromFile() {
        document.getElementById('importFile').click();
    },
    
    handleFileSelect(event) {
        const file = event.target.files[0];
        if (!file) return;
        
        const reader = new FileReader();
        reader.onload = (e) => {
            const content = e.target.result;
            const textarea = document.getElementById('ciphertext');
            if (textarea) {
                textarea.value = content.trim();
                this.showToast('File imported successfully!', 'success');
            }
        };
        reader.readAsText(file);
    },
    
    async decryptMessage() {
        const ciphertext = document.getElementById('ciphertext').value;
        const password = document.getElementById('decryptPassword').value;
        
        if (!ciphertext) {
            this.showError('Please enter or import an encrypted message');
            return;
        }
        
        if (!password) {
            this.showError('Please enter the decryption password');
            return;
        }
        
        this.setLoading(true);
        
        try {
            // Use decryptSimple which handles IV management
            const result = await window.GhostChatAPI.decryptSimple(ciphertext, password);
            
            if (result.success) {
                this.displayResult(result);
                this.showToast('Message decrypted successfully!', 'success');
                
                if (window.HistoryModule && window.HistoryModule.addMessage) {
                    window.HistoryModule.addMessage(result.decrypted_message, ciphertext, 'decryption');
                }
            } else {
                const msg = result.error || 'Decryption failed. Wrong password or corrupted message.';
                if (msg.includes('Metadata missing or empty fields')) {
                    this.showError('Decryption failed: this message requires a full GhostChat package. Paste the JSON package or the emoji-only package string here.');
                } else if (msg.includes('Message authentication failed') || msg.includes('Unexpected error')) {
                    this.showError('Decryption failed: wrong password or corrupted message. Verify your password and try again.');
                } else {
                    this.showError(msg);
                }
            }
        } catch (error) {
            console.error('Decryption error:', error);
            this.showError(`Decryption failed: ${error.message}. If this is a GhostChat package, make sure it includes iv, signature, key_id, and salt.`);
        } finally {
            this.setLoading(false);
        }
    },
    
    displayResult(result) {
        const resultDiv = document.getElementById('decryptResult');
        if (resultDiv) {
            resultDiv.innerHTML = `
                <div class="result-header" style="margin-top: 20px; padding: 15px; background: rgba(0,255,136,0.1); border-radius: 8px;">
                    <i class="fas fa-check-circle" style="color: #00ff88;"></i>
                    <h3 style="display: inline; margin-left: 10px;">Decryption Complete</h3>
                </div>
                <div class="result-content" style="margin-top: 15px;">
                    <div class="info-group">
                        <label style="display: block; margin-bottom: 5px; color: #00f0ff;">Decrypted Message:</label>
                        <pre style="word-wrap: break-word; white-space: pre-wrap; background: rgba(0,0,0,0.3); padding: 15px; border-radius: 8px;">${this.escapeHtml(result.decrypted_message)}</pre>
                    </div>
                    <div class="info-group" style="margin-top: 10px;">
                        <label style="color: #00f0ff;">Algorithm:</label>
                        <div style="margin-top: 5px;">${result.algorithm || 'AES-256-GCM'}</div>
                    </div>
                </div>
            `;
        }
    },
    
    setLoading(isLoading) {
        const btn = document.getElementById('decryptBtn');
        if (btn) {
            if (isLoading) {
                btn.disabled = true;
                btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Decrypting...';
            } else {
                btn.disabled = false;
                btn.innerHTML = '<i class="fas fa-ghost"></i> Decrypt Message';
            }
        }
    },
    
    showError(message) {
        const resultDiv = document.getElementById('decryptResult');
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
    
    logActivity(message, type) {
        console.log(`[${type.toUpperCase()}] ${message}`);
        if (window.GhostChatAPI && window.GhostChatAPI.logActivity) {
            window.GhostChatAPI.logActivity(message, type);
        }
    },
    
    escapeHtml(text) {
        const div = document.createElement('div');
        div.textContent = text;
        return div.innerHTML;
    }
};