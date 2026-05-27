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
        
        const avatarUrl = this.user?.avatar ? new URL(this.user.avatar, window.location.origin).href : '/assets/images/default-avatar.png';

        if (avatarImg) {
            avatarImg.src = `${avatarUrl}?t=${Date.now()}`;
            avatarImg.onerror = () => {
                avatarImg.onerror = null;
                avatarImg.src = '/assets/images/default-avatar.png';
            };
        }

        const initials = (
            (this.user?.firstName?.[0] || '') +
            (this.user?.lastName?.[0]  || this.user?.username?.[1] || '')
        ).toUpperCase() || 'GH';

        this.updateNavbarAvatar(avatarUrl, initials);
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
    
    updateNavbarAvatar(avatarUrl = null, initials = 'GH') {
        avatarUrl = avatarUrl || (this.user?.avatar ? new URL(this.user.avatar, window.location.origin).href : null);

        const avatarToggle = document.getElementById('avatarToggle');
        const avatarImg = document.getElementById('avatarImg') || avatarToggle?.querySelector('img');
        if (avatarImg && avatarUrl) {
            avatarImg.id = 'avatarImg';
            avatarImg.src = `${avatarUrl}?t=${Date.now()}`;
            avatarImg.onerror = () => {
                avatarImg.onerror = null;
                avatarImg.src = '/assets/images/default-avatar.png';
            };
            return;
        }

        const avatarInitials = document.getElementById('avatarInitials');
        if (!avatarInitials) return;

        if (avatarUrl) {
            avatarInitials.outerHTML = `<img id="avatarImg" src="${avatarUrl}?t=${Date.now()}" alt="${initials}" style="width:100%;height:100%;object-fit:cover;border-radius:50%;" onerror="this.outerHTML='<span>${initials}</span>';" />`;
        } else {
            avatarInitials.textContent = initials;
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

        const profileInputs = Array.from(document.querySelectorAll('#profileUsername, #profileEmail'));
        profileInputs.forEach(input => {
            input.addEventListener('keydown', (e) => {
                if (e.key === 'Enter') {
                    e.preventDefault();
                    this.saveProfile();
                }
            });
        });
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