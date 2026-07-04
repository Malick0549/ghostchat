"""
GhostChat :: backend/flask_app.py
==================================
Flask serves BOTH the frontend (../frontend/) and the API.

Run locally:
    cd backend
    python flask_app.py

Deployed on Render:
    - Set env var FLASK_SECRET to a long random string
    - Set env var RENDER=true  (Render sets this automatically)
    - The app auto-detects HTTPS and sets cookies correctly
"""

# ── FIX: eventlet monkey patch MUST be first ─────────────────────────────────
import sys
import os as _os

# When flask_app.py runs from the repo ROOT, add backend/ to sys.path
# so that `from backend.models import ...` and `from backend.api import ...` work.
# When running from inside backend/ (local dev), this is a no-op.
_backend_dir = _os.path.join(_os.path.dirname(_os.path.abspath(__file__)), 'backend')
if _os.path.isdir(_backend_dir) and _backend_dir not in sys.path:
    sys.path.insert(0, _backend_dir)

try:
    import eventlet
    eventlet.monkey_patch()
    EVENTLET_AVAILABLE = True
except Exception as exc:
    EVENTLET_AVAILABLE = False
    sys.stderr.write(
        f"Warning: eventlet unavailable ({exc}). "
        "Falling back to threading for local debugging.\n"
    )

import os
import logging
import secrets
import smtplib
import ssl
import uuid
from datetime import datetime, timedelta
from email.message import EmailMessage

from flask import (
    Flask, jsonify, request, session,
    send_from_directory
)
from flask_cors import CORS
# flask_session removed — using Flask built-in signed cookie sessions
from flask_socketio import SocketIO, emit, join_room, leave_room

# ── Local packages (run from inside backend/) ─────────────────────────────────
from backend.api import crypto_bp, session_bp
from backend.api.errors import register_error_handlers
from backend.api.middleware import add_security_headers

# ── Database models ────────────────────────────────────────────────────────────
try:
    from backend.models import (
        db,
        bcrypt,
        User,
        UserSession,
        Message,
        IntegrationToken,
        Contact,
        ContactRequest,   # ── FIX: use the existing dedicated request table instead of a Contact.status hack ──
    )
    DB_AVAILABLE = True
except ImportError:
    DB_AVAILABLE = False

logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s  %(levelname)-8s  %(name)s  %(message)s',
)
log = logging.getLogger('ghostchat')


def _is_https():
    """True when the current request arrived over HTTPS (including behind a proxy)."""
    return (
        request.is_secure
        or request.headers.get('X-Forwarded-Proto') == 'https'
        or bool(os.environ.get('RENDER'))
        or bool(os.environ.get('RAILWAY'))  # ── FIX: Added Railway detection ──
    )


def create_app(test_config=None):

    # ── Flask app ──────────────────────────────────────────────────────────────
    # Use absolute path so Flask finds frontend/ correctly regardless
    # of working directory in Docker or whether this module lives at root.
    _basedir = os.path.abspath(os.path.dirname(__file__))
    _frontend = os.path.abspath(os.path.join(_basedir, 'frontend'))

    app = Flask(
        __name__,
        static_folder=_frontend,
        static_url_path='',
    )

    # ── Detect environment ─────────────────────────────────────────────────────
    IS_PROD = bool(
        os.environ.get('RENDER')
        or os.environ.get('FLASK_ENV') == 'production'
    )

    # ── Core config ────────────────────────────────────────────────────────────
    app.config.update(
        SECRET_KEY                  = os.environ.get('FLASK_SECRET', secrets.token_hex(32)),
        DEBUG                       = not IS_PROD and os.environ.get('FLASK_DEBUG', '0') == '1',
        JSON_SORT_KEYS              = False,
        TESTING                     = False,
        # Flask built-in signed cookie sessions (no flask-session needed)
        SESSION_PERMANENT           = False,
        PERMANENT_SESSION_LIFETIME  = timedelta(hours=24),
        SESSION_COOKIE_NAME         = 'ghostchat_sess',
        SESSION_COOKIE_HTTPONLY     = True,
        SESSION_COOKIE_SECURE       = IS_PROD,
        SESSION_COOKIE_SAMESITE     = 'None' if IS_PROD else 'Lax',
    )

    # ── Database ───────────────────────────────────────────────────────────────
    basedir = os.path.abspath(os.path.dirname(__file__))
    app.config['SQLALCHEMY_DATABASE_URI'] = (
        os.environ.get('DATABASE_URL')
        or f'sqlite:///{os.path.join(basedir, "ghostchat.db")}'
    )
    app.config['SQLALCHEMY_TRACK_MODIFICATIONS'] = False

    # ── Upload folder ──────────────────────────────────────────────────────────
    upload_folder = os.path.join(basedir, '..', 'frontend', 'assets', 'uploads')
    os.makedirs(upload_folder, exist_ok=True)
    app.config['UPLOAD_FOLDER'] = upload_folder

    if test_config:
        app.config.update(test_config)

    # ── Extensions ─────────────────────────────────────────────────────────────
    if DB_AVAILABLE:
        db.init_app(app)
        bcrypt.init_app(app)
        with app.app_context():
            db.create_all()
            log.info('Database ready')

    # Session(app) removed — using Flask built-in sessions

    # ── CORS ───────────────────────────────────────────────────────────────────
    allowed_origins = [
        'http://localhost:5000',
        'http://127.0.0.1:5000',
        'https://ghostchat-5slo.onrender.com',
        'https://ghostchat-production-6c0b.up.railway.app',  # ── FIX: explicit current Railway domain ──
        'null',
    ]
    # Also pick up any dynamically-configured Render URL (kept for compatibility)
    render_url = os.environ.get('RENDER_EXTERNAL_URL', '').rstrip('/')
    if render_url and render_url not in allowed_origins:
        allowed_origins.append(render_url)

    # ── FIX: this only ever checked for a Render URL, a leftover from before
    # the migration to Railway — it never picked up the actual Railway domain.
    # Railway sets RAILWAY_PUBLIC_DOMAIN automatically to the live public host,
    # so this keeps CORS/SocketIO working even if the domain changes later. ──
    railway_domain = os.environ.get('RAILWAY_PUBLIC_DOMAIN', '').strip()
    if railway_domain:
        railway_url = f'https://{railway_domain}'.rstrip('/')
        if railway_url not in allowed_origins:
            allowed_origins.append(railway_url)

    CORS(
        app,
        supports_credentials=True,
        origins=allowed_origins,
        allow_headers=['Content-Type', 'X-CSRF-Token', 'X-Requested-With'],
        methods=['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    )
    log.info(f'Allowed origins: {allowed_origins}')

    # ── Blueprints ─────────────────────────────────────────────────────────────
    app.register_blueprint(crypto_bp)    # /encrypt, /decrypt  (session-key API)
    app.register_blueprint(session_bp)   # /new-session, /session-info, etc.

    # ── Security headers + error handlers ──────────────────────────────────────
    app.after_request(add_security_headers)
    register_error_handlers(app)

    # ── SocketIO ──────────────────────────────────────────────────────────────
    # ── FIX: SocketIO with proper async_mode handling ────────────────────────
    global socketio
    try:
        # eventlet is already imported and monkey patched above
        socketio = SocketIO(
            app,
            cors_allowed_origins=allowed_origins,
            async_mode='eventlet',
            logger=False,
            engineio_logger=False,
        )
        log.info('SocketIO initialized with eventlet async mode')
    except Exception as e:
        log.warning(f'Eventlet initialization failed: {e}, falling back to threading')
        socketio = SocketIO(
            app,
            cors_allowed_origins=allowed_origins,
            async_mode='threading',
            logger=False,
            engineio_logger=False,
        )
        log.warning('SocketIO using threading mode')

    # ═══════════════════════════════════════════════════════════════════════════
    # CSRF — Double-Submit Cookie Pattern
    # ═══════════════════════════════════════════════════════════════════════════
    #
    # 1. GET /api/csrf-token  → server generates token, sets as READABLE cookie
    #                           AND returns in JSON.
    # 2. Frontend stores token in memory, sends as X-CSRF-Token header.
    # 3. Server compares header to cookie (constant-time).
    #    Attacker on another origin cannot read the cookie → cannot forge header.
    # 4. Stateless: no server-side session lookup for CSRF, eliminating the
    #    race condition between OPTIONS preflight and the first POST.
    # ═══════════════════════════════════════════════════════════════════════════

    CSRF_COOKIE = 'gc_csrf'

    @app.route('/api/csrf-token', methods=['GET', 'OPTIONS'])
    def csrf_token():
        if request.method == 'OPTIONS':
            return '', 200
        token = request.cookies.get(CSRF_COOKIE) or secrets.token_hex(32)
        resp = jsonify({'csrf_token': token})
        https = _is_https()
        # ── FIX: Force secure for Railway ────────────────────────────────────
        is_railway = bool(os.environ.get('RAILWAY'))
        secure_cookie = https or is_railway
        
        resp.set_cookie(
            CSRF_COOKIE,
            token,
            httponly=False,                         # JS must read it
            samesite='None' if secure_cookie else 'Lax',
            secure=secure_cookie,  # ── Changed from 'https' to 'secure_cookie' ──
            max_age=3600,
            path='/',
        )
        return resp, 200

    def _check_csrf():
        """
        Validate CSRF for mutating requests.
        Returns (None, None) on pass, (response, code) on failure.
        """
        if request.method in ('GET', 'OPTIONS', 'HEAD'):
            return None, None
        if request.path in ('/api/csrf-token', '/health'):
            return None, None

        client_token = (
            request.headers.get('X-CSRF-Token')
            or (request.get_json(silent=True) or {}).get('csrf_token')
        )
        cookie_token = request.cookies.get(CSRF_COOKIE)

        if not client_token:
            return jsonify({
                'error': 'CSRF token missing',
                'hint': 'Call GET /api/csrf-token before submitting forms',
            }), 403
        if not cookie_token:
            return jsonify({
                'error': 'CSRF cookie missing',
                'hint': 'Call GET /api/csrf-token before submitting forms',
            }), 403
        if not secrets.compare_digest(str(client_token), str(cookie_token)):
            return jsonify({'error': 'CSRF token invalid'}), 403

        return None, None

    @app.before_request
    def enforce_csrf():
        err, code = _check_csrf()
        if err:
            return err, code

    # ═══════════════════════════════════════════════════════════════════════════
    # AUTH HELPERS
    # ═══════════════════════════════════════════════════════════════════════════

    def _require_auth():
        """Return (user, None) if authenticated, else (None, (response, code))."""
        if not DB_AVAILABLE:
            return None, (jsonify({'error': 'Database not available'}), 500)
        uid = session.get('user_id')
        if not uid:
            return None, (jsonify({'error': 'Not authenticated'}), 401)
        user = User.query.get(uid)
        if not user:
            session.clear()
            return None, (jsonify({'error': 'User not found'}), 401)
        return user, None

    def _rotate_csrf_cookie(resp):
        """Issue a fresh CSRF token cookie after login/register."""
        token = secrets.token_hex(32)
        https = _is_https()
        # ── FIX: Force secure for Railway ────────────────────────────────────
        is_railway = bool(os.environ.get('RAILWAY'))
        secure_cookie = https or is_railway
        
        resp.set_cookie(
            CSRF_COOKIE, token,
            httponly=False,
            samesite='None' if secure_cookie else 'Lax',
            secure=secure_cookie,  # ── Changed from 'https' to 'secure_cookie' ──
            max_age=3600, path='/',
        )
        return resp

    def _get_reset_url(token: str) -> str:
        base_url = os.environ.get('RESET_URL_BASE')
        if base_url:
            return f"{base_url.rstrip('/')}/forgot-password.html?token={token}"

        host = request.headers.get('X-Forwarded-Host') or request.host
        scheme = 'https' if _is_https() else 'http'
        return f"{scheme}://{host.rstrip('/')}/forgot-password.html?token={token}"

    def _send_email(subject: str, recipient: str, html_body: str, text_body: str) -> bool:
        smtp_host = os.environ.get('SMTP_HOST')
        smtp_port = int(os.environ.get('SMTP_PORT', '587'))
        smtp_user = os.environ.get('SMTP_USER')
        smtp_password = os.environ.get('SMTP_PASSWORD')
        smtp_use_ssl = os.environ.get('SMTP_USE_SSL', '0').lower() in ('1', 'true', 'yes')
        smtp_use_tls = os.environ.get('SMTP_USE_TLS', '1').lower() in ('1', 'true', 'yes')
        mail_from = os.environ.get('MAIL_FROM', f'no-reply@{request.host.split(":")[0]}')

        log_dir = os.path.join(os.path.dirname(__file__), '..', 'logs')
        os.makedirs(log_dir, exist_ok=True)
        fallback_path = os.path.join(log_dir, 'reset_links.log')

        def write_debug_link():
            try:
                with open(fallback_path, 'a', encoding='utf-8') as f:
                    f.write(f"{datetime.utcnow().isoformat()} | {recipient} | {text_body}\n")
            except Exception:
                pass

        if not smtp_host or not smtp_user or not smtp_password:
            log.warning('SMTP settings missing; password reset email not sent.')
            log.info('Password reset link: %s', text_body)
            write_debug_link()
            return False

        msg = EmailMessage()
        msg['Subject'] = subject
        msg['From'] = mail_from
        msg['To'] = recipient
        msg.set_content(text_body)
        msg.add_alternative(html_body, subtype='html')

        try:
            if smtp_use_ssl:
                context = ssl.create_default_context()
                with smtplib.SMTP_SSL(smtp_host, smtp_port, context=context, timeout=10) as smtp:
                    smtp.login(smtp_user, smtp_password)
                    smtp.send_message(msg)
            else:
                context = ssl.create_default_context()
                with smtplib.SMTP(smtp_host, smtp_port, timeout=10) as smtp:
                    if smtp_use_tls:
                        smtp.starttls(context=context)
                    smtp.login(smtp_user, smtp_password)
                    smtp.send_message(msg)
            return True
        except Exception as exc:
            log.error('Failed to send password reset email to %s: %s', recipient, exc)
            log.info('Password reset link: %s', text_body)
            write_debug_link()
            return False

    # ═══════════════════════════════════════════════════════════════════════════
    # AUTHENTICATION ROUTES
    # ═══════════════════════════════════════════════════════════════════════════

    @app.route('/api/auth/register', methods=['POST', 'OPTIONS'])
    def register():
        if request.method == 'OPTIONS':
            return '', 200
        err, code = _check_csrf()
        if err:
            return err, code
        if not DB_AVAILABLE:
            return jsonify({'error': 'Database not available'}), 500

        try:
            data = request.get_json() or {}
            username   = (data.get('username')   or '').strip()
            email      = (data.get('email')      or '').strip()
            password   = data.get('password')    or ''
            first_name = (data.get('first_name') or '').strip()
            last_name  = (data.get('last_name')  or '').strip()

            if not username or not email or not password:
                return jsonify({'error': 'Username, email, and password are required'}), 400
            if len(password) < 8:
                return jsonify({'error': 'Password must be at least 8 characters'}), 400
            if User.query.filter_by(username=username).first():
                return jsonify({'error': 'Username already taken'}), 400
            if User.query.filter_by(email=email).first():
                return jsonify({'error': 'Email already registered'}), 400

            user = User(username=username, email=email)
            user.set_password(password)
            db.session.add(user)
            db.session.commit()

            session['user_id']       = user.id
            session['authenticated'] = True
            log.info(f'User registered: {username}')

            resp = jsonify({'success': True, 'user': user.to_dict()})
            return _rotate_csrf_cookie(resp), 201

        except Exception as exc:
            db.session.rollback() if DB_AVAILABLE else None
            log.error(f'Register error: {exc}')
            return jsonify({'error': 'Registration failed. Please try again.'}), 500

    @app.route('/api/auth/login', methods=['POST', 'OPTIONS'])
    def login():
        if request.method == 'OPTIONS':
            return '', 200
        err, code = _check_csrf()
        if err:
            return err, code
        if not DB_AVAILABLE:
            return jsonify({'error': 'Database not available'}), 500

        try:
            data     = request.get_json() or {}
            username = (data.get('username') or '').strip()
            password = data.get('password') or ''

            if not username or not password:
                return jsonify({'error': 'Username and password are required'}), 400

            # Accept username OR email
            user = (
                User.query.filter_by(username=username).first()
                or User.query.filter_by(email=username).first()
            )

            # Constant-time failure — same message for wrong user and wrong password
            if not user or not user.check_password(password):
                log.warning(f'Failed login for: {username[:30]}')
                return jsonify({'error': 'Invalid credentials'}), 401

            if not user.is_active:
                return jsonify({'error': 'Account is disabled'}), 401

            user.last_login = datetime.utcnow()
            db.session.commit()

            session['user_id']       = user.id
            session['authenticated'] = True
            log.info(f'User logged in: {user.username}')

            resp = jsonify({'success': True, 'user': user.to_dict()})
            return _rotate_csrf_cookie(resp), 200

        except Exception as exc:
            log.error(f'Login error: {exc}')
            return jsonify({'error': 'Login failed. Please try again.'}), 500

    @app.route('/api/auth/logout', methods=['POST', 'OPTIONS'])
    def logout():
        if request.method == 'OPTIONS':
            return '', 200
        session.clear()
        return jsonify({'success': True, 'message': 'Logged out'}), 200

    @app.route('/api/auth/me', methods=['GET', 'OPTIONS'])
    def get_current_user():
        if request.method == 'OPTIONS':
            return '', 200
        user, err = _require_auth()
        if err:
            return err
        return jsonify({'user': user.to_dict()}), 200

    @app.route('/api/auth/forgot-password', methods=['POST', 'OPTIONS'])
    def forgot_password():
        if request.method == 'OPTIONS':
            return '', 200
        if not DB_AVAILABLE:
            return jsonify({'error': 'Database not available'}), 500

        try:
            data  = request.get_json() or {}
            email = (data.get('email') or '').strip()
            if not email:
                return jsonify({'error': 'Email is required'}), 400

            user = User.query.filter_by(email=email).first()
            if user:
                token = user.generate_reset_token()
                # Override model's 24h expiry to 15 min (matches UI messaging)
                user.reset_token_expires = datetime.utcnow() + timedelta(minutes=15)
                db.session.commit()

                reset_link = _get_reset_url(token)
                plaintext = (
                    f"Hello,\n\n"
                    f"A password reset request was received for your GhostChat account. "
                    f"If this was you, click the link below to reset your password:\n\n"
                    f"{reset_link}\n\n"
                    f"This link expires in 15 minutes. If you did not request a reset, you can safely ignore this message.\n\n"
                    f"— GhostChat Security Team"
                )
                html = (
                    f"<p>Hello,</p>"
                    f"<p>A password reset request was received for your GhostChat account. "
                    f"If this was you, click the link below to reset your password:</p>"
                    f"<p><a href=\"{reset_link}\">Reset your password</a></p>"
                    f"<p>This link expires in 15 minutes. If you did not request a reset, you can safely ignore this message.</p>"
                    f"<p>— GhostChat Security Team</p>"
                )

                sent = _send_email(
                    subject='GhostChat Password Reset',
                    recipient=user.email,
                    html_body=html,
                    text_body=plaintext,
                )
                if sent:
                    log.info(f'Password reset email sent to: {email}')
                else:
                    log.warning(f'Password reset email failed for: {email}; link logged in server output.')

            response = {
                'success': True,
                'message': 'If that email is registered, a reset link has been sent.',
            }
            if app.debug and not sent and user:
                response['debug_link'] = reset_link
            return jsonify(response), 200

        except Exception as exc:
            log.error(f'Forgot-password error: {exc}')
            return jsonify({'error': 'Request failed. Please try again.'}), 500

    @app.route('/api/auth/reset-password', methods=['POST', 'OPTIONS'])
    def reset_password():
        if request.method == 'OPTIONS':
            return '', 200
        if not DB_AVAILABLE:
            return jsonify({'error': 'Database not available'}), 500

        try:
            data         = request.get_json() or {}
            token        = (data.get('token')        or '').strip()
            new_password = (data.get('new_password') or '')

            if not token or not new_password:
                return jsonify({'error': 'Token and new password are required'}), 400
            if len(new_password) < 8:
                return jsonify({'error': 'Password must be at least 8 characters'}), 400

            user = User.query.filter_by(reset_token=token).first()
            if not user or not user.verify_reset_token(token):
                return jsonify({'error': 'Invalid or expired reset link'}), 400

            user.set_password(new_password)
            user.reset_token         = None
            user.reset_token_expires = None
            db.session.commit()

            log.info(f'Password reset successful: {user.username}')
            return jsonify({'success': True, 'message': 'Password reset successful'}), 200

        except Exception as exc:
            log.error(f'Reset-password error: {exc}')
            return jsonify({'error': 'Reset failed. Please try again.'}), 500

    # ═══════════════════════════════════════════════════════════════════════════
    # PROFILE ROUTES
    # ═══════════════════════════════════════════════════════════════════════════

    @app.route('/api/profile', methods=['GET', 'OPTIONS'])
    def get_profile():
        if request.method == 'OPTIONS':
            return '', 200
        user, err = _require_auth()
        if err:
            return err
        return jsonify({'user': user.to_dict()}), 200

    @app.route('/api/profile', methods=['PUT', 'OPTIONS'])
    def update_profile():
        if request.method == 'OPTIONS':
            return '', 200
        user, err = _require_auth()
        if err:
            return err
        data = request.get_json() or {}

        new_username = (data.get('username') or '').strip()
        new_email    = (data.get('email')    or '').strip()

        if new_username and new_username != user.username:
            if User.query.filter_by(username=new_username).first():
                return jsonify({'error': 'Username already taken'}), 400
            user.username = new_username

        if new_email and new_email != user.email:
            if User.query.filter_by(email=new_email).first():
                return jsonify({'error': 'Email already registered'}), 400
            user.email = new_email

        if 'two_factor_enabled' in data:
            user.two_factor_enabled = bool(data['two_factor_enabled'])

        db.session.commit()
        return jsonify({'success': True, 'user': user.to_dict()}), 200

    @app.route('/api/profile/password', methods=['PUT', 'OPTIONS'])
    def change_password():
        if request.method == 'OPTIONS':
            return '', 200
        user, err = _require_auth()
        if err:
            return err

        data         = request.get_json() or {}
        old_password = data.get('old_password') or ''
        new_password = data.get('new_password') or ''

        if not old_password or not new_password:
            return jsonify({'error': 'Both old and new passwords are required'}), 400
        if len(new_password) < 8:
            return jsonify({'error': 'New password must be at least 8 characters'}), 400
        if not user.check_password(old_password):
            return jsonify({'error': 'Current password is incorrect'}), 401

        user.set_password(new_password)
        db.session.commit()
        session.clear()   # Force re-login after password change
        return jsonify({
            'success': True,
            'message': 'Password changed. Please sign in again.',
        }), 200

    @app.route('/api/profile/avatar', methods=['POST', 'OPTIONS'])
    def upload_avatar():
        if request.method == 'OPTIONS':
            return '', 200
        user, err = _require_auth()
        if err:
            return err

        if 'avatar' not in request.files:
            return jsonify({'error': 'No file provided'}), 400

        file = request.files['avatar']
        if not file or not file.filename:
            return jsonify({'error': 'No file selected'}), 400

        allowed = {'png', 'jpg', 'jpeg', 'gif', 'webp'}
        ext = file.filename.rsplit('.', 1)[-1].lower() if '.' in file.filename else ''
        if ext not in allowed:
            return jsonify({'error': f'Invalid file type. Use: {", ".join(allowed).upper()}'}), 400

        file.seek(0, 2)
        size = file.tell()
        file.seek(0)
        if size > 2 * 1024 * 1024:
            return jsonify({'error': 'File too large — maximum 2 MB'}), 400

        # Remove old avatar file
        if user.avatar and '/assets/uploads/' in (user.avatar or ''):
            old = os.path.join(app.config['UPLOAD_FOLDER'], os.path.basename(user.avatar))
            try:
                os.remove(old)
            except OSError:
                pass

        filename = f"avatar_{user.id}_{int(datetime.utcnow().timestamp())}.{ext}"
        file.save(os.path.join(app.config['UPLOAD_FOLDER'], filename))
        user.avatar = f'/assets/uploads/{filename}'
        db.session.commit()

        return jsonify({
            'success': True,
            'avatar':  user.avatar,
            'message': 'Avatar updated',
        }), 200

    @app.route('/assets/uploads/<path:filename>')
    def serve_upload(filename):
        return send_from_directory(app.config['UPLOAD_FOLDER'], filename)

    # ═══════════════════════════════════════════════════════════════════════════
    # ENCRYPT / DECRYPT  (password-based — used by encrypt.js / decrypt.js)
    # ═══════════════════════════════════════════════════════════════════════════

    @app.route('/api/encrypt', methods=['POST', 'OPTIONS'])
    def encrypt_message():
        if request.method == 'OPTIONS':
            return '', 200
        try:
            data    = request.get_json() or {}
            message = (data.get('message')  or '').strip()
            password= (data.get('password') or '').strip()
            decoys  = bool(data.get('use_decoys', False))

            if not message:
                return jsonify({'success': False, 'error': 'Message is required'}), 400
            if not password:
                return jsonify({'success': False, 'error': 'Password is required'}), 400

            from backend.ghostchat import GhostChat, GhostChatError
            ghost  = GhostChat(password)
            packet = ghost.send_message(message, use_decoy_emojis=decoys)

            return jsonify({
                'success':       True,
                'emoji_message': packet,
                'emoji_count':   len(packet),
                'algorithm':     'AES-256-CBC',
                'key_derivation':'PBKDF2-HMAC-SHA256',
            }), 200

        except Exception as exc:
            log.error(f'Encrypt error: {exc}')
            return jsonify({'success': False, 'error': str(exc)}), 500

    @app.route('/api/decrypt', methods=['POST', 'OPTIONS'])
    def decrypt_message():
        if request.method == 'OPTIONS':
            return '', 200
        try:
            data          = request.get_json() or {}
            emoji_message = (data.get('emoji_message') or '').strip()
            password      = (data.get('password')      or '').strip()

            if not emoji_message:
                return jsonify({'success': False, 'error': 'Encrypted message is required'}), 400
            if not password:
                return jsonify({'success': False, 'error': 'Password is required'}), 400

            from backend.ghostchat import GhostChat
            ghost     = GhostChat(password)
            plaintext = ghost.receive_message(emoji_message)

            if plaintext.startswith('Decryption failed'):
                return jsonify({'success': False, 'error': plaintext}), 400

            return jsonify({
                'success':           True,
                'decrypted_message': plaintext,
                'algorithm':         'AES-256-CBC',
            }), 200

        except Exception as exc:
            log.error(f'Decrypt error: {exc}')
            return jsonify({'success': False, 'error': str(exc)}), 500

    # ═══════════════════════════════════════════════════════════════════════════
    # MESSAGE HISTORY
    # ═══════════════════════════════════════════════════════════════════════════

    @app.route('/api/messages', methods=['GET', 'OPTIONS'])
    def get_messages():
        if request.method == 'OPTIONS':
            return '', 200
        if not DB_AVAILABLE:
            return jsonify({'success': True, 'messages': [], 'total': 0}), 200

        user, err = _require_auth()
        if err:
            return err

        limit  = request.args.get('limit',  100, type=int)
        offset = request.args.get('offset',  0,  type=int)

        msgs  = (Message.query
                 .filter_by(user_id=user.id)
                 .order_by(Message.created_at.desc())
                 .limit(limit).offset(offset).all())
        total = Message.query.filter_by(user_id=user.id).count()

        return jsonify({
            'success':  True,
            'messages': [m.to_dict() for m in msgs],
            'total':    total,
        }), 200

    @app.route('/api/messages', methods=['POST', 'OPTIONS'])
    def save_message():
        if request.method == 'OPTIONS':
            return '', 200
        if not DB_AVAILABLE:
            return jsonify({'success': True, 'message_id': 'local'}), 201

        user, err = _require_auth()
        if err:
            return err

        data = request.get_json() or {}
        msg  = Message(
            user_id           = user.id,
            encrypted_content = data.get('encrypted_content', ''),
            emoji_content     = data.get('emoji_content', ''),
            message_type      = data.get('message_type', 'encryption'),
        )
        db.session.add(msg)
        db.session.commit()
        return jsonify({'success': True, 'message_id': msg.id}), 201

    @app.route('/api/messages/<message_id>', methods=['DELETE', 'OPTIONS'])
    def delete_message(message_id):
        if request.method == 'OPTIONS':
            return '', 200
        if not DB_AVAILABLE:
            return jsonify({'success': True}), 200

        user, err = _require_auth()
        if err:
            return err

        msg = Message.query.filter_by(id=message_id, user_id=user.id).first()
        if not msg:
            return jsonify({'error': 'Message not found'}), 404

        db.session.delete(msg)
        db.session.commit()
        return jsonify({'success': True}), 200

    # ═══════════════════════════════════════════════════════════════════════════
    # HEALTH + FRONTEND
    # ═══════════════════════════════════════════════════════════════════════════

    @app.route('/health')
    def health():
        return jsonify({
            'status':      'ok',
            'service':     'GhostChat API',
            'environment': 'production' if IS_PROD else 'development',
            'database':    'connected' if DB_AVAILABLE else 'disabled',
            'version':     '3.0.0',
        }), 200

    # Serve frontend — use app.send_static_file() instead of send_from_directory
    # send_from_directory uses sendfile() syscall which eventlet doesn't patch,
    # causing IncompleteRead errors on large files. send_static_file() goes
    # through Flask's WSGI response which eventlet handles correctly.

    @app.route('/')
    def index():
        return app.send_static_file('index.html')

    @app.route('/<path:filename>')
    def serve_static(filename):
        SAFE_EXTENSIONS = (
            '.html', '.css', '.js', '.png', '.jpg', '.jpeg',
            '.gif', '.svg', '.ico', '.json', '.woff', '.woff2',
            '.ttf', '.webp', '.txt', '.map',
        )
        if any(filename.lower().endswith(ext) for ext in SAFE_EXTENSIONS):
            try:
                return app.send_static_file(filename)
            except Exception:
                pass
        return jsonify({'error': 'Not Found'}), 404

    log.info(f'GhostChat ready  [{"production" if IS_PROD else "development"}]')
    
    # ── WebSocket Events ──────────────────────────────────────────────────────

    # ══════════════════════════════════════
    # CONTACT ROUTES
    # ══════════════════════════════════════

    @app.route('/api/contacts', methods=['GET','OPTIONS'])
    def get_contacts():
        if request.method == 'OPTIONS': return '', 200
        user, err = _require_auth()
        if err: return err
        contacts = Contact.query.filter_by(user_id=user.id, is_blocked=False).all()
        result = []
        for c in contacts:
            cu = User.query.get(c.contact_id)
            if not cu: continue
            last_msg = Message.query.filter(
                Message.is_deleted == False, Message.message_type == 'chat',
                db.or_(
                    db.and_(Message.sender_id==user.id, Message.receiver_id==c.contact_id),
                    db.and_(Message.sender_id==c.contact_id, Message.receiver_id==user.id),
                )
            ).order_by(Message.created_at.desc()).first()
            unread = Message.query.filter_by(
                sender_id=c.contact_id, receiver_id=user.id,
                is_read=False, message_type='chat'
            ).count()
            result.append({
                'id': c.id, 'contact_id': cu.id, 'username': cu.username,
                'display_name': c.display_name or cu.username,
                'avatar': cu.avatar, 'about': cu.about,
                'is_online': cu.is_online,
                'last_seen': cu.last_seen.isoformat() if cu.last_seen else None,
                'is_favorite': c.is_favorite, 'unread_count': unread,
                'last_message': {
                    'content': last_msg.encrypted_content,
                    'created_at': last_msg.created_at.isoformat(),
                    'is_mine': last_msg.sender_id == user.id,
                } if last_msg else None,
            })
        result.sort(key=lambda x: (not x['is_favorite'], x['last_message']['created_at'] if x['last_message'] else ''))
        return jsonify({'success': True, 'contacts': result}), 200

    @app.route('/api/contacts/search', methods=['GET','OPTIONS'])
    def search_users():
        if request.method == 'OPTIONS': return '', 200
        user, err = _require_auth()
        if err: return err
        q = (request.args.get('q') or '').strip()
        if len(q) < 2: return jsonify({'success': True, 'users': []}), 200
        matches = User.query.filter(
            User.id != user.id, User.is_active == True,
            db.or_(User.username.ilike(f'%{q}%'), User.email.ilike(f'%{q}%'))
        ).limit(20).all()
        existing  = {c.contact_id for c in Contact.query.filter_by(user_id=user.id).all()}
        pending   = {r.recipient_id for r in ContactRequest.query.filter_by(sender_id=user.id, status='pending').all()}
        incoming  = {r.sender_id for r in ContactRequest.query.filter_by(recipient_id=user.id, status='pending').all()}
        return jsonify({'success': True, 'users': [{
            'id': u.id, 'username': u.username, 'avatar': u.avatar,
            'about': u.about, 'is_online': u.is_online, 'is_contact': u.id in existing,
            'is_pending': u.id in pending, 'is_incoming': u.id in incoming,
        } for u in matches]}), 200

    def _room_size(room):
        """How many active sockets are in a room right now — lets us tell
        'nobody was listening' apart from 'the emit itself never happened'."""
        try:
            return len(list(socketio.server.manager.get_participants('/', room)))
        except Exception as e:
            return f'unknown ({e})'

    def _accept_contact_request(user, requester_id, req_row=None):
        """Marks the request accepted and creates the mutual Contact rows."""
        req_row = req_row or ContactRequest.query.filter_by(
            sender_id=requester_id, recipient_id=user.id, status='pending').first()
        if not req_row:
            return jsonify({'error': 'No pending request found'}), 404

        req_row.status = 'accepted'
        requester = User.query.get(requester_id)

        if not Contact.query.filter_by(user_id=user.id, contact_id=requester_id).first():
            db.session.add(Contact(user_id=user.id, contact_id=requester_id,
                                    display_name=requester.username if requester else None))
        if not Contact.query.filter_by(user_id=requester_id, contact_id=user.id).first():
            db.session.add(Contact(user_id=requester_id, contact_id=user.id,
                                    display_name=user.username))
        db.session.commit()

        if socketio:
            room = f'user_{requester_id}'
            log.info(f'[room] emitting friend_request_accepted to {room} '
                     f'({_room_size(room)} socket(s) connected)')
            socketio.emit('friend_request_accepted', {
                'from': user.id, 'username': user.username, 'avatar': user.avatar,
            }, room=room)
        return jsonify({'success': True, 'message': 'Connected', 'status': 'accepted'}), 200

    @app.route('/api/contacts', methods=['POST','OPTIONS'])
    def add_contact():
        """
        Sends a connection request — does NOT create a usable contact yet.
        The invited user must confirm via POST /api/contacts/<id>/respond
        before either side can message the other.
        """
        if request.method == 'OPTIONS': return '', 200
        user, err = _require_auth()
        if err: return err
        data = request.get_json() or {}
        contact_id = (data.get('contact_id') or '').strip()
        if not contact_id: return jsonify({'error': 'contact_id required'}), 400
        if contact_id == user.id: return jsonify({'error': 'Cannot add yourself'}), 400
        cu = User.query.get(contact_id)
        if not cu: return jsonify({'error': 'User not found'}), 404

        if Contact.query.filter_by(user_id=user.id, contact_id=contact_id).first():
            return jsonify({'error': 'Already in contacts'}), 400

        # They already sent you a request — this call accepts it instead of duplicating it
        incoming = ContactRequest.query.filter_by(
            sender_id=contact_id, recipient_id=user.id, status='pending').first()
        if incoming:
            return _accept_contact_request(user, contact_id, req_row=incoming)

        existing = ContactRequest.query.filter_by(sender_id=user.id, recipient_id=contact_id).first()
        if existing:
            if existing.status == 'pending':
                return jsonify({'error': 'Request already sent'}), 400
            existing.status = 'pending'   # re-request after a prior rejection
            existing.updated_at = datetime.utcnow()
            db.session.commit()
        else:
            db.session.add(ContactRequest(sender_id=user.id, recipient_id=contact_id, status='pending'))
            db.session.commit()

        if socketio:
            room = f'user_{contact_id}'
            log.info(f'[room] emitting friend_request to {room} '
                     f'({_room_size(room)} socket(s) connected)')
            socketio.emit('friend_request', {
                'from': user.id, 'username': user.username, 'avatar': user.avatar,
            }, room=room)

        return jsonify({'success': True, 'message': f'Request sent to {cu.username}',
                         'contact_id': contact_id, 'username': cu.username,
                         'avatar': cu.avatar, 'status': 'pending_sent'}), 201

    @app.route('/api/contacts/requests', methods=['GET','OPTIONS'])
    def list_contact_requests():
        """Incoming connection requests awaiting this user's confirmation."""
        if request.method == 'OPTIONS': return '', 200
        user, err = _require_auth()
        if err: return err
        rows = ContactRequest.query.filter_by(recipient_id=user.id, status='pending').all()
        result = []
        for r in rows:
            u = User.query.get(r.sender_id)
            if u:
                result.append({'contact_id': u.id, 'username': u.username, 'avatar': u.avatar})
        return jsonify({'success': True, 'requests': result}), 200

    @app.route('/api/contacts/<contact_id>/respond', methods=['POST','OPTIONS'])
    def respond_contact_request(contact_id):
        """Accept or reject an incoming connection request."""
        if request.method == 'OPTIONS': return '', 200
        user, err = _require_auth()
        if err: return err
        action = ((request.get_json() or {}).get('action') or '').strip().lower()

        req_row = ContactRequest.query.filter_by(
            sender_id=contact_id, recipient_id=user.id, status='pending').first()
        if not req_row:
            return jsonify({'error': 'No pending request found'}), 404

        if action == 'accept':
            return _accept_contact_request(user, contact_id, req_row=req_row)

        req_row.status = 'rejected'
        req_row.updated_at = datetime.utcnow()
        db.session.commit()
        if socketio:
            socketio.emit('friend_request_rejected', {'from': user.id}, room=f'user_{contact_id}')
        return jsonify({'success': True, 'message': 'Request declined'}), 200

    @app.route('/api/contacts/<contact_id>', methods=['DELETE','OPTIONS'])
    def remove_contact(contact_id):
        if request.method == 'OPTIONS': return '', 200
        user, err = _require_auth()
        if err: return err
        c = Contact.query.filter_by(user_id=user.id, contact_id=contact_id).first()
        if not c: return jsonify({'error': 'Not found'}), 404
        db.session.delete(c)
        db.session.commit()
        return jsonify({'success': True}), 200

    @app.route('/api/contacts/<contact_id>/block', methods=['POST','OPTIONS'])
    def block_contact(contact_id):
        if request.method == 'OPTIONS': return '', 200
        user, err = _require_auth()
        if err: return err
        c = Contact.query.filter_by(user_id=user.id, contact_id=contact_id).first()
        if not c: return jsonify({'error': 'Not found'}), 404
        c.is_blocked = True
        db.session.commit()
        return jsonify({'success': True}), 200

    # ══════════════════════════════════════
    # PRIVATE CHAT MESSAGE ROUTES
    # ══════════════════════════════════════

    @app.route('/api/chat/<contact_id>/messages', methods=['GET','OPTIONS'])
    def get_chat_messages(contact_id):
        if request.method == 'OPTIONS': return '', 200
        user, err = _require_auth()
        if err: return err
        limit  = request.args.get('limit', 50, type=int)
        before = request.args.get('before', None)
        query  = Message.query.filter(
            Message.is_deleted == False, Message.message_type == 'chat',
            db.or_(
                db.and_(Message.sender_id==user.id, Message.receiver_id==contact_id),
                db.and_(Message.sender_id==contact_id, Message.receiver_id==user.id),
            )
        )
        if before: query = query.filter(Message.created_at < before)
        messages = query.order_by(Message.created_at.desc()).limit(limit).all()
        messages.reverse()
        unread_msgs = Message.query.filter_by(sender_id=contact_id, receiver_id=user.id, is_read=False, message_type='chat').all()
        for m in unread_msgs:
            m.is_read = True
            m.read_at = datetime.utcnow()
        if unread_msgs: db.session.commit()
        return jsonify({'success': True, 'messages': [m.to_dict() for m in messages]}), 200

    @app.route('/api/chat/<contact_id>/messages', methods=['POST','OPTIONS'])
    def send_chat_message(contact_id):
        if request.method == 'OPTIONS': return '', 200
        user, err = _require_auth()
        if err: return err
        data    = request.get_json() or {}
        content = (data.get('content') or '').strip()
        if not content: return jsonify({'error': 'content required'}), 400
        msg = Message(user_id=user.id, sender_id=user.id, receiver_id=contact_id,
                      encrypted_content=content, message_type='chat')
        db.session.add(msg)
        db.session.commit()
        payload = {'id': msg.id, 'content': content, 'sender_id': user.id,
                   'sender': user.username, 'avatar': user.avatar,
                   'receiver_id': contact_id, 'created_at': msg.created_at.isoformat()}
        if socketio:
            # ── FIX: personal rooms only — matches the socket handler, no duplicates ──
            socketio.emit('receive_message', payload, room=f'user_{contact_id}')
            socketio.emit('receive_message', payload, room=f'user_{user.id}')
        return jsonify({'success': True, 'message': msg.to_dict()}), 201

    @socketio.on('connect')
    def handle_connect():
        log.info(f'Socket connected: {request.sid}')
        emit('connected', {'status': 'connected', 'sid': request.sid})

    @socketio.on('disconnect')
    def handle_disconnect():
        log.info(f'Socket disconnected: {request.sid}')
        if DB_AVAILABLE:
            try:
                uid = session.get('user_id')
                if uid:
                    u = User.query.get(uid)
                    if u:
                        u.is_online = False
                        u.last_seen = datetime.utcnow()
                        db.session.commit()
                        for c in Contact.query.filter_by(user_id=uid, is_blocked=False).all():
                            socketio.emit('user_offline', {'user_id': uid}, room=f'user_{c.contact_id}')
            except Exception: pass

    @socketio.on('join_user_room')
    def handle_join_user_room(data):
        user_id = data.get('user_id', '')
        if not user_id: return
        join_room(f'user_{user_id}')
        log.info(f'[room] sid={request.sid} joined user_{user_id} '
                 f'(room now has {_room_size(f"user_{user_id}")} socket(s))')
        emit('joined_room', {'room': f'user_{user_id}'})
        if DB_AVAILABLE:
            try:
                u = User.query.get(user_id)
                if u:
                    u.is_online = True
                    u.last_seen = datetime.utcnow()
                    db.session.commit()
                    for c in Contact.query.filter_by(user_id=user_id, is_blocked=False).all():
                        socketio.emit('user_online', {'user_id': user_id}, room=f'user_{c.contact_id}')
            except Exception: pass

    @socketio.on('join_room')
    def handle_join_room(data):
        room = data.get('room', '')
        if room:
            join_room(room)
            emit('joined_room', {'room': room})

    @socketio.on('leave_room')
    def handle_leave_room(data):
        room = data.get('room', '')
        if room: leave_room(room)

    @socketio.on('send_private_message')
    def handle_private_message(data):
        content     = (data.get('content') or '').strip()
        sender_id   = data.get('sender_id', '')
        sender      = data.get('sender', 'Ghost')
        avatar      = data.get('avatar', '')
        receiver_id = data.get('receiver_id', '')
        temp_id     = data.get('temp_id', '')
        if not content or not sender_id or not receiver_id:
            return

        # ── FIX: only accepted connections can exchange messages ──
        if DB_AVAILABLE:
            link = Contact.query.filter_by(user_id=sender_id, contact_id=receiver_id).first()
            if not link:
                emit('message_failed', {'temp_id': temp_id,
                                         'error': 'You are not connected with this user yet'})
                return

        msg_id     = str(uuid.uuid4())
        created_at = datetime.utcnow().isoformat()
        if DB_AVAILABLE:
            try:
                msg = Message(id=msg_id, user_id=sender_id, sender_id=sender_id,
                              receiver_id=receiver_id, encrypted_content=content,
                              message_type='chat', is_delivered=True)
                db.session.add(msg)
                db.session.commit()
                created_at = msg.created_at.isoformat()
            except Exception as e:
                log.error(f'Save chat msg failed: {e}')
                emit('message_failed', {'temp_id': temp_id, 'error': 'Could not save message'})
                return

        payload = {'id': msg_id, 'content': content, 'sender_id': sender_id,
                   'sender': sender, 'avatar': avatar, 'receiver_id': receiver_id,
                   'created_at': created_at, 'temp_id': temp_id}

        # ── FIX: deliver exactly once to each side via their personal room.
        log.info(f'[room] delivering msg {msg_id}: user_{receiver_id} has '
                 f'{_room_size(f"user_{receiver_id}")} socket(s), '
                 f'user_{sender_id} has {_room_size(f"user_{sender_id}")} socket(s)')
        emit('receive_message', payload, room=f'user_{receiver_id}')
        emit('receive_message', payload, room=f'user_{sender_id}')

    @socketio.on('typing')
    def handle_typing(data):
        room = data.get('room', '')
        if room:
            emit('typing', {'user_id': data.get('user_id'), 'username': data.get('username')},
                 room=room, include_self=False)

    @socketio.on('stop_typing')
    def handle_stop_typing(data):
        room = data.get('room', '')
        if room:
            emit('stop_typing', {'user_id': data.get('user_id')}, room=room, include_self=False)

    @socketio.on('ping')
    def handle_ping(data):
        emit('pong', {'timestamp': data.get('timestamp', 0)})

    return app


# ── Module-level variables for gunicorn ──────────────────────────────────────
# gunicorn binds to flask_app:app
# The socketio object is also available as flask_app:socketio for reference
socketio = None   # will be set by create_app()
app = create_app()

if __name__ == '__main__':
    port  = int(os.environ.get('PORT', 5000))
    debug = os.environ.get('FLASK_DEBUG', '0') == '1'
    if socketio:
        socketio.run(app, host='0.0.0.0', port=port, debug=debug)
    else:
        app.run(host='0.0.0.0', port=port, debug=debug)