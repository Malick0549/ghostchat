/**
 * GHOSTCHAT PROFILE MODULE  v3.2
 * Fixes:
 *   • Avatar upload: pass File directly to uploadAvatar(), not FormData
 *   • Avatar display: build correct absolute URL for Render.com
 *   • Enter key on profile inputs → save
 */

window.ProfileModule = {
    user: null,

    async init() {
        await this.loadProfile();
        this.setupEventListeners();
    },

    async loadProfile() {
        try {
            const data = await window.GhostChatAPI.getCurrentUser();
            this.user  = data.user;
        } catch (_) {
            const saved = localStorage.getItem('ghostchat_user');
            this.user = saved ? JSON.parse(saved) : {
                id: '', username: 'GhostUser',
                email: 'user@ghostchat.local',
                two_factor_enabled: false,
                avatar: null,
            };
        }
        this.render();
    },

    render() {
        const un   = document.getElementById('profileUsername');
        const em   = document.getElementById('profileEmail');
        const tf   = document.getElementById('twoFactorToggle');
        const img  = document.getElementById('profileAvatar');

        if (un) un.value = this.user?.username || '';
        if (em) em.value = this.user?.email    || '';
        if (tf) tf.checked = !!this.user?.two_factor_enabled;

        // Build correct avatar URL — handles relative paths on Render
        const avatarPath = this.user?.avatar;
        const avatarUrl  = avatarPath
            ? (avatarPath.startsWith('http')
                ? avatarPath
                : `${window.location.origin}${avatarPath.startsWith('/') ? '' : '/'}${avatarPath}`)
            : null;

        if (img) {
            if (avatarUrl) {
                img.src      = `${avatarUrl}?t=${Date.now()}`;
                img.onerror  = () => {
                    img.onerror = null;
                    img.src = '/assets/images/default-avatar.png';
                };
            } else {
                img.src = '/assets/images/default-avatar.png';
            }
        }

        this._updateNavbar(avatarUrl);
    },

    async saveProfile() {
        const username = (document.getElementById('profileUsername')?.value || '').trim();
        const email    = (document.getElementById('profileEmail')?.value    || '').trim();
        const tf       = document.getElementById('twoFactorToggle')?.checked || false;

        if (!username) { this.showToast('Username cannot be empty', 'error'); return; }
        if (!email)    { this.showToast('Email cannot be empty',    'error'); return; }

        this._setLoading(true);
        try {
            const data = await window.GhostChatAPI.updateProfile({
                username, email, two_factor_enabled: tf,
            });
            this.user = data.user;
            localStorage.setItem('ghostchat_user', JSON.stringify(this.user));
            this.render();
            this.showToast('Profile saved!', 'success');
        } catch (err) {
            this.showToast(err.message || 'Save failed', 'error');
        } finally {
            this._setLoading(false);
        }
    },

    async uploadAvatar(file) {
        if (!file) return;
        if (file.size > 2 * 1024 * 1024) {
            this.showToast('Image must be under 2 MB', 'error');
            return;
        }

        this.showToast('Uploading…', 'info');

        try {
            // GhostChatAPI.uploadAvatar() wraps the File in FormData internally
            const data = await window.GhostChatAPI.uploadAvatar(file);

            if (data.success && data.avatar) {
                this.user.avatar = data.avatar;
                localStorage.setItem('ghostchat_user', JSON.stringify(this.user));
                this.render();
                this.showToast('Avatar updated!', 'success');
            } else {
                throw new Error(data.error || 'Upload failed');
            }
        } catch (err) {
            this.showToast(err.message || 'Avatar upload failed', 'error');
        }
    },

    _updateNavbar(avatarUrl) {
        const initials = (
            (this.user?.firstName?.[0] || this.user?.username?.[0] || 'G') +
            (this.user?.lastName?.[0]  || this.user?.username?.[1] || 'H')
        ).toUpperCase();

        // Try img tag first (already replaced from earlier render)
        const avatarImg = document.getElementById('avatarImg');
        if (avatarImg && avatarUrl) {
            avatarImg.src    = `${avatarUrl}?t=${Date.now()}`;
            avatarImg.onerror = () => { avatarImg.onerror = null; avatarImg.src = '/assets/images/default-avatar.png'; };
            return;
        }

        const initialsEl = document.getElementById('avatarInitials');
        if (!initialsEl) return;

        if (avatarUrl) {
            initialsEl.outerHTML = `<img id="avatarImg"
                src="${avatarUrl}?t=${Date.now()}"
                alt="${initials}"
                style="width:100%;height:100%;object-fit:cover;border-radius:50%;"
                onerror="this.outerHTML='<span id=\\'avatarInitials\\'>${initials}</span>';" />`;
        } else {
            initialsEl.textContent = initials;
        }
    },

    setupEventListeners() {
        // Save button
        const saveBtn = document.getElementById('saveProfileBtn');
        if (saveBtn) {
            const fresh = saveBtn.cloneNode(true);
            saveBtn.parentNode.replaceChild(fresh, saveBtn);
            fresh.addEventListener('click', () => this.saveProfile());
        }

        // Avatar upload button
        const changeBtn  = document.getElementById('changeAvatarBtn');
        const fileInput  = document.getElementById('avatarUpload');
        if (changeBtn && fileInput) {
            changeBtn.addEventListener('click', () => fileInput.click());
            fileInput.addEventListener('change', e => {
                const file = e.target.files?.[0];
                if (file) this.uploadAvatar(file);
            });
        }

        // ── Keyboard: Enter on profile inputs → save ──────────────
        ['profileUsername', 'profileEmail'].forEach(id => {
            document.getElementById(id)?.addEventListener('keydown', e => {
                if (e.key === 'Enter') { e.preventDefault(); this.saveProfile(); }
            });
        });
    },

    _setLoading(on) {
        const btn = document.getElementById('saveProfileBtn');
        if (!btn) return;
        btn.disabled  = on;
        btn.innerHTML = on
            ? '<i class="fas fa-spinner fa-spin"></i> Saving…'
            : '<i class="fas fa-save"></i> Save Changes';
    },

    showToast(msg, type) {
        if (window.UI) UI.showToast(msg, type);
    },
};