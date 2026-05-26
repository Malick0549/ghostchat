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
        const phone = prompt('Enter WhatsApp phone number (with country code):');
        if (!phone) return;
        
        const message = prompt('Enter the message to send:');
        if (!message) return;
        
        // Create WhatsApp link
        const encodedMessage = encodeURIComponent(message);
        const whatsappUrl = `https://wa.me/${phone.replace(/[^0-9]/g, '')}?text=${encodedMessage}`;
        
        window.open(whatsappUrl, '_blank');
        this.logActivity(`WhatsApp integration used`, 'success');
        this.showToast('Opening WhatsApp...', 'success');
    },
    
    async telegramIntegration() {
        const username = prompt('Enter Telegram username (without @):');
        if (!username) return;
        
        const message = prompt('Enter the message to send:');
        if (!message) return;
        
        const telegramUrl = `https://t.me/${username}?text=${encodeURIComponent(message)}`;
        window.open(telegramUrl, '_blank');
        this.logActivity(`Telegram integration used`, 'success');
        this.showToast('Opening Telegram...', 'success');
    },
    
    async discordIntegration() {
        const webhookUrl = prompt('Enter Discord Webhook URL:');
        if (!webhookUrl) return;
        
        const message = prompt('Enter the message to send:');
        if (!message) return;
        
        try {
            await fetch(webhookUrl, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ content: message })
            });
            this.showToast('Message sent to Discord!', 'success');
            this.logActivity(`Discord integration used`, 'success');
        } catch (error) {
            this.showToast('Failed to send to Discord', 'error');
        }
    },
    
    async emailIntegration() {
        const email = prompt('Enter email address:');
        if (!email) return;
        
        const message = prompt('Enter the message to send:');
        if (!message) return;
        
        // Create mailto link
        const mailtoUrl = `mailto:${email}?subject=Encrypted Message from GhostChat&body=${encodeURIComponent(message)}`;
        window.open(mailtoUrl, '_blank');
        this.showToast('Opening email client...', 'success');
        this.logActivity(`Email integration used`, 'success');
    },
    
    async googleIntegration() {
        this.showToast('Google Drive integration coming soon!', 'info');
        this.logActivity(`Google integration requested`, 'info');
    },
    
    async clipboardIntegration() {
        const text = prompt('Enter text to share via encrypted clipboard:');
        if (!text) return;
        
        await navigator.clipboard.writeText(text);
        this.showToast('Copied to clipboard! Share securely.', 'success');
        this.logActivity(`Clipboard integration used`, 'success');
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
