/**
 * GHOSTCHAT API CLIENT  v3.2
 * ─────────────────────────────────────────────────────────────────
 * Single source of truth for all backend communication.
 *
 * Endpoint map (matches flask_app.py exactly):
 *   POST /api/csrf-token            ← fetch CSRF token
 *   POST /api/auth/login            ← authenticate
 *   POST /api/auth/register         ← create account
 *   POST /api/auth/logout           ← sign out
 *   POST /api/auth/forgot-password  ← request reset link
 *   POST /api/auth/reset-password   ← set new password
 *   GET  /api/auth/me               ← current user
 *   GET  /api/profile               ← profile data
 *   PUT  /api/profile               ← update profile
 *   PUT  /api/profile/password      ← change password
 *   POST /api/profile/avatar        ← upload avatar
 *   POST /api/encrypt               ← password-based AES-256 + emoji
 *   POST /api/decrypt               ← password-based decrypt
 *   POST /new-session               ← crypto session create
 *   POST /session-info              ← crypto session query
 *   POST /rotate-session            ← rotate session keys
 *   POST /end-session               ← terminate session
 *   GET  /api/messages              ← message history
 *   POST /api/messages              ← save message
 *   DEL  /api/messages/:id          ← delete message
 *   GET  /health                    ← health check
 *
 * SECURITY RULES:
 *   • CSRF token fetched once per page, sent on every mutating request.
 *   • 401 responses always redirect to login.html.
 *   • Session IDs stored in sessionStorage (tab-scoped — cleared on tab close).
 *   • Passwords and keys are NEVER stored — they travel to the server and
 *     are used only within request scope.
 *   • Auto-clear clipboard 30 s after copying encrypted content.
 * ─────────────────────────────────────────────────────────────────
 */

class GhostChatAPI {
    constructor() {
        this.baseURL = (
            window.location.origin.includes('localhost') ||
            window.location.origin.includes('127.0.0.1')
        )
            ? 'http://127.0.0.1:5000'
            : window.location.origin;

        // Tab-scoped storage — cleared when the tab closes
        this._sessionId = sessionStorage.getItem('gc_session_id') || null;
        this._csrfToken = null;   // fetched lazily
    }

    // ── Core HTTP helper ──────────────────────────────────────────

    async _request(path, options = {}) {
        const url = `${this.baseURL}${path}`;

        const headers = {
            'Content-Type':    'application/json',
            'X-Requested-With':'XMLHttpRequest',
            ...options.headers,
        };

        // Attach CSRF token to every mutating request
        if (options.method && options.method !== 'GET') {
            if (this._csrfToken) {
                headers['X-CSRF-Token'] = this._csrfToken;
            }
        }

        const config = {
            credentials: 'include',
            ...options,
            headers,
        };

        const res  = await fetch(url, config);

        // ── Global 401 handler ────────────────────────────────────
        if (res.status === 401) {
            const isAuthPage = ['login.html', 'register.html', 'forgot-password.html']
                .some(p => window.location.pathname.endsWith(p));
            if (!isAuthPage) {
                sessionStorage.clear();
                window.location.href = 'login.html';
                throw new Error('Session expired. Redirecting to login.');
            }
        }

        let data;
        const ct = res.headers.get('content-type') || '';
        if (ct.includes('application/json')) {
            data = await res.json();
        } else {
            data = { message: await res.text() };
        }

        if (!res.ok) {
            const err     = new Error(data.error || data.message || `HTTP ${res.status}`);
            err.status    = res.status;
            err.data      = data;
            throw err;
        }

        return data;
    }

    _get(path)          { return this._request(path, { method: 'GET' }); }
    _post(path, body)   { return this._request(path, { method: 'POST',   body: JSON.stringify(body) }); }
    _put(path, body)    { return this._request(path, { method: 'PUT',    body: JSON.stringify(body) }); }
    _delete(path)       { return this._request(path, { method: 'DELETE' }); }

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

    // ── Health ────────────────────────────────────────────────────

    async checkHealth()  { return this._get('/health'); }

    // ── Auth ──────────────────────────────────────────────────────

    async login(username, password, rememberMe = false) {
        const d = await this._post('/api/auth/login', {
            username, password, remember_me: rememberMe,
        });
        if (d.user) localStorage.setItem('ghostchat_user', JSON.stringify(d.user));
        return d;
    }

    async register(payload) {
        const d = await this._post('/api/auth/register', payload);
        if (d.user) localStorage.setItem('ghostchat_user', JSON.stringify(d.user));
        return d;
    }

    async logout() {
        try { await this._post('/api/auth/logout', {}); } catch (_) {}
        sessionStorage.clear();
        localStorage.removeItem('ghostchat_user');
    }

    async getCurrentUser()                    { return this._get('/api/auth/me'); }
    async forgotPassword(email)               { return this._post('/api/auth/forgot-password', { email }); }
    async resetPassword(token, new_password)  { return this._post('/api/auth/reset-password', { token, new_password }); }

    // ── Profile ───────────────────────────────────────────────────

    async getProfile() {
        // Try server first; fall back to localStorage for offline UX
        try {
            return await this._get('/api/profile');
        } catch (_) {
            const saved = localStorage.getItem('ghostchat_user');
            const user  = saved ? JSON.parse(saved) : {};
            return {
                user: {
                    id:                 user.id       || '',
                    username:           user.username  || 'ghost_user',
                    email:              user.email     || '',
                    firstName:          user.firstName || '',
                    lastName:           user.lastName  || '',
                    avatar:             user.avatar    || null,
                    two_factor_enabled: user.two_factor_enabled || false,
                },
            };
        }
    }

    async updateProfile(data) {
        const d = await this._put('/api/profile', data);
        if (d.user) localStorage.setItem('ghostchat_user', JSON.stringify(d.user));
        return d;
    }

    async changePassword(old_password, new_password) {
        return this._put('/api/profile/password', { old_password, new_password });
    }

    async uploadAvatar(file) {
        const form = new FormData();
        form.append('avatar', file);
        return this._request('/api/profile/avatar', {
            method:  'POST',
            body:    form,
            headers: { 'X-Requested-With': 'XMLHttpRequest' },
        });
    }

    // ── Encryption / Decryption (password-based — used by encrypt.js/decrypt.js) ──

    /**
     * encryptSimple — called by encrypt.js
     * Sends message + password to /api/encrypt.
     * The server runs GhostChat(password).send_message() → AES-256 + emoji.
     *
     * Returns shape expected by encrypt.js:
     *   { success, emoji_message, emoji_count, algorithm, key_derivation }
     */
    async encryptSimple(message, password, useDecoys = false) {
        try {
            const d = await this._post('/api/encrypt', {
                message,
                password,
                use_decoys: useDecoys,
            });
            return {
                success:        d.success !== false,
                emoji_message:  d.emoji_message  || '',
                emoji_package:  d.emoji_package  || '',
                metadata:       d.metadata       || null,
                emoji_count:    d.emoji_count    || 0,
                algorithm:      d.algorithm      || 'AES-256-CBC',
                key_derivation: d.key_derivation || 'PBKDF2-HMAC-SHA256',
            };
        } catch (err) {
            return {
                success: false,
                error:   err.message || 'Encryption failed',
            };
        }
    }

    /**
     * decryptSimple — called by decrypt.js
     * Sends emoji_message + password to /api/decrypt.
     * The server runs GhostChat(password).receive_message() → plaintext.
     *
     * Returns shape expected by decrypt.js:
     *   { success, decrypted_message, algorithm }
     */
    async decryptSimple(emojiMessage, password) {
        try {
            const d = await this._post('/api/decrypt', {
                emoji_message: emojiMessage,
                password,
            });
            return {
                success:           d.success !== false,
                decrypted_message: d.decrypted_message || '',
                algorithm:         d.algorithm          || 'AES-256-CBC',
            };
        } catch (err) {
            return {
                success: false,
                error:   err.message || 'Decryption failed',
            };
        }
    }

    // ── Session-key crypto (session-based API — routes_crypto.py) ─

    async createSession() {
        const d = await this._post('/new-session', {});
        if (d.session_id) {
            this._sessionId = d.session_id;
            sessionStorage.setItem('gc_session_id', this._sessionId);
        }
        return d;
    }

    async ensureSession() {
        if (this._sessionId) {
            try {
                await this.getSessionInfo(this._sessionId);
                return this._sessionId;
            } catch (_) {
                this._sessionId = null;
                sessionStorage.removeItem('gc_session_id');
            }
        }
        await this.createSession();
        return this._sessionId;
    }

    async getSessionInfo(sessionId) {
        const sid = sessionId || this._sessionId;
        if (!sid) throw new Error('No active session.');
        return this._post('/session-info', { session_id: sid });
    }

    // Alias used by dashboard.js
    async getSessions() { return this.getSessionInfo(); }

    async rotateSession(sessionId) {
        const sid = sessionId || this._sessionId;
        if (!sid) throw new Error('No active session.');
        return this._post('/rotate-session', { session_id: sid });
    }

    async endSession(sessionId) {
        const sid = sessionId || this._sessionId;
        if (!sid) throw new Error('No active session.');
        await this._post('/end-session', { session_id: sid });
        this._sessionId = null;
        sessionStorage.removeItem('gc_session_id');
    }

    // ── Message history ───────────────────────────────────────────

    async getMessageHistory(limit = 50, offset = 0) {
        return this._get(`/api/messages?limit=${limit}&offset=${offset}`);
    }

    async saveMessage(data) {
        return this._post('/api/messages', data);
    }

    async deleteMessage(id) {
        return this._delete(`/api/messages/${id}`);
    }

    // ── Activity log (local) ──────────────────────────────────────

    async logActivity(message, type = 'info') {
        try {
            const raw    = localStorage.getItem('ghostchat_activity_logs') || '[]';
            const parsed = JSON.parse(raw);
            parsed.push({ timestamp: new Date().toISOString(), type, message });
            if (parsed.length > 500) parsed.shift();
            localStorage.setItem('ghostchat_activity_logs', JSON.stringify(parsed));
        } catch (_) {}
        return { success: true };
    }

    async getActivityLogs(limit = 100) {
        try {
            const raw    = localStorage.getItem('ghostchat_activity_logs') || '[]';
            const parsed = JSON.parse(raw);
            return { success: true, logs: parsed.slice(-limit), total: parsed.length };
        } catch (_) {
            return { success: true, logs: [], total: 0 };
        }
    }
}

// ── Global singleton ─────────────────────────────────────────────────────────

window.GhostChatAPI = new GhostChatAPI();

// Fetch CSRF token immediately on every page load
// (silently — auth pages call this before every form submit anyway)
window.GhostChatAPI.fetchCsrfToken();


// ── Clipboard helper with auto-clear ─────────────────────────────────────────

window.secureCopy = async function (text, clearAfterMs = 30000) {
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
        // Fallback for older browsers / non-HTTPS
        const ta = document.createElement('textarea');
        ta.value = text;
        ta.style.cssText = 'position:fixed;opacity:0;';
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        ta.remove();
        if (window.UI) UI.showToast('Copied!', 'success');
    }
};


// ── Password visibility toggle helper ────────────────────────────────────────

window.togglePasswordVisibility = function (inputId, btn) {
    const inp  = document.getElementById(inputId);
    if (!inp) return;
    const show = inp.type === 'password';
    inp.type   = show ? 'text' : 'password';
    const icon = btn instanceof HTMLElement
        ? (btn.querySelector('i') || btn)
        : btn;
    if (icon) {
        icon.className = show ? 'fas fa-eye-slash' : 'fas fa-eye';
    }
};


// ── Auto-attach password toggles ─────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', function () {
    document.querySelectorAll('input[type="password"]').forEach(function (inp) {
        const wrap = inp.closest('.input-wrap');
        if (wrap && !wrap.querySelector('.toggle-pw, .input-toggle')) {
            const btn = document.createElement('button');
            btn.type      = 'button';
            btn.className = 'input-toggle';
            btn.setAttribute('aria-label', 'Toggle password visibility');
            btn.innerHTML = '<i class="fas fa-eye"></i>';
            btn.addEventListener('click', function () {
                const show = inp.type === 'password';
                inp.type   = show ? 'text' : 'password';
                btn.querySelector('i').className = show ? 'fas fa-eye-slash' : 'fas fa-eye';
                btn.setAttribute('aria-label', show ? 'Hide password' : 'Show password');
            });
            wrap.appendChild(btn);
        }
    });
});