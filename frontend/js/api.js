/**
 * GHOSTCHAT API CLIENT  v3.4
 * ─────────────────────────────────────────────────────────────────
 * Works on both http://localhost:5000 and Railway deployment.
 *
 * CSRF — double-submit cookie pattern:
 *   1. fetchCsrfToken() calls GET /api/csrf-token
 *      → server sets gc_csrf cookie (JS-readable) AND returns token in JSON
 *   2. Every mutating request sends the token as X-CSRF-Token header
 *   3. Server compares header to cookie (constant-time)
 *   → No session lookup needed, no race condition with OPTIONS preflight
 *
 * NETWORK RESILIENCE (v3.4):
 *   All requests now retry transient failures (dropped connection, timeout,
 *   5xx, 429) with exponential backoff + jitter before giving up — this
 *   matters a lot on unstable mobile connections where a single retry often
 *   succeeds. 4xx errors (bad request, auth failure) are never retried since
 *   retrying those just wastes time or risks tripping rate limits harder.
 *
 * SECURITY:
 *   • Passwords never stored — live only inside the HTTP request
 *   • Session IDs stored in sessionStorage (tab-scoped)
 *   • Auto-clear clipboard after 30 s for encrypted content
 *   • 401 anywhere → redirect to login.html
 * ─────────────────────────────────────────────────────────────────
 */

class GhostChatAPI {
    constructor() {
        this.baseURL = window.location.origin;
        this._csrfToken = null;
        this._sessionId = sessionStorage.getItem('gc_session_id') || null;
    }

    // ── CSRF ──────────────────────────────────────────────────────

    async fetchCsrfToken() {
        try {
            const d = await this._get('/api/csrf-token');
            this._csrfToken = d.csrf_token || null;
            return this._csrfToken;
        } catch (_) {
            return null;
        }
    }

    _getCsrfFromCookie() {
        const match = document.cookie.match(/(?:^|;\s*)gc_csrf=([^;]+)/);
        return match ? decodeURIComponent(match[1]) : null;
    }

    // ── Core HTTP (with retry/backoff for transient network failures) ──────

    async _fetchWithRetry(url, fetchOptions, { retries = 2, baseDelay = 500 } = {}) {
        let lastErr;
        for (let attempt = 0; attempt <= retries; attempt++) {
            try {
                const controller = new AbortController();
                const timeoutId = setTimeout(() => controller.abort(), 20000);
                const res = await fetch(url, { ...fetchOptions, signal: controller.signal });
                clearTimeout(timeoutId);

                // Retry on server errors / rate limiting, never on 4xx client errors
                if ((res.status >= 500 || res.status === 429) && attempt < retries) {
                    throw new Error(`Transient server error ${res.status}`);
                }
                return res;
            } catch (err) {
                lastErr = err;
                if (attempt === retries) break;
                const delay = baseDelay * Math.pow(2, attempt) + Math.random() * 250;
                await new Promise(r => setTimeout(r, delay));
            }
        }
        throw lastErr;
    }

    async _request(path, options = {}) {
        const url = `${this.baseURL}${path}`;

        let csrf = this._csrfToken || this._getCsrfFromCookie();

        if (options.method && options.method !== 'GET' && !csrf) {
            await this.fetchCsrfToken();
            csrf = this._csrfToken || this._getCsrfFromCookie();
        }

        const headers = {
            'X-Requested-With': 'XMLHttpRequest',
            ...options.headers,
        };

        if (!(options.body instanceof FormData)) {
            headers['Content-Type'] = 'application/json';
        }

        if (options.method && options.method !== 'GET' && csrf) {
            headers['X-CSRF-Token'] = csrf;
        }

        // GET requests get more retries (safe to repeat); mutating requests
        // get fewer, since retrying a POST that actually succeeded server-side
        // but timed out on the response could double-submit. The rate-limit
        // headroom on auth endpoints backs this up too — see rate_limit.py.
        const isMutating = options.method && options.method !== 'GET';
        const retryConfig = isMutating ? { retries: 1, baseDelay: 700 } : { retries: 2, baseDelay: 500 };

        let res;
        try {
            res = await this._fetchWithRetry(url, {
                credentials: 'include',
                ...options,
                headers,
            }, retryConfig);
        } catch (networkErr) {
            const err = new Error(
                navigator.onLine === false
                    ? 'You are offline. Please check your connection.'
                    : 'Network error — please try again.'
            );
            err.status = 0;
            err.isNetworkError = true;
            throw err;
        }

        if (res.status === 401) {
            const isAuthPage = ['login.html', 'register.html', 'forgot-password.html']
                .some(p => window.location.pathname.endsWith(p));
            if (!isAuthPage) {
                sessionStorage.clear();
                window.location.href = 'login.html';
                throw new Error('Session expired');
            }
        }

        const ct = res.headers.get('content-type') || '';
        const data = ct.includes('application/json')
            ? await res.json()
            : { message: await res.text() };

        if (!res.ok) {
            const err  = new Error(data.error || data.message || `HTTP ${res.status}`);
            err.status = res.status;
            err.data   = data;
            throw err;
        }

        return data;
    }

    _get(path)       { return this._request(path, { method: 'GET' }); }
    _post(path, body){ return this._request(path, { method: 'POST',   body: body instanceof FormData ? body : JSON.stringify(body) }); }
    _put(path, body) { return this._request(path, { method: 'PUT',    body: JSON.stringify(body) }); }
    _del(path)       { return this._request(path, { method: 'DELETE' }); }

    getCsrfToken() {
        return this._csrfToken || this._getCsrfFromCookie();
    }

    // ── Health ────────────────────────────────────────────────────

    checkHealth() { return this._get('/health'); }

    // ── Auth ──────────────────────────────────────────────────────

    async login(username, password, rememberMe = false) {
        const d = await this._post('/api/auth/login', { username, password, remember_me: rememberMe });
        if (d.user) localStorage.setItem('ghostchat_user', JSON.stringify(d.user));
        this._csrfToken = this._getCsrfFromCookie() || this._csrfToken;
        return d;
    }

    // ── 2FA (email OTP) ──────────────────────────────────────────
    async verify2FA(code) {
        const d = await this._post('/api/auth/2fa/verify', { code });
        if (d.user) localStorage.setItem('ghostchat_user', JSON.stringify(d.user));
        this._csrfToken = this._getCsrfFromCookie() || this._csrfToken;
        return d;
    }
    resend2FA() {
        return this._post('/api/auth/2fa/resend', {});
    }

    async register(payload) {
        const d = await this._post('/api/auth/register', payload);
        if (d.user) localStorage.setItem('ghostchat_user', JSON.stringify(d.user));
        this._csrfToken = this._getCsrfFromCookie() || this._csrfToken;
        return d;
    }

    async verifyEmail(email, code) {
        const d = await this._post('/api/auth/verify-email', { email, code });
        if (d.user) localStorage.setItem('ghostchat_user', JSON.stringify(d.user));
        this._csrfToken = this._getCsrfFromCookie() || this._csrfToken;
        return d;
    }

    resendVerification(email) {
        return this._post('/api/auth/resend-verification', { email });
    }

    async logout() {
        try { await this._post('/api/auth/logout', {}); } catch (_) {}
        sessionStorage.clear();
        localStorage.removeItem('ghostchat_user');
    }

    getCurrentUser()                   { return this._get('/api/auth/me'); }
    forgotPassword(email)              { return this._post('/api/auth/forgot-password', { email }); }
    resetPassword(token, new_password) { return this._post('/api/auth/reset-password', { token, new_password }); }

    // ── Profile ───────────────────────────────────────────────────

    async getProfile() {
        try {
            return await this._get('/api/profile');
        } catch (_) {
            const saved = localStorage.getItem('ghostchat_user');
            const u     = saved ? JSON.parse(saved) : {};
            return {
                user: {
                    id:                 u.id       || '',
                    username:           u.username  || 'ghost_user',
                    email:              u.email     || '',
                    firstName:          u.firstName || u.first_name || '',
                    lastName:           u.lastName  || u.last_name  || '',
                    avatar:             u.avatar    || null,
                    two_factor_enabled: u.two_factor_enabled || false,
                },
            };
        }
    }

    async updateProfile(data) {
        const d = await this._put('/api/profile', data);
        if (d.user) localStorage.setItem('ghostchat_user', JSON.stringify(d.user));
        return d;
    }

    changePassword(old_password, new_password) {
        return this._put('/api/profile/password', { old_password, new_password });
    }

    async uploadAvatar(file) {
        const form = new FormData();
        form.append('avatar', file);
        return this._request('/api/profile/avatar', { method: 'POST', body: form });
    }

    // ── Encrypt / Decrypt (password-based) ───────────────────────

    async encryptSimple(message, password, useDecoys = false) {
        try {
            return await this._post('/api/encrypt', {
                message,
                password,
                use_decoys: useDecoys,
            });
        } catch (err) {
            return { success: false, error: err.message || 'Encryption failed' };
        }
    }

    async decryptSimple(emojiMessage, password) {
        try {
            return await this._post('/api/decrypt', {
                emoji_message: emojiMessage,
                password,
            });
        } catch (err) {
            return { success: false, error: err.message || 'Decryption failed' };
        }
    }

    // ── Session-key crypto (routes_crypto.py / routes_session.py) ─

    async createSession() {
        const d = await this._post('/new-session', {});
        if (d.session_id) {
            this._sessionId = d.session_id;
            sessionStorage.setItem('gc_session_id', d.session_id);
        }
        return d;
    }

    async ensureSession() {
        if (this._sessionId) {
            try { await this.getSessionInfo(); return this._sessionId; }
            catch (_) {
                this._sessionId = null;
                sessionStorage.removeItem('gc_session_id');
            }
        }
        await this.createSession();
        return this._sessionId;
    }

    getSessionInfo() {
        if (!this._sessionId) throw new Error('No active session');
        return this._post('/session-info', { session_id: this._sessionId });
    }

    getSessions() { return this.getSessionInfo(); }

    rotateSession() {
        if (!this._sessionId) throw new Error('No active session');
        return this._post('/rotate-session', { session_id: this._sessionId });
    }

    async endSession() {
        if (!this._sessionId) return;
        await this._post('/end-session', { session_id: this._sessionId });
        this._sessionId = null;
        sessionStorage.removeItem('gc_session_id');
    }

    // ── Message history ───────────────────────────────────────────

    getMessageHistory(limit = 100, offset = 0) {
        return this._get(`/api/messages?limit=${limit}&offset=${offset}`);
    }

    saveMessage(data)       { return this._post('/api/messages', data); }
    deleteMessage(id)       { return this._del(`/api/messages/${id}`); }

    // ── FIX: real backend bulk-clear for the dashboard's encryption/
    // decryption history log — previously "Clear All" only wiped
    // localStorage, so the history would silently repopulate from the
    // server on the next load. ──
    clearEncryptionHistory() { return this._post('/api/messages/clear', {}); }

    // ── Chat: clear thread (delete-for-me, bulk) ──────────────────
    clearChatThread(contactId) { return this._post(`/api/chat/${contactId}/clear`, {}); }

    // ── Admin: clear activity logs ─────────────────────────────────
    adminClearActivityLogs() { return this._post('/api/admin/activity-logs/clear', { confirm: true }); }

    // ── Local activity log ────────────────────────────────────────

    async logActivity(message, type = 'info') {
        try {
            const raw    = localStorage.getItem('gc_activity') || '[]';
            const logs   = JSON.parse(raw);
            logs.push({ timestamp: new Date().toISOString(), type, message });
            if (logs.length > 500) logs.shift();
            localStorage.setItem('gc_activity', JSON.stringify(logs));
        } catch (_) {}
    }

    async getActivityLogs(limit = 100) {
        try {
            const raw  = localStorage.getItem('gc_activity') || '[]';
            const logs = JSON.parse(raw);
            return { success: true, logs: logs.slice(-limit), total: logs.length };
        } catch (_) {
            return { success: true, logs: [], total: 0 };
        }
    }
}

// ── Singleton ─────────────────────────────────────────────────────

window.GhostChatAPI = new GhostChatAPI();

// Fetch CSRF token on every page load (silent — errors are non-fatal)
window.GhostChatAPI.fetchCsrfToken();


// ── Secure clipboard copy (auto-clears after 30 s) ────────────────

window.secureCopy = async function(text, clearAfterMs = 30000) {
    try {
        await navigator.clipboard.writeText(text);
        if (window.UI) UI.showToast('Copied to clipboard', 'success');
        if (clearAfterMs > 0) {
            setTimeout(async () => {
                try {
                    const cur = await navigator.clipboard.readText();
                    if (cur === text) await navigator.clipboard.writeText('');
                } catch (_) {}
            }, clearAfterMs);
        }
    } catch (_) {
        const ta = document.createElement('textarea');
        ta.value = text;
        ta.style.cssText = 'position:fixed;opacity:0;top:0;left:0;';
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        ta.remove();
        if (window.UI) UI.showToast('Copied!', 'success');
    }
};


// ── Auto-attach password visibility toggles ────────────────────────

document.addEventListener('DOMContentLoaded', function() {
    document.querySelectorAll('input[type="password"]').forEach(function(inp) {
        const wrap = inp.closest('.input-wrap');
        if (wrap && !wrap.querySelector('.input-toggle, .toggle-pw')) {
            const btn = document.createElement('button');
            btn.type      = 'button';
            btn.className = 'input-toggle';
            btn.setAttribute('aria-label', 'Show password');
            btn.innerHTML = '<i class="fas fa-eye"></i>';
            btn.addEventListener('click', function() {
                const show = inp.type === 'password';
                inp.type   = show ? 'text' : 'password';
                btn.querySelector('i').className = show ? 'fas fa-eye-slash' : 'fas fa-eye';
                btn.setAttribute('aria-label', show ? 'Hide password' : 'Show password');
            });
            wrap.appendChild(btn);
        }
    });
});

// ── Global offline/online toast feedback ───────────────────────────
window.addEventListener('offline', () => {
    if (window.UI) UI.showToast('You are offline. Some features may not work.', 'error', 5000);
});
window.addEventListener('online', () => {
    if (window.UI) UI.showToast('Back online', 'success', 2000);
});
