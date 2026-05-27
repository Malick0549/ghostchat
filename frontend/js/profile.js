/**
 * GHOSTCHAT PROFILE MODULE
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
            this.user = data.user;
        } catch (error) {
            console.error('Failed to load profile:', error);
            // Fallback to localStorage
            const saved = localStorage.getItem('ghostchat_user');
            if (saved) {
                this.user = JSON.parse(saved);
            } else {
                this.user = {
                    id: 'local',
                    username: 'GhostUser',
                    email: 'user@ghostchat.local',
                    two_factor_enabled: false,
                    avatar: '/assets/images/default-avatar.png'
                };
            }
        }
        this.render();
    },
    
    render() {
        const usernameInput = document.getElementById('profileUsername');
        const emailInput = document.getElementById('profileEmail');
        const twoFactorToggle = document.getElementById('twoFactorToggle');
        const avatarImg = document.getElementById('profileAvatar');
        
        if (usernameInput) usernameInput.value = this.user?.username || '';
        if (emailInput) emailInput.value = this.user?.email || '';
        if (twoFactorToggle) twoFactorToggle.checked = this.user?.two_factor_enabled || false;
        
        // Fix avatar URL
        if (avatarImg) {
            const avatarUrl = this.user?.avatar || '/assets/images/default-avatar.png';
            avatarImg.src = avatarUrl + '?t=' + Date.now(); // Cache bust
            avatarImg.onerror = () => {
                avatarImg.src = '/assets/images/default-avatar.png';
            };
        }
    },
    
    async saveProfile() {
        const username = document.getElementById('profileUsername').value;
        const email = document.getElementById('profileEmail').value;
        const twoFactorEnabled = document.getElementById('twoFactorToggle').checked;
        
        this.setLoading(true);
        
        try {
            const data = await window.GhostChatAPI.updateProfile({
                username,
                email,
                two_factor_enabled: twoFactorEnabled,
            });
            this.user = data.user;
            localStorage.setItem('ghostchat_user', JSON.stringify(this.user));
            this.showToast('Profile saved successfully!', 'success');
            this.updateNavbarAvatar();
        } catch (error) {
            this.showToast(error.message, 'error');
        } finally {
            this.setLoading(false);
        }
    },
    
    async uploadAvatar(file) {
        const formData = new FormData();
        formData.append('avatar', file);
        
        this.showToast('Uploading...', 'info');
        
        try {
            const data = await window.GhostChatAPI.uploadAvatar(formData);
            if (data.avatar) {
                this.user.avatar = data.avatar;
                localStorage.setItem('ghostchat_user', JSON.stringify(this.user));
                this.render();
                this.updateNavbarAvatar();
                this.showToast('Avatar updated successfully!', 'success');
            } else {
                throw new Error(data.error || 'Upload failed');
            }
        } catch (error) {
            this.showToast(error.message, 'error');
        }
    },
    
    updateNavbarAvatar() {
        const avatarImg = document.getElementById('avatarImg');
        if (avatarImg && this.user?.avatar) {
            avatarImg.src = this.user.avatar + '?t=' + Date.now();
            avatarImg.onerror = () => {
                avatarImg.src = '/assets/images/default-avatar.png';
            };
        }
    },
    
    setupEventListeners() {
        const saveBtn = document.getElementById('saveProfileBtn');
        if (saveBtn) {
            saveBtn.onclick = () => this.saveProfile();
        }
        
        const changeAvatarBtn = document.getElementById('changeAvatarBtn');
        const avatarUpload = document.getElementById('avatarUpload');
        
        if (changeAvatarBtn && avatarUpload) {
            changeAvatarBtn.onclick = () => avatarUpload.click();
            avatarUpload.onchange = (e) => {
                if (e.target.files && e.target.files[0]) {
                    this.uploadAvatar(e.target.files[0]);
                }
            };
        }
    },
    
    setLoading(isLoading) {
        const saveBtn = document.getElementById('saveProfileBtn');
        if (saveBtn) {
            if (isLoading) {
                saveBtn.disabled = true;
                saveBtn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Saving...';
            } else {
                saveBtn.disabled = false;
                saveBtn.innerHTML = 'Save Changes';
            }
        }
    },
    
    showToast(message, type) {
        if (window.UI) {
            window.UI.showToast(message, type);
        } else {
            console.log(`[${type}] ${message}`);
            alert(message);
        }
    }
};