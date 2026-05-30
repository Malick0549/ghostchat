/**
 * GHOSTCHAT SETTINGS MODULE  v3.2
 * Keyboard: Enter on any input → save settings
 */

window.SettingsModule = {
    settings: null,

    async init() {
        this.loadSettings();
        this.setupEventListeners();
        this._syncThemeChips();
    },

    loadSettings() {
        const saved = localStorage.getItem('ghostchat_settings');
        this.settings = saved ? JSON.parse(saved) : {
            encryptionAlgorithm: 'AES-256-CBC',
            autoClear:           'never',
            notifyEncrypt:       true,
            notifyDecrypt:       true,
            soundEffects:        false,
        };
        this.render();
    },

    render() {
        const set = (id, val) => {
            const el = document.getElementById(id);
            if (!el) return;
            if (el.type === 'checkbox') el.checked = !!val;
            else el.value = val;
        };
        set('encryptionAlgorithm', this.settings.encryptionAlgorithm);
        set('autoClear',           this.settings.autoClear);
        set('notifyEncrypt',       this.settings.notifyEncrypt);
        set('notifyDecrypt',       this.settings.notifyDecrypt);
        set('soundEffects',        this.settings.soundEffects);
    },

    saveSettings() {
        const get     = id => document.getElementById(id);
        const checked = id => get(id)?.checked ?? false;
        const val     = id => get(id)?.value    ?? '';

        this.settings = {
            encryptionAlgorithm: val('encryptionAlgorithm') || 'AES-256-CBC',
            autoClear:           val('autoClear')           || 'never',
            notifyEncrypt:       checked('notifyEncrypt'),
            notifyDecrypt:       checked('notifyDecrypt'),
            soundEffects:        checked('soundEffects'),
        };

        localStorage.setItem('ghostchat_settings', JSON.stringify(this.settings));
        if (window.UI) UI.showToast('Settings saved!', 'success');
    },

    setupEventListeners() {
        // Save button
        const saveBtn = document.getElementById('saveSettingsBtn');
        if (saveBtn) {
            const fresh = saveBtn.cloneNode(true);
            saveBtn.parentNode.replaceChild(fresh, saveBtn);
            fresh.addEventListener('click', () => this.saveSettings());
        }

        // Enter on any select → save
        ['encryptionAlgorithm', 'autoClear'].forEach(id => {
            document.getElementById(id)?.addEventListener('keydown', e => {
                if (e.key === 'Enter') { e.preventDefault(); this.saveSettings(); }
            });
        });

        // Theme option chips (injected by dashboard template)
        document.querySelectorAll('.theme-option[data-theme]').forEach(btn => {
            btn.addEventListener('click', () => {
                window.themeManager?.set(btn.dataset.theme);
                this._syncThemeChips();
            });
        });
    },

    _syncThemeChips() {
        const current = window.themeManager?.get() || 'dark';
        document.querySelectorAll('.theme-option[data-theme]').forEach(btn => {
            btn.classList.toggle('active', btn.dataset.theme === current);
        });
    },

    showToast(msg, type) {
        if (window.UI) UI.showToast(msg, type);
    },
};