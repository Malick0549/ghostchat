/**
 * GHOSTCHAT SETTINGS MODULE
 */

window.SettingsModule = {
    settings: null,
    
    async init() {
        await this.loadSettings();
        this.setupEventListeners();
    },
    
    loadSettings() {
        const saved = localStorage.getItem('ghostchat_settings');
        if (saved) {
            this.settings = JSON.parse(saved);
        } else {
            this.settings = {
                encryptionAlgorithm: 'AES-256-CBC',
                autoClear: 'never',
                notifyEncrypt: true,
                notifyDecrypt: true,
                soundEffects: false
            };
        }
        this.render();
    },
    
    render() {
        const algorithmSelect = document.getElementById('encryptionAlgorithm');
        const autoClearSelect = document.getElementById('autoClear');
        const notifyEncrypt = document.getElementById('notifyEncrypt');
        const notifyDecrypt = document.getElementById('notifyDecrypt');
        const soundEffects = document.getElementById('soundEffects');
        
        if (algorithmSelect) algorithmSelect.value = this.settings.encryptionAlgorithm;
        if (autoClearSelect) autoClearSelect.value = this.settings.autoClear;
        if (notifyEncrypt) notifyEncrypt.checked = this.settings.notifyEncrypt;
        if (notifyDecrypt) notifyDecrypt.checked = this.settings.notifyDecrypt;
        if (soundEffects) soundEffects.checked = this.settings.soundEffects;
    },
    
    saveSettings() {
        this.settings = {
            encryptionAlgorithm: document.getElementById('encryptionAlgorithm').value,
            autoClear: document.getElementById('autoClear').value,
            notifyEncrypt: document.getElementById('notifyEncrypt').checked,
            notifyDecrypt: document.getElementById('notifyDecrypt').checked,
            soundEffects: document.getElementById('soundEffects').checked
        };
        
        localStorage.setItem('ghostchat_settings', JSON.stringify(this.settings));
        this.showToast('Settings saved!', 'success');
        this.logActivity('Settings updated', 'success');
    },
    
    setupEventListeners() {
        const saveBtn = document.getElementById('saveSettingsBtn');
        if (saveBtn) {
            const newBtn = saveBtn.cloneNode(true);
            saveBtn.parentNode.replaceChild(newBtn, saveBtn);
            newBtn.onclick = () => this.saveSettings();
        }
    },
    
    showToast(message, type) {
        if (window.UI && window.UI.showToast) {
            window.UI.showToast(message, type);
        } else {
            alert(message);
        }
    },
    
    logActivity(message, type) {
        console.log(`[${type.toUpperCase()}] ${message}`);
    }
};
