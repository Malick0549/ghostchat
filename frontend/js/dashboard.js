/**
 * GHOSTCHAT DASHBOARD CONTROLLER  v3.2
 * Manages auth verification, page routing, session monitoring,
 * activity logs, and event wiring.
 *
 * All crypto work stays in api.js / server-side.
 * All toast/theme work stays in ui.js.
 */

class GhostChatDashboard {
    constructor() {
        this.currentPage    = 'encrypt';
        this.user           = null;
        this.activityLogs   = [];
        this._sessionTimer  = null;
        this._inited        = false;
        this._notificationCount = 0;
        this._activeNotifications = [];
    }

    async init() {
        // ── Auth check ────────────────────────────────────────────
        if (!(await this._verifyAuth())) {
            window.location.href = 'login.html';
            return;
        }

        await this._loadUserProfile();
        this._startSessionMonitoring();
        await this._loadActivityLogs();
        this._setupGlobalListeners();
        this._setupNotificationSystem();
        this._fixThemeToggle();
        this._inited = true;

        console.log('[GhostChat] Dashboard initialised for:', this.user?.username);
    }

    /* ── Auth ──────────────────────────────────────────────────── */
    async _verifyAuth() {
        try {
            const d = await window.GhostChatAPI.getProfile();
            this.user = d.user;
            return true;
        } catch (_) {
            return false;
        }
    }

    /* ── Profile ───────────────────────────────────────────────── */
    async _loadUserProfile() {
        try {
            const d = await window.GhostChatAPI.getProfile();
            this.user = d.user;

            const fn       = this.user.firstName || this.user.username || 'Ghost';
            const initials = (
                (this.user.firstName?.[0] || '') +
                (this.user.lastName?.[0]  || this.user.username?.[1] || '')
            ).toUpperCase() || 'GH';

            const avatarEl = document.getElementById('avatarInitials');
            if (avatarEl) avatarEl.textContent = initials;

            const ddName  = document.getElementById('ddName');
            const ddEmail = document.getElementById('ddEmail');
            if (ddName)  ddName.textContent  = [this.user.firstName, this.user.lastName].filter(Boolean).join(' ') || this.user.username || 'Ghost User';
            if (ddEmail) ddEmail.textContent = this.user.email || '—';

            if (this.user.avatar) {
                const el = document.getElementById('avatarInitials');
                if (el) {
                    el.outerHTML = `<img src="${this.user.avatar}" alt="${fn}" style="width:100%;height:100%;object-fit:cover;border-radius:50%;" onerror="this.outerHTML='<span>${initials}</span>';" />`;
                }
            }
        } catch (_) {}
    }

    /* ── Fix Theme Toggle Button ───────────────────────────────── */
    _fixThemeToggle() {
        const themeToggle = document.getElementById('themeToggle');
        if (themeToggle) {
            if (!themeToggle.innerHTML.trim()) {
                const currentTheme = localStorage.getItem('ghostchat_theme') || 'dark';
                const iconClass = currentTheme === 'dark' ? 'fa-moon' : 'fa-sun';
                themeToggle.innerHTML = `<i class="fas ${iconClass}"></i>`;
            }
            
            if (window.themeManager) {
                const newToggle = themeToggle.cloneNode(true);
                themeToggle.parentNode.replaceChild(newToggle, themeToggle);
                newToggle.addEventListener('click', () => {
                    window.themeManager.toggle();
                    setTimeout(() => {
                        const newTheme = localStorage.getItem('ghostchat_theme') || 'dark';
                        const icon = newTheme === 'dark' ? 'fa-moon' : 'fa-sun';
                        newToggle.innerHTML = `<i class="fas ${icon}"></i>`;
                    }, 50);
                });
            }
        }
    }

    /* ── Session monitoring ────────────────────────────────────── */
    _startSessionMonitoring() {
        this._sessionTimer = setInterval(async () => {
            try {
                await window.GhostChatAPI.getSessions();
            } catch (err) {
                console.warn('[GhostChat] Session check failed:', err.message);
                if (err.status === 401) {
                    this._handleSessionExpired();
                }
            }
        }, 5 * 60 * 1000);
    }

    _handleSessionExpired() {
        if (window.UI) window.UI.showToast('Session expired. Redirecting to login…', 'error', 3000);
        setTimeout(() => {
            sessionStorage.clear();
            localStorage.removeItem('ghostchat_session_id');
            window.location.href = 'login.html';
        }, 2500);
    }

    /* ── Activity logs ─────────────────────────────────────────── */
    async _loadActivityLogs() {
        try {
            const d = await window.GhostChatAPI.getActivityLogs(50);
            this.activityLogs = d.logs || [];
            this._renderActivityLogs();
        } catch (_) {}
    }

    _renderActivityLogs() {
        const container = document.querySelector('#encryptLogList, .log-list');
        if (!container || !this.activityLogs.length) return;

        container.innerHTML = this.activityLogs
            .slice(-20)
            .reverse()
            .map(log => `
                <div class="log-item ${log.type || 'info'}">
                    <span style="color:var(--t3);margin-right:8px;">${new Date(log.timestamp).toLocaleTimeString()}</span>
                    <span>${this._escHtml(log.message)}</span>
                </div>
            `).join('');
    }

    /* ── Play Sound ────────────────────────────────────────────── */
    _playSound(type) {
        const settings = localStorage.getItem('ghostchat_settings');
        const soundEffects = settings ? JSON.parse(settings).soundEffects : false;
        
        if (!soundEffects) return;
        
        try {
            const audioContext = new (window.AudioContext || window.webkitAudioContext)();
            const oscillator = audioContext.createOscillator();
            const gainNode = audioContext.createGain();
            
            oscillator.connect(gainNode);
            gainNode.connect(audioContext.destination);
            
            oscillator.frequency.value = type === 'success' ? 880 : 440;
            gainNode.gain.value = 0.1;
            
            oscillator.start();
            setTimeout(() => {
                oscillator.stop();
                audioContext.close();
            }, 200);
        } catch(e) {
            console.log('Audio not supported');
        }
    }

    /* ── Notification System ───────────────────────────────────── */
    _setupNotificationSystem() {
        window.addEventListener('ghostchat:encrypt', () => {
            this._showPersistentNotification('Message encrypted successfully', 'success');
            this._updateNotificationBadge(1);
            this._playSound('success');
        });
        
        window.addEventListener('ghostchat:decrypt', () => {
            this._showPersistentNotification('Message decrypted successfully', 'success');
            this._updateNotificationBadge(1);
            this._playSound('success');
        });
        
        window.addEventListener('ghostchat:error', (e) => {
            this._showPersistentNotification(e.detail?.message || 'Operation failed', 'error');
            this._updateNotificationBadge(1);
            this._playSound('error');
        });
        
        const notifBtn = document.querySelector('.notification-btn');
        if (notifBtn) {
            notifBtn.addEventListener('click', () => {
                this._clearAllNotifications();
            });
        }
        
        if ('Notification' in window && Notification.permission === 'default') {
            Notification.requestPermission();
        }
    }
    
    _showPersistentNotification(message, type = 'info') {
        const notificationId = Date.now();
        const notification = {
            id: notificationId,
            message: message,
            type: type,
            timestamp: new Date()
        };
        
        this._activeNotifications.push(notification);
        this._showPersistentToast(notification);
        
        if (Notification.permission === 'granted') {
            const browserNotif = new Notification('GhostChat', { 
                body: message, 
                icon: '/favicon.ico',
                silent: true
            });
            
            browserNotif.onclick = () => {
                browserNotif.close();
                this._removeNotification(notificationId);
                window.focus();
            };
        }
    }
    
    _showPersistentToast(notification) {
        let container = document.getElementById('toastContainer');
        if (!container) {
            container = document.createElement('div');
            container.id = 'toastContainer';
            container.className = 'toast-container';
            document.body.appendChild(container);
        }
        
        const toast = document.createElement('div');
        toast.id = `toast-${notification.id}`;
        toast.className = `toast toast-${notification.type} persistent-toast`;
        toast.setAttribute('data-id', notification.id);
        
        const icons = {
            success: 'fa-check-circle',
            error: 'fa-exclamation-circle',
            info: 'fa-info-circle'
        };
        
        toast.innerHTML = `
            <i class="fas ${icons[notification.type] || icons.info}"></i>
            <span>${notification.message}</span>
            <button class="toast-close" onclick="this.closest('.toast').remove(); window.dashboard?._removeNotification(${notification.id});">
                <i class="fas fa-times"></i>
            </button>
        `;
        
        toast.addEventListener('click', (e) => {
            if (e.target.closest('.toast-close')) return;
            toast.remove();
            this._removeNotification(notification.id);
        });
        
        container.appendChild(toast);
        setTimeout(() => toast.classList.add('show'), 10);
    }
    
    _removeNotification(id) {
        this._activeNotifications = this._activeNotifications.filter(n => n.id !== id);
        this._updateNotificationBadge(0, true);
    }
    
    _clearAllNotifications() {
        const container = document.getElementById('toastContainer');
        if (container) {
            container.innerHTML = '';
        }
        this._activeNotifications = [];
        this._notificationCount = 0;
        this.updateNotificationBadge(0);
    }
    
    _updateNotificationBadge(increment = 1, reset = false) {
        if (reset) {
            this._notificationCount = 0;
        } else {
            this._notificationCount += increment;
        }
        this.updateNotificationBadge(this._notificationCount);
    }

    /* ── Global event listeners ────────────────────────────────── */
    _setupGlobalListeners() {
        window.addEventListener('ghostchat:encrypt', async (e) => {
            await window.GhostChatAPI.logActivity('Message encrypted successfully', 'success');
            await this._loadActivityLogs();
        });
        window.addEventListener('ghostchat:decrypt', async (e) => {
            await window.GhostChatAPI.logActivity('Message decrypted successfully', 'success');
            await this._loadActivityLogs();
        });
        window.addEventListener('ghostchat:error', async (e) => {
            await window.GhostChatAPI.logActivity(e.detail?.message || 'Operation failed', 'error');
            await this._loadActivityLogs();
        });
    }

    /* ── Notification badge update ─────────────────────────────── */
    updateNotificationBadge(count) {
        const badge = document.getElementById('notifBadge');
        if (badge) {
            badge.textContent = count;
            badge.style.display = count > 0 ? 'flex' : 'none';
        }
        
        const navBadge = document.getElementById('notificationCount');
        if (navBadge) {
            navBadge.textContent = count;
            navBadge.style.display = count > 0 ? 'inline-flex' : 'none';
        }
        
        if (count > 0) {
            document.title = `(${count}) GhostChat - Secure Messaging`;
        } else {
            document.title = 'GhostChat - Secure Messaging';
        }
    }

    /* ── Logout ────────────────────────────────────────────────── */
    async logout() {
        clearInterval(this._sessionTimer);
        await window.GhostChatAPI.logout();
        localStorage.removeItem('ghostchat_user');
        window.location.href = 'login.html';
    }

    /* ── Helpers ───────────────────────────────────────────────── */
    _escHtml(str) {
        const d = document.createElement('div');
        d.textContent = str;
        return d.innerHTML;
    }
}

/* ── Singleton ─────────────────────────────────────────────────── */
document.addEventListener('DOMContentLoaded', async () => {
    window.dashboard = new GhostChatDashboard();
    await window.dashboard.init();
});