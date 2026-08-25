/**
 * GHOSTCHAT DASHBOARD CONTROLLER  v3.2
 * Manages auth verification, page routing, session monitoring,
 * activity logs, and event wiring.
 *
 * FIX (notification badge never actually clears):
 *   The old _updateNotificationBadge() incremented a counter and then, 5
 *   SECONDS LATER, auto-decremented it — regardless of whether the user had
 *   opened/cleared notifications in between. That's why clicking the bell to
 *   clear it appeared to work for a moment and then the badge "came back":
 *   a queued setTimeout from an earlier notification would fire afterward
 *   and push the count back up. There was no real "unread" concept at all,
 *   just a decaying counter.
 *
 *   This version replaces it with a genuine unread counter, persisted to
 *   localStorage (survives reload), that only increases on real events and
 *   only decreases when the user explicitly clears it (clicking the bell)
 *   or when the item is opened. No more timers silently re-adding to it.
 */

class GhostChatDashboard {
    constructor() {
        this.currentPage    = 'encrypt';
        this.user           = null;
        this.activityLogs   = [];
        this._sessionTimer  = null;
        this._inited        = false;
        this._notificationCount = this._loadUnreadCount();
    }

    async init() {
        if (!(await this._verifyAuth())) {
            window.location.href = 'login.html';
            return;
        }

        await this._loadUserProfile();
        this._startSessionMonitoring();
        this._setupGlobalListeners();
        this._setupNotificationSystem();
        this.updateNotificationBadge(this._notificationCount);
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

    /* ── Notification System ───────────────────────────────────── */
    _setupNotificationSystem() {
        window.addEventListener('ghostchat:encrypt', () => {
            this._showNotification('Message encrypted successfully', 'success');
            this._incrementUnread();
            if (window.UI?.playSound) window.UI.playSound('success');
        });

        window.addEventListener('ghostchat:decrypt', () => {
            this._showNotification('Message decrypted successfully', 'success');
            this._incrementUnread();
            if (window.UI?.playSound) window.UI.playSound('success');
        });

        window.addEventListener('ghostchat:error', (e) => {
            this._showNotification(e.detail?.message || 'Operation failed', 'error');
            this._incrementUnread();
            if (window.UI?.playSound) window.UI.playSound('error');
        });

        if (window.HistoryModule && window.HistoryModule.addMessage) {
            const originalAdd = window.HistoryModule.addMessage;
            window.HistoryModule.addMessage = (...args) => {
                this._showNotification('Message saved to history', 'info');
                return originalAdd.apply(window.HistoryModule, args);
            };
        }

        // ── FIX: clicking the bell now genuinely clears — persisted, no
        // timer will ever silently push the count back up afterward. ──
        const notifBtn = document.querySelector('.notification-btn');
        if (notifBtn) {
            notifBtn.addEventListener('click', () => {
                this._clearUnread();
                // History is the app's one canonical place to review past
                // encrypt/decrypt activity — navigate() itself lives in a
                // separate inline script in dashboard.html, so it's exposed
                // on window as dashboardNavigate for this file to call.
                if (window.dashboardNavigate) window.dashboardNavigate('history');
            });
        }
    }

    _showNotification(message, type = 'info') {
        if (window.UI && window.UI.showToast) {
            window.UI.showToast(message, type);
        }

        try {
            if ('Notification' in window && Notification.permission === 'granted') {
                if (window.isSecureContext !== false) {
                    const notif = new Notification('GhostChat', {
                        body: message,
                        icon: '/favicon.ico',
                        silent: true,
                        tag: 'ghostchat-notification'
                    });

                    setTimeout(() => {
                        if (notif) notif.close();
                    }, 10000);
                }
            }
        } catch(e) {
            console.log('Browser notifications not supported');
        }
    }

    /* ── Unread counter (persisted, no decay timers) ──────────────── */
    _loadUnreadCount() {
        try {
            const n = parseInt(localStorage.getItem('gc_unread_count') || '0', 10);
            return Number.isFinite(n) && n >= 0 ? n : 0;
        } catch (_) {
            return 0;
        }
    }

    _saveUnreadCount(n) {
        try { localStorage.setItem('gc_unread_count', String(n)); } catch (_) {}
    }

    _incrementUnread() {
        this._notificationCount += 1;
        this._saveUnreadCount(this._notificationCount);
        this.updateNotificationBadge(this._notificationCount);
    }

    _clearUnread() {
        this._notificationCount = 0;
        this._saveUnreadCount(0);
        this.updateNotificationBadge(0);
    }

    /* ── Global event listeners ────────────────────────────────── */
    _setupGlobalListeners() {
        // FIX: this used to also call window.GhostChatAPI.logActivity(...)
        // and this._loadActivityLogs() on these same three events — both
        // existed solely to feed the Activity Log widget that used to sit
        // below the Encrypt page, which has been removed (History is now
        // the one place to review past activity). The badge/sound/toast
        // reactions to these events already live independently in
        // _setupNotificationSystem() above, so there's nothing left for
        // this method to do beyond the notification-permission request.
        if ('Notification' in window && Notification.permission === 'default') {
            Notification.requestPermission().catch(() => {});
        }
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