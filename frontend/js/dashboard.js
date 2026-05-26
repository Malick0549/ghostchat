/**
 * GHOSTCHAT DASHBOARD CONTROLLER  v3.0
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

            // Update navbar UI
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
        // Check session every 5 minutes
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

    /* ── Global event listeners ────────────────────────────────── */
    _setupGlobalListeners() {
        // Log every encryption/decryption as activity
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
        const navBadge = document.getElementById('notificationCount');
        if (badge) {
            badge.textContent = count;
            badge.style.display = count > 0 ? '' : 'none';
        }
        if (navBadge) {
            navBadge.textContent = count;
            navBadge.style.display = count > 0 ? '' : 'none';
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