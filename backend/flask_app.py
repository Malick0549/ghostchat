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

import os
import logging
import secrets
from datetime import datetime, timedelta

from flask import (
    Flask, jsonify, request, session,
    send_from_directory
)
from flask_cors import CORS
from flask_session import Session

# ── Local packages (run from inside backend/) ─────────────────────────────────
from api import crypto_bp, session_bp
from api.errors import register_error_handlers
from api.middleware import add_security_headers

# ── Database models ────────────────────────────────────────────────────────────
try:
    from models import db, bcrypt, User, UserSession, Message, IntegrationToken
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
    )


def create_app(test_config=None):

    # ── Flask app ──────────────────────────────────────────────────────────────
    app = Flask(
        __name__,
        static_folder='../frontend',
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
        # Session cookies
        SESSION_TYPE                = 'filesystem',
        SESSION_PERMANENT           = False,
        PERMANENT_SESSION_LIFETIME  = timedelta(hours=24),
        SESSION_COOKIE_NAME         = 'ghostchat_sess',
        SESSION_COOKIE_HTTPONLY     = True,
        SESSION_COOKIE_SECURE       = IS_PROD,          # HTTPS only in production
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

    Session(app)

    # ── CORS ───────────────────────────────────────────────────────────────────
    allowed_origins = [
        'http://localhost:5000',
        'http://127.0.0.1:5000',
        'https://ghostchat-5slo.onrender.com',
        'null',
    ]
    # Also pick up any dynamically-configured Render URL
    render_url = os.environ.get('RENDER_EXTERNAL_URL', '').rstrip('/')
    if render_url and render_url not in allowed_origins:
        allowed_origins.append(render_url)

    CORS(
        app,
        supports_credentials=True,
        origins=allowed_origins,
        allow_headers=['Content-Type', 'X-CSRF-Token', 'X-Requested-With'],
        methods=['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    )

    # ── Blueprints ─────────────────────────────────────────────────────────────
    app.register_blueprint(crypto_bp)    # /encrypt, /decrypt  (session-key API)
    app.register_blueprint(session_bp)   # /new-session, /session-info, etc.

    # ── Security headers + error handlers ──────────────────────────────────────
    app.after_request(add_security_headers)
    register_error_handlers(app)

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
        resp  = jsonify({'csrf_token': token})
        https = _is_https()
        resp.set_cookie(
            CSRF_COOKIE,
            token,
            httponly=False,                         # JS must read it
            samesite='None' if https else 'Lax',
            secure=https,
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
        resp.set_cookie(
            CSRF_COOKIE, token,
            httponly=False,
            samesite='None' if https else 'Lax',
            secure=https,
            max_age=3600, path='/',
        )
        return resp

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
                log.info(f'Password reset requested for: {email}')
                # TODO: send email with reset link containing token
                # e.g. send_reset_email(user.email, token,
                #          f"https://ghostchat-5slo.onrender.com/forgot-password.html?token={token}")

            # Always return the same response — prevents user enumeration
            return jsonify({
                'success': True,
                'message': 'If that email is registered, a reset link has been sent.',
            }), 200

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

            from ghostchat import GhostChat, GhostChatError
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

            from ghostchat import GhostChat
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

    # Serve frontend HTML pages
    SAFE_EXTENSIONS = (
        '.html', '.css', '.js', '.png', '.jpg', '.jpeg',
        '.gif', '.svg', '.ico', '.json', '.woff', '.woff2',
        '.ttf', '.webp', '.txt', '.map',
    )
    frontend_dir = os.path.join(os.path.dirname(__file__), '..', 'frontend')

    @app.route('/')
    def index():
        return send_from_directory(frontend_dir, 'index.html')

    @app.route('/<path:filename>')
    def serve_static(filename):
        if any(filename.lower().endswith(ext) for ext in SAFE_EXTENSIONS):
            return send_from_directory(frontend_dir, filename)
        return jsonify({'error': 'Not Found'}), 404

    log.info(f'GhostChat ready  [{"production" if IS_PROD else "development"}]')
    return app


# ── Entry point ────────────────────────────────────────────────────────────────
app = create_app()

if __name__ == '__main__':
    app.run(
        host  = '0.0.0.0',
        port  = int(os.environ.get('PORT', 5000)),
        debug = os.environ.get('FLASK_DEBUG', '0') == '1',
    )