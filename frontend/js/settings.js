/**
 * GHOSTCHAT SETTINGS MODULE  v3.3
 * Keyboard: Enter on any input → save settings
 *
 * FIX: the "Sound effects" setting was being saved correctly all along —
 * the bug was that nothing in the app ever called UI.playSound() (see
 * ui.js and dashboard.js / chat-socket.js, which now call it on real
 * events). This module adds one more thing: a "Test" button next to the
 * toggle so the user can immediately hear whether it's working, instead of
 * only finding out the next time they encrypt/decrypt/receive a message.
 */

window.SettingsModule = {
    settings: null,

    async init() {
        this.loadSettings();
        this.setupEventListeners();
        this._syncThemeChips();
        this._injectTestSoundButton();
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

    // ── Small "Test" button next to the Sound effects toggle so the user
    // can confirm the setting actually works without waiting for a real
    // encrypt/decrypt/message event. ──
    _injectTestSoundButton() {
        const row = document.getElementById('soundEffects')?.closest('.setting-row');
        if (!row || row.querySelector('.btn-test-sound')) return;

        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'btn btn-ghost btn-sm btn-test-sound';
        btn.style.marginLeft = '8px';
        btn.innerHTML = '<i class="fas fa-volume-high"></i> Test';
        btn.addEventListener('click', () => {
            const wasEnabled = document.getElementById('soundEffects')?.checked;
            if (!wasEnabled) {
                if (window.UI) UI.showToast('Turn sound effects on first, then test', 'info');
                return;
            }
            if (window.UI?.playSound) window.UI.playSound('success');
        });

        const toggleWrap = document.getElementById('soundEffects')?.closest('.toggle-sw');
        if (toggleWrap) {
            toggleWrap.insertAdjacentElement('afterend', btn);
        } else {
            row.appendChild(btn);
        }
    },

    setupEventListeners() {
        const saveBtn = document.getElementById('saveSettingsBtn');
        if (saveBtn) {
            const fresh = saveBtn.cloneNode(true);
            saveBtn.parentNode.replaceChild(fresh, saveBtn);
            fresh.addEventListener('click', () => this.saveSettings());
        }

        ['encryptionAlgorithm', 'autoClear'].forEach(id => {
            document.getElementById(id)?.addEventListener('keydown', e => {
                if (e.key === 'Enter') { e.preventDefault(); this.saveSettings(); }
            });
        });

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
