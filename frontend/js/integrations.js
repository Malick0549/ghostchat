/**
 * GHOSTCHAT INTEGRATIONS MODULE
 */

window.IntegrationsModule = {
    init() {
        this.setupEventListeners();
    },
    
    setupEventListeners() {
        const cards = document.querySelectorAll('.integration-card');
        cards.forEach(card => {
            const btn = card.querySelector('.btn-integration');
            if (btn) {
                btn.addEventListener('click', () => {
                    const service = card.dataset.service;
                    this.handleIntegration(service);
                });
            }
        });
    },
    
    async handleIntegration(service) {
        switch(service) {
            case 'whatsapp':
                await this.whatsappIntegration();
                break;
            case 'telegram':
                await this.telegramIntegration();
                break;
            case 'discord':
                await this.discordIntegration();
                break;
            case 'email':
                await this.emailIntegration();
                break;
            case 'sms':
                await this.smsIntegration();
                break;
            case 'google':
                await this.googleIntegration();
                break;
            case 'clipboard':
                await this.clipboardIntegration();
                break;
            default:
                this.showToast('Integration coming soon!', 'info');
        }
    },
    
    async whatsappIntegration() {
        const r = await GhostShare.ask({ title: 'Send on WhatsApp', label: 'Phone number with country code (e.g. +233…)', placeholder: '+233…', message: GhostShare.latest() });
        if (!r) return;
        await GhostShare.whatsapp(r.target, r.message);
        this.logActivity('WhatsApp integration used', 'success');
    },
    
    async telegramIntegration() {
        const r = await GhostShare.ask({ title: 'Send on Telegram', label: 'Telegram username (without @)', message: GhostShare.latest() });
        if (!r) return;
        await GhostShare.telegram(r.target, r.message);
        this.logActivity('Telegram integration used', 'success');
    },
    
    async discordIntegration() {
        const r = await GhostShare.ask({ title: 'Post to Discord', label: 'Discord webhook URL', message: GhostShare.latest() });
        if (!r) return;
        try {
            const res = await fetch(r.target, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ content: r.message }) });
            if (!res.ok) throw new Error('bad status');
            this.showToast('Message sent to Discord!', 'success');
            this.logActivity('Discord integration used', 'success');
        } catch (error) {
            await GhostShare.copy(r.message);
            this.showToast('Could not post to Discord. The message is copied, so paste it there.', 'error');
        }
    },
    
    async emailIntegration() {
        const r = await GhostShare.ask({ title: 'Send by email', label: 'Recipient email address', message: GhostShare.latest() });
        if (!r) return;
        await GhostShare.email(r.target, r.message);
        this.logActivity('Email integration used', 'success');
    },
    
    async smsIntegration() {
        const r = await GhostShare.ask({ title: 'Send by SMS', label: 'Phone number with country code', message: GhostShare.latest() });
        if (!r) return;
        await GhostShare.sms(r.target, r.message);
        this.logActivity('SMS integration used', 'success');
    },
    
    async googleIntegration() {
        this.showToast('Google Drive integration coming soon!', 'info');
        this.logActivity(`Google integration requested`, 'info');
    },
    
    async clipboardIntegration() {
        const r = await GhostShare.ask({ title: 'Copy encrypted message', needTarget: false, message: GhostShare.latest() });
        if (!r) return;
        await GhostShare.copy(r.message);
        this.showToast('Copied exactly as it is. Paste it where you like.', 'success');
        this.logActivity('Clipboard integration used', 'success');
    },
    
    showToast(message, type) {
        if (window.UI) {
            window.UI.showToast(message, type);
        } else {
            alert(message);
        }
    },
    
    logActivity(message, type) {
        console.log(`[${type.toUpperCase()}] ${message}`);
    }
};
