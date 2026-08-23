"""
GhostChat :: backend/flask_app.py
==================================
Flask serves BOTH the frontend (../frontend/) and the API.

Run locally:
    cd backend
    python flask_app.py

Deployed on Railway:
    - Set env var FLASK_SECRET to a long random string (REQUIRED in production —
      see the startup check below; the app will refuse to boot without it).
    - Set env var RAILWAY=true (Railway sets this automatically)
    - Optionally set REDIS_URL for rate-limit storage shared across workers.
    - The app auto-detects HTTPS and sets cookies correctly.
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
import re
import json
import logging
import mimetypes
import secrets
import smtplib
import ssl
import uuid
from datetime import datetime, timedelta
from email.message import EmailMessage

from flask import (
    Flask, jsonify, request, session,
    send_from_directory, Response
)
from flask_cors import CORS
# flask_session removed — using Flask built-in signed cookie sessions
from flask_socketio import SocketIO, emit, join_room, leave_room

# ── Local packages (run from inside backend/) ─────────────────────────────────
from backend.api import crypto_bp, session_bp
from backend.api.errors import register_error_handlers
from backend.api.middleware import add_security_headers
from backend.api.rate_limit import (
    limiter, LOGIN_LIMIT, REGISTER_LIMIT, VERIFY_EMAIL_LIMIT,
    RESEND_VERIFY_LIMIT, FORGOT_PASSWORD_LIMIT, RESET_PASSWORD_LIMIT,
    DECRYPT_LIMIT, ENCRYPT_LIMIT, TWO_FA_VERIFY_LIMIT, ADMIN_MUTATION_LIMIT,
)
from backend.api.two_factor import issue_otp, verify_otp, otp_email_body

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
        ActivityLog,
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
        or bool(os.environ.get('RAILWAY'))
    )


def create_app(test_config=None):
    global sid_to_user
    sid_to_user = {}

    # FIX: this file's location relative to frontend/ has been a recurring
    # source of bugs — a previous version assumed frontend/ was nested inside
    # backend/, a later "fix" assumed the opposite. Neither assumption is safe
    # to hardcode, since it depends entirely on incidental deploy-layout details
    # (e.g. whether this file is copied to the repo root at build time, or left
    # nested under backend/). Rather than guess a third time, this checks both
    # real candidate locations and uses whichever one actually exists on disk,
    # logging clearly if neither does — self-healing regardless of deploy
    # layout, and fails loudly instead of silently serving nothing if the
    # layout changes again in the future.
    _basedir = os.path.abspath(os.path.dirname(__file__))
    _frontend_candidates = [
        os.path.join(_basedir, 'frontend'),        # flask_app.py at repo root, frontend/ is a direct sibling
        os.path.join(_basedir, '..', 'frontend'),  # flask_app.py nested one level down, frontend/ is one level up
    ]
    _frontend = next(
        (os.path.abspath(p) for p in _frontend_candidates if os.path.isdir(p)),
        os.path.abspath(_frontend_candidates[0]),
    )
    if not os.path.isdir(_frontend):
        log.error(
            f"Could not locate the frontend/ directory. Checked: "
            f"{[os.path.abspath(p) for p in _frontend_candidates]}. "
            f"Static files (HTML/CSS/JS) will fail to serve until this is fixed."
        )

    app = Flask(
        __name__,
        static_folder=_frontend,
        static_url_path='',
    )

    # ── Detect environment ─────────────────────────────────────────────────────
    IS_PROD = bool(
        os.environ.get('RENDER')
        or os.environ.get('RAILWAY')
        or os.environ.get('FLASK_ENV') == 'production'
    )

    # ── FIX: SECRET_KEY correctness/security fix ─────────────────────────────
    # Previously this defaulted to secrets.token_hex(32) generated fresh at
    # import time. On a multi-worker gunicorn deployment (Railway's default),
    # every worker process gets a DIFFERENT random key, so a signed session
    # cookie minted by worker A is rejected as invalid by worker B — causing
    # random, intermittent "logged out" behavior with no error. It also means
    # every redeploy silently invalidates every active session. In production
    # we now require FLASK_SECRET to be set explicitly and refuse to boot
    # without it, rather than silently degrading. In development, a random
    # key each run is fine (and expected) since there's only one process.
    _secret_key = os.environ.get('FLASK_SECRET')
    if not _secret_key:
        if IS_PROD:
            raise RuntimeError(
                'FATAL: FLASK_SECRET environment variable is not set. '
                'A missing SECRET_KEY in production causes silent session '
                'invalidation across workers/restarts and is a security risk. '
                'Set FLASK_SECRET to a long random string (e.g. '
                '`python -c "import secrets; print(secrets.token_hex(32))"`) '
                'in your Railway environment variables and redeploy.'
            )
        _secret_key = secrets.token_hex(32)
        log.warning('FLASK_SECRET not set — using an ephemeral development key. '
                     'Sessions will not survive a restart. Do not run production like this.')

    # ── Core config ────────────────────────────────────────────────────────────
    app.config.update(
        SECRET_KEY                  = _secret_key,
        DEBUG                       = not IS_PROD and os.environ.get('FLASK_DEBUG', '0') == '1',
        JSON_SORT_KEYS              = False,
        TESTING                     = False,
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
    app.config['MAX_CONTENT_LENGTH'] = 45 * 1024 * 1024

    # Reuse the same self-healed frontend/ location resolved above, instead of
    # guessing a second, independent path here (this is exactly what caused
    # the earlier inconsistency — two different hardcoded guesses for the same
    # directory, in the same file, that could each be wrong independently).
    upload_folder = os.path.join(_frontend, 'assets', 'uploads')
    os.makedirs(upload_folder, exist_ok=True)
    app.config['UPLOAD_FOLDER'] = upload_folder

    if test_config:
        app.config.update(test_config)

    # ── Rate limiter ───────────────────────────────────────────────────────────
    limiter.init_app(app)

    # ── Extensions ─────────────────────────────────────────────────────────────
    if DB_AVAILABLE:
        db.init_app(app)
        bcrypt.init_app(app)
        with app.app_context():
            db.create_all()
            log.info('Database ready')

            def _migrate_columns(model, cols: dict):
                """cols: {column_name: sql_type_ddl}. Adds any missing columns."""
                try:
                    from sqlalchemy import inspect, text
                    inspector = inspect(db.engine)
                    table = model.__tablename__
                    existing = [c['name'] for c in inspector.get_columns(table)]
                    for col, ddl in cols.items():
                        if col not in existing:
                            db.session.execute(text(f"ALTER TABLE {table} ADD COLUMN {col} {ddl}"))
                            log.info(f"Migrated: added '{col}' column to {table}")
                    db.session.commit()
                except Exception as e:
                    log.error(f'Migration check failed for {model.__tablename__}: {e}')
                    db.session.rollback()

            _migrate_columns(Message, {'media_data': 'BLOB', 'media_type': 'VARCHAR(100)'})
            _migrate_columns(User, {
                'is_admin': 'BOOLEAN DEFAULT 0',
                'verification_code': 'VARCHAR(10)',
                'verification_code_expires': 'DATETIME',
            })
            _migrate_columns(User, {
                'last_ip': 'VARCHAR(45)', 'last_location': 'VARCHAR(200)', 'last_device': 'VARCHAR(200)',
            })
            _migrate_columns(ActivityLog, {'location': 'VARCHAR(200)', 'device': 'VARCHAR(200)'})
            _migrate_columns(Message, {'deleted_at': 'DATETIME', 'deleted_by': 'VARCHAR(36)'})
            # ── 2FA columns ──
            _migrate_columns(User, {
                'two_factor_code': 'VARCHAR(10)',
                'two_factor_code_expires': 'DATETIME',
                'two_factor_attempts': 'INTEGER DEFAULT 0',
            })

            try:
                admin_emails = [e.strip().lower() for e in os.environ.get('ADMIN_EMAILS', '').split(',') if e.strip()]
                if admin_emails:
                    promoted = User.query.filter(db.func.lower(User.email).in_(admin_emails), User.is_admin == False).all()
                    for u in promoted:
                        u.is_admin = True
                    if promoted:
                        db.session.commit()
                        log.info(f"Promoted {len(promoted)} account(s) to admin via ADMIN_EMAILS")
            except Exception as e:
                log.error(f'Admin bootstrap failed: {e}')
                db.session.rollback()

    # ── CORS ───────────────────────────────────────────────────────────────────
    allowed_origins = [
        'http://localhost:5000',
        'http://127.0.0.1:5000',
        'https://ghostchat-5slo.onrender.com',
        'https://ghostchat-production-6c0b.up.railway.app',
        'null',
    ]
    render_url = os.environ.get('RENDER_EXTERNAL_URL', '').rstrip('/')
    if render_url and render_url not in allowed_origins:
        allowed_origins.append(render_url)

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
    app.register_blueprint(crypto_bp)
    app.register_blueprint(session_bp)

    # ── Security headers + error handlers ──────────────────────────────────────
    app.after_request(add_security_headers)
    register_error_handlers(app)

    @app.errorhandler(429)
    def rate_limit_exceeded(e):
        return jsonify({
            'error': 'Too Many Requests',
            'message': 'Too many attempts. Please wait before trying again.',
            'code': 429,
        }), 429

    # ── SocketIO ──────────────────────────────────────────────────────────────
    global socketio
    try:
        socketio = SocketIO(
            app,
            cors_allowed_origins=allowed_origins,
            async_mode='eventlet',
            manage_session=False,
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
            manage_session=False,
            logger=False,
            engineio_logger=False,
        )
        log.warning('SocketIO using threading mode')

    # ═══════════════════════════════════════════════════════════════════════════
    # CSRF — Double-Submit Cookie Pattern
    # ═══════════════════════════════════════════════════════════════════════════

    CSRF_COOKIE = 'gc_csrf'

    @app.route('/api/csrf-token', methods=['GET', 'OPTIONS'])
    def csrf_token():
        if request.method == 'OPTIONS':
            return '', 200
        token = request.cookies.get(CSRF_COOKIE) or secrets.token_hex(32)
        resp = jsonify({'csrf_token': token})
        https = _is_https()
        is_railway = bool(os.environ.get('RAILWAY'))
        secure_cookie = https or is_railway

        resp.set_cookie(
            CSRF_COOKIE,
            token,
            httponly=False,
            samesite='None' if secure_cookie else 'Lax',
            secure=secure_cookie,
            max_age=3600,
            path='/',
        )
        return resp, 200

    def _check_csrf():
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
        # ── 2FA gate: a session that has passed password check but not yet
        # the second factor is only allowed to hit the 2FA verify/resend
        # routes — everything else must be blocked until fully authenticated. ──
        if session.get('pending_2fa'):
            return None, (jsonify({'error': 'Two-factor verification required', 'requires_2fa': True}), 401)
        user = User.query.get(uid)
        if not user:
            session.clear()
            return None, (jsonify({'error': 'User not found'}), 401)
        return user, None

    def _require_admin():
        user, err = _require_auth()
        if err: return None, err
        if not user.is_admin:
            return None, (jsonify({'error': 'Admin access required'}), 403)
        return user, None

    _geoip_cache = {}

    def _geolocate_ip(ip: str) -> str:
        if not ip or ip in ('127.0.0.1', 'localhost', '::1'):
            return 'Local'
        if ip in _geoip_cache:
            return _geoip_cache[ip]
        try:
            import urllib.request
            with urllib.request.urlopen(f'https://ipapi.co/{ip}/json/', timeout=4) as resp:
                data = json.loads(resp.read().decode('utf-8'))
            city = data.get('city') or ''
            country = data.get('country_name') or ''
            location = ', '.join(p for p in (city, country) if p) or 'Unknown'
        except Exception:
            location = 'Unknown'
        _geoip_cache[ip] = location
        return location

    def _parse_device(user_agent: str) -> str:
        if not user_agent:
            return 'Unknown device'
        ua = user_agent

        if 'iPhone' in ua: os_name = 'iPhone'
        elif 'iPad' in ua: os_name = 'iPad'
        elif 'Android' in ua: os_name = 'Android'
        elif 'Windows' in ua: os_name = 'Windows'
        elif 'Mac OS X' in ua: os_name = 'macOS'
        elif 'Linux' in ua: os_name = 'Linux'
        else: os_name = 'Unknown OS'

        if 'Edg/' in ua: browser = 'Edge'
        elif 'OPR/' in ua or 'Opera' in ua: browser = 'Opera'
        elif 'Chrome/' in ua and 'Chromium' not in ua: browser = 'Chrome'
        elif 'Firefox/' in ua: browser = 'Firefox'
        elif 'Safari/' in ua and 'Chrome/' not in ua: browser = 'Safari'
        else: browser = 'Unknown browser'

        return f'{browser} on {os_name}'

    def _client_ip() -> str:
        return request.headers.get('X-Forwarded-For', request.remote_addr or '').split(',')[0].strip()

    def _log_activity(user_id, event_type, description=''):
        if not DB_AVAILABLE: return
        try:
            ip = _client_ip()
            db.session.add(ActivityLog(
                user_id=user_id, event_type=event_type, description=description,
                ip_address=ip,
                location=_geolocate_ip(ip),
                device=_parse_device(request.headers.get('User-Agent', '')),
            ))
            db.session.commit()
        except Exception as e:
            log.error(f'Activity log write failed ({event_type}): {e}')
            db.session.rollback()

    def _rotate_csrf_cookie(resp):
        token = secrets.token_hex(32)
        https = _is_https()
        is_railway = bool(os.environ.get('RAILWAY'))
        secure_cookie = https or is_railway

        resp.set_cookie(
            CSRF_COOKIE, token,
            httponly=False,
            samesite='None' if secure_cookie else 'Lax',
            secure=secure_cookie,
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
        log_dir = os.path.join(os.path.dirname(__file__), '..', 'logs')
        os.makedirs(log_dir, exist_ok=True)
        fallback_path = os.path.join(log_dir, 'reset_links.log')

        def write_debug_link():
            try:
                with open(fallback_path, 'a', encoding='utf-8') as f:
                    f.write(f"{datetime.utcnow().isoformat()} | {recipient} | {text_body}\n")
            except Exception:
                pass

        sendgrid_api_key = os.environ.get('SENDGRID_API_KEY')
        if sendgrid_api_key:
            mail_from = os.environ.get('MAIL_FROM')
            if not mail_from:
                log.error('SENDGRID_API_KEY is set but MAIL_FROM is missing.')
            else:
                try:
                    import urllib.request
                    body = json.dumps({
                        'personalizations': [{'to': [{'email': recipient}]}],
                        'from': {'email': mail_from},
                        'subject': subject,
                        'content': [
                            {'type': 'text/plain', 'value': text_body},
                            {'type': 'text/html', 'value': html_body},
                        ],
                    }).encode('utf-8')
                    req = urllib.request.Request(
                        'https://api.sendgrid.com/v3/mail/send',
                        data=body, method='POST',
                        headers={'Authorization': f'Bearer {sendgrid_api_key}', 'Content-Type': 'application/json'},
                    )
                    with urllib.request.urlopen(req, timeout=10) as resp:
                        if resp.status == 202:
                            log.info('Email sent via SendGrid to %s', recipient)
                            return True
                        log.error('SendGrid API returned status %s for %s', resp.status, recipient)
                except Exception as exc:
                    log.error('Failed to send email via SendGrid to %s: %s', recipient, exc)

        resend_api_key = os.environ.get('RESEND_API_KEY')
        if resend_api_key:
            mail_from = os.environ.get('MAIL_FROM', 'onboarding@resend.dev')
            try:
                import urllib.request
                body = json.dumps({
                    'from': mail_from, 'to': [recipient], 'subject': subject,
                    'html': html_body, 'text': text_body,
                }).encode('utf-8')
                req = urllib.request.Request(
                    'https://api.resend.com/emails',
                    data=body, method='POST',
                    headers={'Authorization': f'Bearer {resend_api_key}', 'Content-Type': 'application/json'},
                )
                with urllib.request.urlopen(req, timeout=10) as resp:
                    if 200 <= resp.status < 300:
                        log.info('Email sent via Resend to %s', recipient)
                        return True
                    log.error('Resend API returned status %s for %s', resp.status, recipient)
            except Exception as exc:
                log.error('Failed to send email via Resend to %s: %s', recipient, exc)

        smtp_host = os.environ.get('SMTP_HOST')
        smtp_port = int(os.environ.get('SMTP_PORT', '587'))
        smtp_user = os.environ.get('SMTP_USER')
        smtp_password = os.environ.get('SMTP_PASSWORD')
        smtp_use_ssl = os.environ.get('SMTP_USE_SSL', '0').lower() in ('1', 'true', 'yes')
        smtp_use_tls = os.environ.get('SMTP_USE_TLS', '1').lower() in ('1', 'true', 'yes')
        mail_from = os.environ.get('MAIL_FROM', f'no-reply@{request.host.split(":")[0]}')

        if not smtp_host or not smtp_user or not smtp_password:
            log.warning('No RESEND_API_KEY and no SMTP settings; email not sent.')
            log.info('Email body (fallback log): %s', text_body)
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
            log.error('Failed to send email to %s: %s', recipient, exc)
            log.info('Email body (fallback log): %s', text_body)
            write_debug_link()
            return False

    # ═══════════════════════════════════════════════════════════════════════════
    # AUTHENTICATION ROUTES
    # ═══════════════════════════════════════════════════════════════════════════

    @app.route('/api/auth/register', methods=['POST', 'OPTIONS'])
    @limiter.limit(REGISTER_LIMIT)
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
            if not re.match(r'^[^\s@]+@[^\s@]+\.[^\s@]+$', email):
                return jsonify({'error': 'Please enter a valid email address'}), 400
            if len(password) < 8:
                return jsonify({'error': 'Password must be at least 8 characters'}), 400
            if User.query.filter_by(username=username).first():
                return jsonify({'error': 'Username already taken'}), 400
            if User.query.filter_by(email=email).first():
                return jsonify({'error': 'Email already registered'}), 400

            user = User(username=username, email=email, is_verified=False)
            admin_emails = [e.strip().lower() for e in os.environ.get('ADMIN_EMAILS', '').split(',') if e.strip()]
            if email.lower() in admin_emails:
                user.is_admin = True
            user.set_password(password)
            code_str = f'{secrets.randbelow(1000000):06d}'
            user.verification_code = code_str
            user.verification_code_expires = datetime.utcnow() + timedelta(minutes=15)
            db.session.add(user)
            db.session.commit()

            _log_activity(user.id, 'register', f'New account: {username}')
            log.info(f'User registered (pending verification): {username}')

            sent = _send_email(
                subject='Verify your GhostChat account',
                recipient=email,
                html_body=f'''
                    <p>Welcome to GhostChat, {username}!</p>
                    <p>Your verification code is:</p>
                    <h2 style="letter-spacing:4px;">{code_str}</h2>
                    <p>Enter this code to activate your account. It expires in 15 minutes.</p>
                ''',
                text_body=f'Your GhostChat verification code is: {code_str}\nIt expires in 15 minutes.',
            )
            if not sent:
                log.info(f'Verification code for {email}: {code_str}')

            return jsonify({
                'success': True,
                'requires_verification': True,
                'email': email,
                'message': 'Account created. Check your email for a verification code.',
            }), 201

        except Exception as exc:
            db.session.rollback() if DB_AVAILABLE else None
            log.error(f'Register error: {exc}')
            return jsonify({'error': 'Registration failed. Please try again.'}), 500

    @app.route('/api/auth/verify-email', methods=['POST', 'OPTIONS'])
    @limiter.limit(VERIFY_EMAIL_LIMIT)
    def verify_email():
        if request.method == 'OPTIONS':
            return '', 200
        if not DB_AVAILABLE:
            return jsonify({'error': 'Database not available'}), 500

        data  = request.get_json() or {}
        email = (data.get('email') or '').strip()
        code  = (data.get('code') or '').strip()
        if not email or not code:
            return jsonify({'error': 'Email and code are required'}), 400

        user = User.query.filter_by(email=email).first()
        if not user or not user.verification_code:
            return jsonify({'error': 'Invalid or expired verification code'}), 400
        if not secrets.compare_digest(user.verification_code, code):
            return jsonify({'error': 'Incorrect verification code'}), 400
        if not user.verification_code_expires or datetime.utcnow() > user.verification_code_expires:
            return jsonify({'error': 'Verification code has expired. Request a new one.'}), 400

        user.is_verified = True
        user.verification_code = None
        user.verification_code_expires = None
        user.last_login = datetime.utcnow()
        db.session.commit()

        session['user_id']       = user.id
        session['authenticated'] = True
        _log_activity(user.id, 'email_verified', f'{user.username} verified their email')
        log.info(f'Email verified: {user.username}')

        resp = jsonify({'success': True, 'user': user.to_dict()})
        return _rotate_csrf_cookie(resp), 200

    @app.route('/api/auth/resend-verification', methods=['POST', 'OPTIONS'])
    @limiter.limit(RESEND_VERIFY_LIMIT)
    def resend_verification():
        if request.method == 'OPTIONS':
            return '', 200
        if not DB_AVAILABLE:
            return jsonify({'error': 'Database not available'}), 500

        data  = request.get_json() or {}
        email = (data.get('email') or '').strip()
        if not email:
            return jsonify({'error': 'Email is required'}), 400

        user = User.query.filter_by(email=email).first()
        if user and not user.is_verified:
            code_str = f'{secrets.randbelow(1000000):06d}'
            user.verification_code = code_str
            user.verification_code_expires = datetime.utcnow() + timedelta(minutes=15)
            db.session.commit()
            sent = _send_email(
                subject='Your new GhostChat verification code',
                recipient=email,
                html_body=f'<p>Your new verification code is:</p><h2 style="letter-spacing:4px;">{code_str}</h2><p>Expires in 15 minutes.</p>',
                text_body=f'Your new GhostChat verification code is: {code_str}\nExpires in 15 minutes.',
            )
            if not sent:
                log.info(f'Verification code for {email}: {code_str}')

        return jsonify({'success': True, 'message': 'If that email needs verification, a new code has been sent.'}), 200

    @app.route('/api/auth/login', methods=['POST', 'OPTIONS'])
    @limiter.limit(LOGIN_LIMIT)
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

            user = (
                User.query.filter_by(username=username).first()
                or User.query.filter_by(email=username).first()
            )

            if not user or not user.check_password(password):
                log.warning(f'Failed login for: {username[:30]}')
                _log_activity(user.id if user else None, 'login_failed',
                              f'Failed login attempt for "{username[:30]}"')
                return jsonify({'error': 'Invalid credentials'}), 401

            if not user.is_active:
                return jsonify({'error': 'Account is disabled'}), 401

            if not user.is_verified:
                return jsonify({
                    'error': 'Please verify your email before signing in.',
                    'requires_verification': True,
                    'email': user.email,
                }), 403

            # ── 2FA gate ──
            # Password check passed. If 2FA is enabled, do NOT fully log the
            # user in yet — issue an OTP, mark the session as pending-2FA
            # (which _require_auth blocks on), and tell the client to prompt
            # for the code. Only /api/auth/2fa/verify can lift pending_2fa.
            if user.two_factor_enabled:
                code_str = issue_otp(user, db)
                db.session.commit()
                session.clear()
                session['pending_2fa_user_id'] = user.id
                session['pending_2fa'] = True

                html, text = otp_email_body(user.username, code_str)
                sent = _send_email(subject='Your GhostChat sign-in code', recipient=user.email,
                                    html_body=html, text_body=text)
                if not sent:
                    log.info(f'2FA code for {user.email}: {code_str}')

                resp = jsonify({
                    'success': True,
                    'requires_2fa': True,
                    'message': 'Enter the verification code sent to your email.',
                })
                return _rotate_csrf_cookie(resp), 200

            ip = _client_ip()
            user.last_login = datetime.utcnow()
            user.last_ip = ip
            user.last_location = _geolocate_ip(ip)
            user.last_device = _parse_device(request.headers.get('User-Agent', ''))
            db.session.commit()

            session['user_id']       = user.id
            session['authenticated'] = True
            _log_activity(user.id, 'login', f'{user.username} logged in')
            log.info(f'User logged in: {user.username}')

            resp = jsonify({'success': True, 'user': user.to_dict()})
            return _rotate_csrf_cookie(resp), 200

        except Exception as exc:
            log.error(f'Login error: {exc}')
            return jsonify({'error': 'Login failed. Please try again.'}), 500

    @app.route('/api/auth/2fa/verify', methods=['POST', 'OPTIONS'])
    @limiter.limit(TWO_FA_VERIFY_LIMIT)
    def verify_2fa():
        if request.method == 'OPTIONS':
            return '', 200
        err, code = _check_csrf()
        if err:
            return err, code
        if not DB_AVAILABLE:
            return jsonify({'error': 'Database not available'}), 500

        uid = session.get('pending_2fa_user_id')
        if not uid or not session.get('pending_2fa'):
            return jsonify({'error': 'No pending two-factor verification'}), 400

        user = User.query.get(uid)
        if not user:
            session.clear()
            return jsonify({'error': 'User not found'}), 401

        submitted = ((request.get_json() or {}).get('code') or '').strip()
        ok, msg = verify_otp(user, submitted)
        db.session.commit()

        if not ok:
            return jsonify({'error': msg}), 400

        ip = _client_ip()
        user.last_login = datetime.utcnow()
        user.last_ip = ip
        user.last_location = _geolocate_ip(ip)
        user.last_device = _parse_device(request.headers.get('User-Agent', ''))
        db.session.commit()

        session.clear()
        session['user_id'] = user.id
        session['authenticated'] = True
        _log_activity(user.id, 'login', f'{user.username} logged in (2FA verified)')
        log.info(f'2FA verified, user logged in: {user.username}')

        resp = jsonify({'success': True, 'user': user.to_dict()})
        return _rotate_csrf_cookie(resp), 200

    @app.route('/api/auth/2fa/resend', methods=['POST', 'OPTIONS'])
    @limiter.limit(RESEND_VERIFY_LIMIT)
    def resend_2fa():
        if request.method == 'OPTIONS':
            return '', 200
        if not DB_AVAILABLE:
            return jsonify({'error': 'Database not available'}), 500

        uid = session.get('pending_2fa_user_id')
        if not uid or not session.get('pending_2fa'):
            return jsonify({'error': 'No pending two-factor verification'}), 400

        user = User.query.get(uid)
        if not user:
            session.clear()
            return jsonify({'error': 'User not found'}), 401

        code_str = issue_otp(user, db)
        db.session.commit()
        html, text = otp_email_body(user.username, code_str)
        sent = _send_email(subject='Your GhostChat sign-in code', recipient=user.email,
                            html_body=html, text_body=text)
        if not sent:
            log.info(f'2FA code for {user.email}: {code_str}')

        return jsonify({'success': True, 'message': 'A new code has been sent.'}), 200

    @app.route('/api/auth/logout', methods=['POST', 'OPTIONS'])
    def logout():
        if request.method == 'OPTIONS':
            return '', 200
        uid = session.get('user_id')
        if uid:
            _log_activity(uid, 'logout', 'User logged out')
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
    @limiter.limit(FORGOT_PASSWORD_LIMIT)
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
            sent = False
            if user:
                token = user.generate_reset_token()
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

                sent = _send_email(subject='GhostChat Password Reset', recipient=user.email,
                                    html_body=html, text_body=plaintext)
                if sent:
                    log.info(f'Password reset email sent to: {email}')
                else:
                    log.warning(f'Password reset email failed for: {email}; link logged in server output.')
                _log_activity(user.id, 'password_reset_requested', f'Reset requested for {email}')

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
    @limiter.limit(RESET_PASSWORD_LIMIT)
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
            _log_activity(user.id, 'password_reset_completed', f'{user.username} completed password reset')
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

        # ── 2FA toggle — turning it ON here doesn't require re-verification
        # (the user is already authenticated in this session); turning it OFF
        # is also allowed here. The next LOGIN is what actually enforces it. ──
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
        session.clear()
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

        # ── FIX: extension whitelist alone is not enough — a .png that is
        # actually an HTML/SVG polyglot can still be served back with a
        # browser-sniffed content type in some misconfigured setups. Verify
        # actual image content via Pillow's header parse, not just the
        # filename, before accepting the upload. ──
        file.seek(0, 2)
        size = file.tell()
        file.seek(0)
        if size > 2 * 1024 * 1024:
            return jsonify({'error': 'File too large — maximum 2 MB'}), 400

        try:
            from PIL import Image
            img = Image.open(file)
            img.verify()
            file.seek(0)
        except Exception:
            return jsonify({'error': 'File is not a valid image'}), 400

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
    @limiter.limit(ENCRYPT_LIMIT)
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
            if len(message) > 20000:
                return jsonify({'success': False, 'error': 'Message too long (max 20,000 characters)'}), 400

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
    @limiter.limit(DECRYPT_LIMIT)
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

        # FIX: this had no message_type filter at all, so it returned every
        # message row for the user — chat messages, images, audio, video —
        # not just the encryption/decryption history entries this page is
        # actually for. That meant real chat content could show up
        # mislabeled in the dashboard's History list, and it's inconsistent
        # with /api/messages/clear below, which correctly only ever
        # touches encryption/decryption rows. Scoping this the same way.
        _history_types = ['encryption', 'decryption']
        msgs  = (Message.query
                 .filter_by(user_id=user.id)
                 .filter(Message.message_type.in_(_history_types))
                 .order_by(Message.created_at.desc())
                 .limit(limit).offset(offset).all())
        total = Message.query.filter_by(user_id=user.id).filter(
            Message.message_type.in_(_history_types)
        ).count()

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

    @app.route('/api/messages/clear', methods=['POST', 'OPTIONS'])
    def clear_encryption_history():
        """Bulk-clear the dashboard's local encryption/decryption history log
        (distinct from chat messages) — owner-only hard delete."""
        if request.method == 'OPTIONS':
            return '', 200
        if not DB_AVAILABLE:
            return jsonify({'success': True, 'deleted': 0}), 200

        user, err = _require_auth()
        if err:
            return err

        count = Message.query.filter_by(user_id=user.id).filter(
            Message.message_type.in_(['encryption', 'decryption'])
        ).delete(synchronize_session=False)
        db.session.commit()
        _log_activity(user.id, 'message_deleted', f'{user.username} cleared {count} history entries')
        return jsonify({'success': True, 'deleted': count}), 200

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
            'version':     '3.1.0',
        }), 200

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

    # ══════════════════════════════════════
    # CONTACT ROUTES
    # ══════════════════════════════════════

    @app.route('/api/contacts', methods=['GET','OPTIONS'])
    def get_contacts():
        if request.method == 'OPTIONS': return '', 200
        user, err = _require_auth()
        if err: return err
        contacts = Contact.query.filter_by(user_id=user.id, is_blocked=False).all()
        _chat_types = ['chat', 'image', 'audio', 'video']
        result = []
        for c in contacts:
            cu = User.query.get(c.contact_id)
            if not cu: continue
            last_msg = Message.query.filter(
                Message.is_deleted == False, Message.message_type.in_(_chat_types),
                db.or_(
                    db.and_(Message.sender_id==user.id, Message.receiver_id==c.contact_id),
                    db.and_(Message.sender_id==c.contact_id, Message.receiver_id==user.id),
                )
            ).order_by(Message.created_at.desc()).first()
            unread = Message.query.filter_by(
                sender_id=c.contact_id, receiver_id=user.id, is_read=False
            ).filter(Message.message_type.in_(_chat_types)).count()
            result.append({
                'id': c.id, 'contact_id': cu.id, 'username': cu.username,
                'display_name': c.display_name or cu.username,
                'avatar': cu.avatar, 'about': cu.about,
                'is_online': cu.is_online,
                'last_seen': cu.last_seen.isoformat() if cu.last_seen else None,
                'is_favorite': c.is_favorite, 'unread_count': unread,
                'last_message': {
                    'content': (
                        {'image': '📷 Photo', 'audio': '🎤 Voice note', 'video': '🎥 Video'}.get(last_msg.message_type)
                        or last_msg.encrypted_content
                    ),
                    'created_at': last_msg.created_at.isoformat(),
                    'is_mine': last_msg.sender_id == user.id,
                } if last_msg else None,
            })
        result.sort(key=lambda x: (not x['is_favorite'], x['last_message']['created_at'] if x['last_message'] else ''))
        return jsonify({'success': True, 'contacts': result}), 200

    @app.route('/api/contacts/search', methods=['GET','OPTIONS'])
    @limiter.limit("60 per minute")
    def search_users():
        if request.method == 'OPTIONS': return '', 200
        user, err = _require_auth()
        if err: return err
        q = (request.args.get('q') or '').strip()
        if len(q) < 1: return jsonify({'success': True, 'users': []}), 200
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
        try:
            return len(list(socketio.server.manager.get_participants('/', room)))
        except Exception as e:
            return f'unknown ({e})'

    def _accept_contact_request(user, requester_id, req_row=None):
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

        _log_activity(user.id, 'contact_request_accepted',
                      f'{user.username} accepted request from {requester.username if requester else requester_id}')
        _log_activity(requester_id, 'contact_request_accepted',
                      f'{requester.username if requester else requester_id} was accepted by {user.username}')

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

        incoming = ContactRequest.query.filter_by(
            sender_id=contact_id, recipient_id=user.id, status='pending').first()
        if incoming:
            return _accept_contact_request(user, contact_id, req_row=incoming)

        existing = ContactRequest.query.filter_by(sender_id=user.id, recipient_id=contact_id).first()
        if existing:
            if existing.status == 'pending':
                return jsonify({'error': 'Request already sent'}), 400
            existing.status = 'pending'
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

        _log_activity(user.id, 'contact_request_sent', f'{user.username} sent a request to {cu.username}')

        return jsonify({'success': True, 'message': f'Request sent to {cu.username}',
                         'contact_id': contact_id, 'username': cu.username,
                         'avatar': cu.avatar, 'status': 'pending_sent'}), 201

    @app.route('/api/contacts/requests', methods=['GET','OPTIONS'])
    def list_contact_requests():
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
        _log_activity(user.id, 'contact_request_rejected', f'{user.username} declined a request from {contact_id}')
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
        _chat_types = ['chat', 'image', 'audio', 'video']
        query  = Message.query.filter(
            Message.is_deleted == False, Message.message_type.in_(_chat_types),
            db.or_(
                db.and_(Message.sender_id==user.id, Message.receiver_id==contact_id),
                db.and_(Message.sender_id==contact_id, Message.receiver_id==user.id),
            )
        )
        if before: query = query.filter(Message.created_at < before)
        messages = query.order_by(Message.created_at.desc()).limit(limit).all()
        messages.reverse()
        def _not_deleted_for_me(m):
            try:
                return user.id not in (json.loads(m.deleted_for) if m.deleted_for else [])
            except Exception:
                return True
        messages = [m for m in messages if _not_deleted_for_me(m)]
        unread_msgs = Message.query.filter_by(sender_id=contact_id, receiver_id=user.id, is_read=False) \
            .filter(Message.message_type.in_(_chat_types)).all()
        for m in unread_msgs:
            m.is_read = True
            m.read_at = datetime.utcnow()
        if unread_msgs:
            db.session.commit()
            sender = User.query.get(contact_id)
            sender_name = sender.username if sender else contact_id
            _log_activity(user.id, 'message_received', f'{len(unread_msgs)} message(s) received from {sender_name}')
        return jsonify({'success': True, 'messages': [m.to_dict() for m in messages]}), 200

    @app.route('/api/chat/<contact_id>/messages', methods=['POST','OPTIONS'])
    def send_chat_message(contact_id):
        if request.method == 'OPTIONS': return '', 200
        user, err = _require_auth()
        if err: return err
        data    = request.get_json() or {}
        content = (data.get('content') or '').strip()
        if not content: return jsonify({'error': 'content required'}), 400
        if len(content) > 20000:
            return jsonify({'error': 'Message too long'}), 400
        msg = Message(user_id=user.id, sender_id=user.id, receiver_id=contact_id,
                      encrypted_content=content, message_type='chat')
        db.session.add(msg)
        db.session.commit()
        _log_activity(user.id, 'message_sent', 'text message')
        payload = {'id': msg.id, 'content': content, 'sender_id': user.id,
                   'sender': user.username, 'avatar': user.avatar,
                   'receiver_id': contact_id, 'created_at': msg.created_at.isoformat()}
        if socketio:
            socketio.emit('receive_message', payload, room=f'user_{contact_id}')
            socketio.emit('receive_message', payload, room=f'user_{user.id}')
        return jsonify({'success': True, 'message': msg.to_dict()}), 201

    # ── Media messages (images, voice notes, video) — stored as DB blobs ────
    _ALLOWED_MEDIA_MIMES = {
        'image': {'image/jpeg', 'image/png', 'image/gif', 'image/webp'},
        'audio': {'audio/webm', 'audio/ogg', 'audio/mpeg', 'audio/wav', 'audio/mp4', 'audio/x-m4a'},
        'video': {'video/mp4', 'video/webm', 'video/quicktime'},
    }
    _MAX_MEDIA_BYTES = {
        'image': 8 * 1024 * 1024,
        'audio': 15 * 1024 * 1024,
        'video': 40 * 1024 * 1024,
    }

    @app.route('/api/chat/<contact_id>/media', methods=['POST', 'OPTIONS'])
    def send_media_message(contact_id):
        if request.method == 'OPTIONS': return '', 200
        user, err = _require_auth()
        if err: return err
        if not DB_AVAILABLE:
            return jsonify({'error': 'Storage unavailable'}), 503

        link = Contact.query.filter_by(user_id=user.id, contact_id=contact_id).first()
        if not link:
            return jsonify({'error': 'You are not connected with this user'}), 403

        media_kind = (request.form.get('media_type') or '').strip().lower()
        caption    = (request.form.get('caption') or '').strip()
        if media_kind not in _ALLOWED_MEDIA_MIMES:
            return jsonify({'error': "media_type must be 'image', 'audio', or 'video'"}), 400

        file = request.files.get('file')
        if not file or not file.filename:
            return jsonify({'error': 'No file provided'}), 400

        mime = (file.mimetype or mimetypes.guess_type(file.filename)[0] or '').lower()
        if mime not in _ALLOWED_MEDIA_MIMES[media_kind]:
            return jsonify({'error': f'Unsupported {media_kind} format: {mime or "unknown"}'}), 400

        data = file.read()
        if not data:
            return jsonify({'error': 'Empty file'}), 400
        limit = _MAX_MEDIA_BYTES[media_kind]
        if len(data) > limit:
            return jsonify({'error': f'{media_kind.capitalize()} must be under {limit // (1024*1024)}MB'}), 400

        # ── Verify image content actually matches its claimed type ──
        if media_kind == 'image':
            try:
                from PIL import Image
                import io
                img = Image.open(io.BytesIO(data))
                img.verify()
            except Exception:
                return jsonify({'error': 'File is not a valid image'}), 400

        msg = Message(
            user_id=user.id, sender_id=user.id, receiver_id=contact_id,
            encrypted_content=caption, message_type=media_kind,
            media_data=data, media_type=mime,
            file_name=(file.filename or media_kind)[:200], file_size=len(data),
            is_delivered=True,
        )
        db.session.add(msg)
        db.session.commit()
        _log_activity(user.id, 'message_sent', f'{media_kind} message')

        payload = {
            'id': msg.id, 'sender_id': user.id, 'sender': user.username, 'avatar': user.avatar,
            'receiver_id': contact_id, 'created_at': msg.created_at.isoformat(),
            'message_type': media_kind, 'content': caption,
            'media_url': f'/api/media/{msg.id}', 'file_name': msg.file_name, 'file_size': msg.file_size,
        }
        if socketio:
            socketio.emit('receive_message', payload, room=f'user_{contact_id}')
            socketio.emit('receive_message', payload, room=f'user_{user.id}')

        return jsonify({'success': True, 'message': payload}), 201

    @app.route('/api/media/<message_id>', methods=['GET'])
    def get_media(message_id):
        user, err = _require_auth()
        if err: return err
        if not DB_AVAILABLE:
            return jsonify({'error': 'Storage unavailable'}), 503

        msg = Message.query.get(message_id)
        if not msg or not msg.media_data:
            return jsonify({'error': 'Not found'}), 404
        if user.id not in (msg.sender_id, msg.receiver_id):
            return jsonify({'error': 'Forbidden'}), 403

        resp = Response(msg.media_data, mimetype=msg.media_type or 'application/octet-stream')
        safe_name = (msg.file_name or 'file').replace('"', '')
        disposition = 'attachment' if request.args.get('download') else 'inline'
        resp.headers['Content-Disposition'] = f'{disposition}; filename="{safe_name}"'
        resp.headers['Cache-Control'] = 'private, max-age=86400'
        return resp

    @app.route('/api/messages/<message_id>/forward', methods=['POST', 'OPTIONS'])
    def forward_message(message_id):
        if request.method == 'OPTIONS': return '', 200
        user, err = _require_auth()
        if err: return err
        if not DB_AVAILABLE:
            return jsonify({'error': 'Storage unavailable'}), 503

        to_contact_id = ((request.get_json() or {}).get('contact_id') or '').strip()
        if not to_contact_id:
            return jsonify({'error': 'contact_id required'}), 400

        original = Message.query.get(message_id)
        if not original:
            return jsonify({'error': 'Message not found'}), 404
        if user.id not in (original.sender_id, original.receiver_id):
            return jsonify({'error': 'Forbidden'}), 403

        link = Contact.query.filter_by(user_id=user.id, contact_id=to_contact_id).first()
        if not link:
            return jsonify({'error': 'You are not connected with this recipient'}), 403

        forwarded = Message(
            user_id=user.id, sender_id=user.id, receiver_id=to_contact_id,
            encrypted_content=original.encrypted_content,
            message_type=original.message_type,
            media_data=original.media_data, media_type=original.media_type,
            file_name=original.file_name, file_size=original.file_size,
            is_delivered=True,
        )
        db.session.add(forwarded)
        db.session.commit()

        payload = {
            'id': forwarded.id, 'sender_id': user.id, 'sender': user.username, 'avatar': user.avatar,
            'receiver_id': to_contact_id, 'created_at': forwarded.created_at.isoformat(),
            'message_type': forwarded.message_type, 'content': forwarded.encrypted_content,
            'media_url': f'/api/media/{forwarded.id}' if forwarded.media_data else None,
            'file_name': forwarded.file_name, 'file_size': forwarded.file_size,
        }
        if socketio:
            socketio.emit('receive_message', payload, room=f'user_{to_contact_id}')
            socketio.emit('receive_message', payload, room=f'user_{user.id}')

        return jsonify({'success': True, 'message': payload}), 201

    @app.route('/api/chat/messages/<message_id>', methods=['DELETE', 'OPTIONS'])
    def delete_chat_message(message_id):
        if request.method == 'OPTIONS': return '', 200
        user, err = _require_auth()
        if err: return err
        if not DB_AVAILABLE:
            return jsonify({'error': 'Storage unavailable'}), 503

        msg = Message.query.get(message_id)
        if not msg:
            return jsonify({'error': 'Message not found'}), 404
        if user.id not in (msg.sender_id, msg.receiver_id):
            return jsonify({'error': 'Forbidden'}), 403

        scope = (request.args.get('scope') or 'me').strip().lower()

        if scope == 'everyone':
            if msg.sender_id != user.id:
                return jsonify({'error': 'Only the sender can delete for everyone'}), 403
            msg.is_deleted = True
            msg.deleted_at = datetime.utcnow()
            msg.deleted_by = user.id
            db.session.commit()
            _log_activity(user.id, 'message_deleted',
                           f'{user.username} deleted a {msg.message_type} message for everyone')
            if socketio:
                socketio.emit('message_deleted', {'message_id': message_id, 'scope': 'everyone'},
                               room=f'user_{msg.receiver_id}')
                socketio.emit('message_deleted', {'message_id': message_id, 'scope': 'everyone'},
                               room=f'user_{msg.sender_id}')
            return jsonify({'success': True, 'scope': 'everyone', 'undo_window_seconds': 60}), 200

        try:
            deleted_for = json.loads(msg.deleted_for) if msg.deleted_for else []
        except Exception:
            deleted_for = []
        if user.id not in deleted_for:
            deleted_for.append(user.id)
        msg.deleted_for = json.dumps(deleted_for)
        db.session.commit()
        who = 'sender' if user.id == msg.sender_id else 'receiver'
        _log_activity(user.id, 'message_deleted',
                       f'{user.username} ({who}) deleted a {msg.message_type} message for themselves')
        return jsonify({'success': True, 'scope': 'me'}), 200

    @app.route('/api/chat/<contact_id>/clear', methods=['POST', 'OPTIONS'])
    def clear_chat_thread(contact_id):
        """
        Bulk 'delete for me' across an entire conversation thread — powers the
        chat UI's Clear Chat button. Does NOT touch the other participant's
        copy of the messages (WhatsApp-style delete-for-me), and does NOT
        delete media_data from storage since the other side may still need it.
        """
        if request.method == 'OPTIONS': return '', 200
        user, err = _require_auth()
        if err: return err
        if not DB_AVAILABLE:
            return jsonify({'success': True, 'cleared': 0}), 200

        _chat_types = ['chat', 'image', 'audio', 'video']
        messages = Message.query.filter(
            Message.is_deleted == False, Message.message_type.in_(_chat_types),
            db.or_(
                db.and_(Message.sender_id == user.id, Message.receiver_id == contact_id),
                db.and_(Message.sender_id == contact_id, Message.receiver_id == user.id),
            )
        ).all()

        cleared = 0
        for m in messages:
            try:
                deleted_for = json.loads(m.deleted_for) if m.deleted_for else []
            except Exception:
                deleted_for = []
            if user.id not in deleted_for:
                deleted_for.append(user.id)
                m.deleted_for = json.dumps(deleted_for)
                cleared += 1
        db.session.commit()

        _log_activity(user.id, 'message_deleted', f'{user.username} cleared a chat thread ({cleared} message(s), for themselves only)')
        return jsonify({'success': True, 'cleared': cleared}), 200

    @app.route('/api/chat/messages/<message_id>/undo-delete', methods=['POST', 'OPTIONS'])
    def undo_delete_message(message_id):
        if request.method == 'OPTIONS': return '', 200
        user, err = _require_auth()
        if err: return err
        if not DB_AVAILABLE:
            return jsonify({'error': 'Storage unavailable'}), 503

        msg = Message.query.get(message_id)
        if not msg:
            return jsonify({'error': 'Message not found'}), 404
        if user.id not in (msg.sender_id, msg.receiver_id):
            return jsonify({'error': 'Forbidden'}), 403

        if msg.is_deleted:
            if msg.deleted_by != user.id:
                return jsonify({'error': 'Only the person who deleted it can undo this'}), 403
            if not msg.deleted_at or (datetime.utcnow() - msg.deleted_at).total_seconds() > 60:
                return jsonify({'error': 'The undo window has expired'}), 400
            msg.is_deleted = False
            msg.deleted_at = None
            msg.deleted_by = None
            db.session.commit()
            _log_activity(user.id, 'message_restored', f'{user.username} undid a delete-for-everyone')
            if socketio:
                socketio.emit('message_restored', {'message_id': message_id},
                               room=f'user_{msg.receiver_id}')
                socketio.emit('message_restored', {'message_id': message_id},
                               room=f'user_{msg.sender_id}')
            return jsonify({'success': True}), 200

        try:
            deleted_for = json.loads(msg.deleted_for) if msg.deleted_for else []
        except Exception:
            deleted_for = []
        if user.id in deleted_for:
            deleted_for.remove(user.id)
            msg.deleted_for = json.dumps(deleted_for)
            db.session.commit()
            return jsonify({'success': True}), 200

        return jsonify({'error': 'Nothing to undo'}), 400

    # ═══════════════════════════════════════════════════════════════════════════
    # ADMIN — activity log viewing + management
    # ═══════════════════════════════════════════════════════════════════════════

    @app.route('/api/admin/activity-logs', methods=['GET'])
    def admin_activity_logs():
        admin, err = _require_admin()
        if err: return err
        if not DB_AVAILABLE:
            return jsonify({'error': 'Storage unavailable'}), 503

        limit = min(request.args.get('limit', 100, type=int), 500)
        offset = request.args.get('offset', 0, type=int)
        event_type = (request.args.get('event_type') or '').strip()

        query = ActivityLog.query
        if event_type:
            query = query.filter_by(event_type=event_type)
        total = query.count()
        logs = query.order_by(ActivityLog.created_at.desc()).offset(offset).limit(limit).all()

        return jsonify({
            'success': True,
            'logs': [l.to_dict() for l in logs],
            'total': total,
            'limit': limit,
            'offset': offset,
        }), 200

    @app.route('/api/admin/activity-logs/clear', methods=['POST', 'OPTIONS'])
    @limiter.limit(ADMIN_MUTATION_LIMIT)
    def admin_clear_activity_logs():
        """
        Irreversibly purges the activity log table. Admin-only, rate-limited,
        and itself NOT logged as an activity event afterward (there would be
        nothing left to log it into meaningfully) — instead it's written to
        the server's own application log for out-of-band audit.
        """
        if request.method == 'OPTIONS': return '', 200
        admin, err = _require_admin()
        if err: return err
        if not DB_AVAILABLE:
            return jsonify({'error': 'Storage unavailable'}), 503

        confirm = (request.get_json(silent=True) or {}).get('confirm')
        if confirm != True:
            return jsonify({'error': 'Confirmation required', 'message': 'Pass {"confirm": true} to proceed.'}), 400

        count = ActivityLog.query.delete(synchronize_session=False)
        db.session.commit()
        log.warning(f'Admin {admin.username} ({admin.id}) cleared {count} activity log entries')
        return jsonify({'success': True, 'cleared': count}), 200

    @app.route('/api/admin/stats', methods=['GET'])
    def admin_stats():
        admin, err = _require_admin()
        if err: return err
        if not DB_AVAILABLE:
            return jsonify({'error': 'Storage unavailable'}), 503

        from sqlalchemy import func
        event_counts = dict(
            db.session.query(ActivityLog.event_type, func.count(ActivityLog.id))
            .group_by(ActivityLog.event_type).all()
        )
        return jsonify({
            'success': True,
            'total_users': User.query.count(),
            'verified_users': User.query.filter_by(is_verified=True).count(),
            'total_messages': Message.query.filter(
                Message.message_type.in_(['chat', 'image', 'audio', 'video'])
            ).count(),
            'event_counts': event_counts,
        }), 200

    @app.route('/api/admin/users', methods=['GET'])
    def admin_users():
        admin, err = _require_admin()
        if err: return err
        if not DB_AVAILABLE:
            return jsonify({'error': 'Storage unavailable'}), 503

        limit = min(request.args.get('limit', 100, type=int), 500)
        offset = request.args.get('offset', 0, type=int)
        total = User.query.count()
        users = User.query.order_by(User.created_at.desc()).offset(offset).limit(limit).all()

        return jsonify({
            'success': True,
            'users': [u.to_admin_dict() for u in users],
            'total': total,
            'limit': limit,
            'offset': offset,
        }), 200

    @socketio.on('connect')
    def handle_connect():
        log.info(f'Socket connected: {request.sid}')
        emit('connected', {'status': 'connected', 'sid': request.sid})

    @socketio.on('disconnect')
    def handle_disconnect():
        log.info(f'Socket disconnected: {request.sid}')
        uid = sid_to_user.pop(request.sid, None)
        if DB_AVAILABLE and uid:
            try:
                u = User.query.get(uid)
                if u:
                    u.is_online = False
                    u.last_seen = datetime.utcnow()
                    db.session.commit()
                    for c in Contact.query.filter_by(user_id=uid, is_blocked=False).all():
                        socketio.emit('user_offline', {'user_id': uid}, room=f'user_{c.contact_id}')
            except Exception as e:
                log.error(f'Presence update on disconnect failed: {e}')

    @socketio.on('join_user_room')
    def handle_join_user_room(data):
        user_id = data.get('user_id', '')
        if not user_id: return
        # ── FIX: verify this socket's session actually belongs to user_id
        # before joining their personal room — previously any connected
        # socket could claim any user_id and receive that user's messages,
        # presence events, and connection-request notifications. ──
        from flask import session as flask_session
        if flask_session.get('user_id') != user_id or flask_session.get('pending_2fa'):
            log.warning(f'[security] sid={request.sid} tried to join room for '
                        f'user_id={user_id} without a matching authenticated session — rejected')
            emit('room_join_denied', {'reason': 'Session does not match requested user'})
            return
        join_room(f'user_{user_id}')
        sid_to_user[request.sid] = user_id
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
                    peers = Contact.query.filter_by(user_id=user_id, is_blocked=False).all()
                    log.info(f'[presence] {user_id} online — notifying {len(peers)} contact(s)')
                    for c in peers:
                        socketio.emit('user_online', {'user_id': user_id}, room=f'user_{c.contact_id}')
            except Exception as e:
                log.error(f'[presence] failed to mark {user_id} online: {e}')

    @socketio.on('join_room')
    def handle_join_room(data):
        room = data.get('room', '')
        # ── FIX: private_<id> rooms combine two user IDs; only allow joining
        # if the requesting session's user_id is actually part of that room
        # name, otherwise any socket could listen in on any conversation. ──
        from flask import session as flask_session
        uid = flask_session.get('user_id')
        if room.startswith('private_') and uid and uid not in room:
            log.warning(f'[security] sid={request.sid} (user={uid}) tried to join '
                        f'room={room} it is not a party to — rejected')
            emit('room_join_denied', {'reason': 'Not a participant in this conversation'})
            return
        if room:
            join_room(room)
            emit('joined_room', {'room': room})

    @socketio.on('mark_read')
    def handle_mark_read(data):
        if not DB_AVAILABLE: return
        contact_id = data.get('contact_id', '')
        user_id = sid_to_user.get(request.sid)
        if not contact_id or not user_id: return
        try:
            unread = Message.query.filter_by(sender_id=contact_id, receiver_id=user_id, is_read=False) \
                .filter(Message.message_type.in_(['chat', 'image', 'audio', 'video'])).all()
            for m in unread:
                m.is_read = True
                m.read_at = datetime.utcnow()
            if unread:
                db.session.commit()
                sender = User.query.get(contact_id)
                sender_name = sender.username if sender else contact_id
                _log_activity(user_id, 'message_received',
                               f'{len(unread)} message(s) received from {sender_name} (live)')
        except Exception as e:
            log.error(f'mark_read failed: {e}')

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

        # ── FIX: verify the socket's authenticated session actually matches
        # the claimed sender_id — previously a socket could claim to be any
        # user and send messages, saved to DB, under someone else's identity. ──
        from flask import session as flask_session
        if flask_session.get('user_id') != sender_id or flask_session.get('pending_2fa'):
            log.warning(f'[security] sid={request.sid} tried to send as sender_id={sender_id} '
                        f'without a matching authenticated session — rejected')
            emit('message_failed', {'temp_id': temp_id, 'error': 'Authentication mismatch'})
            return

        if len(content) > 20000:
            emit('message_failed', {'temp_id': temp_id, 'error': 'Message too long'})
            return

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
                _log_activity(sender_id, 'message_sent', 'text message')
            except Exception as e:
                log.error(f'Save chat msg failed: {e}')
                emit('message_failed', {'temp_id': temp_id, 'error': 'Could not save message'})
                return

        payload = {'id': msg_id, 'content': content, 'sender_id': sender_id,
                   'sender': sender, 'avatar': avatar, 'receiver_id': receiver_id,
                   'created_at': created_at, 'temp_id': temp_id}

        log.info(f'[room] delivering msg {msg_id}: user_{receiver_id} has '
                 f'{_room_size(f"user_{receiver_id}")} socket(s), '
                 f'user_{sender_id} has {_room_size(f"user_{sender_id}")} socket(s)')
        emit('receive_message', payload, room=f'user_{receiver_id}')
        emit('receive_message', payload, room=f'user_{sender_id}')

    @socketio.on('typing')
    def handle_typing(data):
        room = data.get('room', '')
        if room:
            log.info(f'[room] typing in {room} ({_room_size(room)} socket(s) in room)')
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
socketio = None
app = create_app()

if __name__ == '__main__':
    port  = int(os.environ.get('PORT', 5000))
    debug = os.environ.get('FLASK_DEBUG', '0') == '1'
    if socketio:
        socketio.run(app, host='0.0.0.0', port=port, debug=debug)
    else:
        app.run(host='0.0.0.0', port=port, debug=debug)