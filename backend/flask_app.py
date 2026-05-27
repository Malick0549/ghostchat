"""
GhostChat :: backend/flask_app.py
Flask serves BOTH the frontend (../frontend/) and the API.

Run from inside the backend/ folder:
    cd backend
    python flask_app.py

Then open:
    http://127.0.0.1:5000
"""

import os
import sys
import logging
import secrets
import json
import base64
import smtplib
from email.mime.text import MIMEText
from email.mime.multipart import MIMEMultipart
from datetime import datetime, timedelta
from pathlib import Path

from flask import Flask, jsonify, send_from_directory, request, session
from flask_cors import CORS
from flask_session import Session

# ── Local package imports (no 'backend.' prefix — we run FROM backend/) ──────
from api import crypto_bp, session_bp
from api.errors import register_error_handlers
from api.middleware import add_security_headers
from obfuscation.emoji_mapper import EmojiMapper

# Add backend to path for imports
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))


# ── Database models ───────────────────────────────────────────────────────────
try:
    from models import db, bcrypt, User, UserSession, Message, IntegrationToken
    DB_AVAILABLE = True
except ImportError:
    DB_AVAILABLE = False
    print("⚠️  Warning: Database models not found — limited functionality.")

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s  %(levelname)-8s  %(name)s  %(message)s",
)
log = logging.getLogger("ghostchat.api")


def send_reset_email(recipient_email, reset_link):
    """Send password reset email"""
    try:
        # Get email config from environment variables
        smtp_server = os.environ.get("SMTP_SERVER", "smtp.gmail.com")
        smtp_port = int(os.environ.get("SMTP_PORT", 587))
        sender_email = os.environ.get("EMAIL_USER")
        sender_password = os.environ.get("EMAIL_PASSWORD")
        
        # If email is not configured, just log the link
        if not sender_email or not sender_password:
            log.info(f"Email not configured. Reset link would be sent to {recipient_email}: {reset_link}")
            return False
        
        msg = MIMEMultipart()
        msg['From'] = sender_email
        msg['To'] = recipient_email
        msg['Subject'] = "GhostChat Password Reset"
        
        body = f"""
        <html>
        <body>
        <h2>GhostChat Password Reset</h2>
        <p>You requested a password reset for your GhostChat account.</p>
        <p>Click the link below to reset your password (expires in 15 minutes):</p>
        <p><a href="{reset_link}">{reset_link}</a></p>
        <p>If you didn't request this, please ignore this email.</p>
        <hr>
        <p>GhostChat - Secure Encrypted Messaging</p>
        </body>
        </html>
        """
        
        msg.attach(MIMEText(body, 'html'))
        
        server = smtplib.SMTP(smtp_server, smtp_port)
        server.starttls()
        server.login(sender_email, sender_password)
        server.send_message(msg)
        server.quit()
        
        log.info(f"Reset email sent to: {recipient_email}")
        return True
    except Exception as e:
        log.error(f"Failed to send email: {e}")
        return False


def create_app(test_config: dict | None = None) -> Flask:

    # Serve frontend from the sibling ../frontend/ folder
    app = Flask(
        __name__,
        static_folder='../frontend',
        static_url_path='',
    )

    app.config.from_mapping(
        SECRET_KEY=os.environ.get("FLASK_SECRET", secrets.token_hex(32)),
        DEBUG=os.environ.get("FLASK_DEBUG", "0") == "1",
        JSON_SORT_KEYS=False,
        TESTING=False,
    )

    # Database
    basedir = os.path.abspath(os.path.dirname(__file__))
    app.config['SQLALCHEMY_DATABASE_URI'] = (
        f'sqlite:///{os.path.join(basedir, "ghostchat.db")}'
    )
    app.config['SQLALCHEMY_TRACK_MODIFICATIONS'] = False

    # Server-side sessions
    app.config['SESSION_TYPE'] = 'filesystem'
    app.config['SESSION_PERMANENT'] = False
    app.config['PERMANENT_SESSION_LIFETIME'] = timedelta(hours=24)

    # Avatar uploads
    app.config['UPLOAD_FOLDER'] = os.path.join(
        basedir, '..', 'frontend', 'assets', 'uploads'
    )
    os.makedirs(app.config['UPLOAD_FOLDER'], exist_ok=True)

    if test_config:
        app.config.update(test_config)

    # ── Initialise extensions ─────────────────────────────────────────────────
    if DB_AVAILABLE:
        db.init_app(app)
        bcrypt.init_app(app)
        with app.app_context():
            db.create_all()
            log.info("Database initialised")

    Session(app)

    # ── CORS ──────────────────────────────────────────────────────────────────
    CORS(app,
         supports_credentials=True,
         origins=['http://localhost:5000', 'http://127.0.0.1:5000', 'null'])

    # ── Blueprints ────────────────────────────────────────────────────────────
    app.register_blueprint(crypto_bp)   # /encrypt, /decrypt (session-key API)
    app.register_blueprint(session_bp)  # /new-session, /session-info, etc.

    # ── Security headers + error handlers ────────────────────────────────────
    app.after_request(add_security_headers)
    register_error_handlers(app)

    # ══════════════════════════════════════════════════════════════════════════
    # CSRF TOKEN
    # ══════════════════════════════════════════════════════════════════════════

    @app.route('/api/csrf-token', methods=['GET', 'OPTIONS'])
    def csrf_token():
        if request.method == 'OPTIONS':
            return '', 200
        token = session.get('csrf_token')
        if not token:
            token = secrets.token_hex(32)
            session['csrf_token'] = token
        return jsonify({'csrf_token': token}), 200

    # ── Internal CSRF check helper ────────────────────────────────────────────
    def _check_csrf():
        if request.method in ('GET', 'OPTIONS', 'HEAD'):
            return None, None
        if request.path in ('/api/csrf-token', '/health'):
            return None, None
        client_token = request.headers.get('X-CSRF-Token') or (request.get_json(silent=True) or {}).get('csrf_token')
        session_token = session.get('csrf_token')
        if not client_token or not session_token:
            return jsonify({'error': 'CSRF token missing'}), 403
        if not secrets.compare_digest(client_token, session_token):
            return jsonify({'error': 'CSRF token invalid'}), 403
        return None, None

    # ══════════════════════════════════════════════════════════════════════════
    # AUTHENTICATION ROUTES
    # ══════════════════════════════════════════════════════════════════════════

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
            data = request.get_json()
            if not data:
                return jsonify({'error': 'No data provided'}), 400
            username = (data.get('username') or '').strip()
            email = (data.get('email') or '').strip()
            password = data.get('password') or ''
            if not username or not email or not password:
                return jsonify({'error': 'Username, email and password are required'}), 400
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
            session['user_id'] = user.id
            session['authenticated'] = True
            session['csrf_token'] = secrets.token_hex(32)
            log.info(f"New user registered: {username}")
            return jsonify({
                'success': True,
                'message': 'Registration successful',
                'user': user.to_dict(),
            }), 201
        except Exception as exc:
            if DB_AVAILABLE:
                db.session.rollback()
            log.error(f"Registration error: {exc}")
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
            data = request.get_json()
            if not data:
                return jsonify({'error': 'No data provided'}), 400
            username = (data.get('username') or '').strip()
            password = data.get('password') or ''
            if not username or not password:
                return jsonify({'error': 'Username and password are required'}), 400
            user = User.query.filter_by(username=username).first() or User.query.filter_by(email=username).first()
            if not user or not user.check_password(password):
                log.warning(f"Failed login attempt for identifier: {username[:20]}")
                return jsonify({'error': 'Invalid credentials'}), 401
            if not user.is_active:
                return jsonify({'error': 'Account is disabled'}), 401
            user.last_login = datetime.utcnow()
            db.session.commit()
            session['user_id'] = user.id
            session['authenticated'] = True
            session['csrf_token'] = secrets.token_hex(32)
            log.info(f"User logged in: {user.username}")
            return jsonify({
                'success': True,
                'message': 'Login successful',
                'user': user.to_dict(),
            }), 200
        except Exception as exc:
            log.error(f"Login error: {exc}")
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
        if not DB_AVAILABLE:
            return jsonify({'error': 'Database not available'}), 500
        user_id = session.get('user_id')
        if not user_id:
            return jsonify({'error': 'Not authenticated'}), 401
        user = User.query.get(user_id)
        if not user:
            session.clear()
            return jsonify({'error': 'User not found'}), 401
        return jsonify({'user': user.to_dict()}), 200

    @app.route('/api/auth/forgot-password', methods=['POST', 'OPTIONS'])
    def forgot_password():
        if request.method == 'OPTIONS':
            return '', 200
        if not DB_AVAILABLE:
            return jsonify({'error': 'Database not available'}), 500
        try:
            data = request.get_json() or {}
            email = (data.get('email') or '').strip()
            if not email:
                return jsonify({'error': 'Email is required'}), 400
            user = User.query.filter_by(email=email).first()
            if user:
                token = user.generate_reset_token()
                user.reset_token_expires = datetime.utcnow() + timedelta(minutes=15)
                db.session.commit()
                log.info(f"Password reset requested for: {email}")
                reset_link = f"https://ghostchat.onrender.com/reset-password.html?token={token}"
                log.info(f"RESET LINK: {reset_link}")
                # Try to send email
                send_reset_email(email, reset_link)
            return jsonify({
                'success': True,
                'message': 'If that email is registered, a reset link has been sent.',
            }), 200
        except Exception as exc:
            log.error(f"Forgot password error: {exc}")
            return jsonify({'error': 'Request failed. Please try again.'}), 500

    @app.route('/api/auth/reset-password', methods=['POST', 'OPTIONS'])
    def reset_password():
        if request.method == 'OPTIONS':
            return '', 200
        if not DB_AVAILABLE:
            return jsonify({'error': 'Database not available'}), 500
        try:
            data = request.get_json() or {}
            token = (data.get('token') or '').strip()
            new_password = (data.get('new_password') or '')
            if not token or not new_password:
                return jsonify({'error': 'Token and new password are required'}), 400
            if len(new_password) < 8:
                return jsonify({'error': 'Password must be at least 8 characters'}), 400
            user = User.query.filter_by(reset_token=token).first()
            if not user or not user.verify_reset_token(token):
                return jsonify({'error': 'Invalid or expired reset link'}), 400
            user.set_password(new_password)
            user.reset_token = None
            user.reset_token_expires = None
            db.session.commit()
            log.info(f"Password reset successful for user: {user.username}")
            return jsonify({'success': True, 'message': 'Password reset successful'}), 200
        except Exception as exc:
            log.error(f"Reset password error: {exc}")
            return jsonify({'error': 'Reset failed. Please try again.'}), 500

    # ══════════════════════════════════════════════════════════════════════════
    # PROFILE ROUTES
    # ══════════════════════════════════════════════════════════════════════════

    def _require_auth():
        if not DB_AVAILABLE:
            return None, (jsonify({'error': 'Database not available'}), 500)
        user_id = session.get('user_id')
        if not user_id:
            return None, (jsonify({'error': 'Not authenticated'}), 401)
        user = User.query.get(user_id)
        if not user:
            session.clear()
            return None, (jsonify({'error': 'User not found'}), 401)
        return user, None

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
        new_email = (data.get('email') or '').strip()
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
        data = request.get_json() or {}
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
        return jsonify({'success': True, 'message': 'Password changed. Please sign in again.'}), 200

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
        if not file or file.filename == '':
            return jsonify({'error': 'No file selected'}), 400
        allowed = {'png', 'jpg', 'jpeg', 'gif', 'webp'}
        ext = file.filename.rsplit('.', 1)[-1].lower() if '.' in file.filename else ''
        if ext not in allowed:
            return jsonify({'error': 'Invalid file type. Use PNG, JPG, JPEG, GIF, or WEBP'}), 400
        file.seek(0, 2)
        size = file.tell()
        file.seek(0)
        if size > 2 * 1024 * 1024:
            return jsonify({'error': 'File too large. Maximum size is 2 MB'}), 400
        upload_folder = app.config['UPLOAD_FOLDER']
        os.makedirs(upload_folder, exist_ok=True)
        if user.avatar and '/assets/uploads/' in user.avatar:
            old_path = os.path.join(upload_folder, os.path.basename(user.avatar))
            if os.path.exists(old_path):
                try:
                    os.remove(old_path)
                except OSError:
                    pass
        filename = f"avatar_{user.id}_{datetime.utcnow().timestamp():.0f}.{ext}"
        file.save(os.path.join(upload_folder, filename))
        user.avatar = f"/assets/uploads/{filename}"
        db.session.commit()
        return jsonify({
            'success': True,
            'avatar': user.avatar,
            'message': 'Avatar updated successfully',
        }), 200

    @app.route('/assets/uploads/<filename>', methods=['GET'])
    def serve_uploaded_file(filename):
        upload_folder = os.path.join(os.path.dirname(__file__), '..', 'frontend', 'assets', 'uploads')
        return send_from_directory(upload_folder, filename)

    # ══════════════════════════════════════════════════════════════════════════
    # SIMPLE ENCRYPT / DECRYPT
    # ══════════════════════════════════════════════════════════════════════════

    @app.route('/api/encrypt', methods=['POST', 'OPTIONS'])
    def encrypt_message():
        if request.method == 'OPTIONS':
            return '', 200
        try:
            data = request.get_json()
            if not data:
                return jsonify({'success': False, 'error': 'No data provided'}), 400
            message = (data.get('message') or '').strip()
            password = (data.get('password') or '').strip()
            if not message:
                return jsonify({'success': False, 'error': 'Message is required'}), 400
            if not password:
                return jsonify({'success': False, 'error': 'Password is required'}), 400
            from ghostchat import GhostChat
            ghost = GhostChat(password)
            result = ghost.send(message, deterministic=False)
            package = json.dumps({
                'emojis': result['emoji_message'],
                'iv': result['metadata']['iv'],
                'signature': result['metadata']['signature'],
                'key_id': result['metadata']['key_id'],
                'salt': result['metadata']['salt'],
            }, ensure_ascii=False)
            emoji_package = EmojiMapper.text_to_emojis(
                base64.b64encode(package.encode('utf-8')).decode('ascii')
            )
            return jsonify({
                'success': True,
                'emoji_message': result['emoji_message'],
                'package': package,
                'emoji_package': emoji_package,
                'metadata': result['metadata'],
                'emoji_count': len(result['emoji_message']),
                'algorithm': 'AES-256-CBC',
                'key_derivation': 'PBKDF2-HMAC-SHA256',
            }), 200
        except ValueError as exc:
            return jsonify({'success': False, 'error': str(exc)}), 400
        except Exception as exc:
            log.error(f"Encrypt error: {exc}")
            return jsonify({'success': False, 'error': 'Encryption failed'}), 500

    @app.route('/api/decrypt', methods=['POST', 'OPTIONS'])
    def decrypt_message():
        if request.method == 'OPTIONS':
            return '', 200
        try:
            data = request.get_json()
            if not data:
                return jsonify({'success': False, 'error': 'No data provided'}), 400
            emoji_message = (data.get('emoji_message') or '').strip()
            password = (data.get('password') or '').strip()
            if not emoji_message:
                return jsonify({'success': False, 'error': 'Emoji message is required'}), 400
            if not password:
                return jsonify({'success': False, 'error': 'Password is required'}), 400
            from ghostchat import GhostChat
            ghost = GhostChat(password)
            plaintext = ghost.receive_message(emoji_message)
            if plaintext.startswith('Decryption failed'):
                return jsonify({'success': False, 'error': plaintext}), 400
            return jsonify({
                'success': True,
                'decrypted_message': plaintext,
                'algorithm': 'AES-256-CBC',
            }), 200
        except ValueError as exc:
            return jsonify({'success': False, 'error': str(exc)}), 400
        except Exception as exc:
            log.error(f"Decrypt error: {exc}")
            return jsonify({'success': False, 'error': 'Decryption failed'}), 500

    # ══════════════════════════════════════════════════════════════════════════
    # MESSAGE HISTORY ROUTES
    # ══════════════════════════════════════════════════════════════════════════

    @app.route('/api/messages', methods=['GET', 'OPTIONS'])
    def get_messages():
        if request.method == 'OPTIONS':
            return '', 200
        if not DB_AVAILABLE:
            return jsonify({'success': True, 'messages': [], 'total': 0}), 200
        user, err = _require_auth()
        if err:
            return err
        limit = request.args.get('limit', 50, type=int)
        offset = request.args.get('offset', 0, type=int)
        messages = Message.query.filter_by(user_id=user.id).order_by(Message.created_at.desc()).limit(limit).offset(offset).all()
        total = Message.query.filter_by(user_id=user.id).count()
        return jsonify({
            'success': True,
            'messages': [m.to_dict() for m in messages],
            'total': total,
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
        message = Message(
            user_id=user.id,
            encrypted_content=data.get('encrypted_content', ''),
            emoji_content=data.get('emoji_content', ''),
            message_type=data.get('message_type', 'encryption'),
        )
        db.session.add(message)
        db.session.commit()
        return jsonify({'success': True, 'message_id': message.id}), 201

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

    # ══════════════════════════════════════════════════════════════════════════
    # INTEGRATION ROUTES
    # ══════════════════════════════════════════════════════════════════════════

    @app.route('/api/integrations', methods=['GET', 'OPTIONS'])
    def get_integrations():
        if request.method == 'OPTIONS':
            return '', 200
        if not DB_AVAILABLE:
            return jsonify({'success': True, 'integrations': []}), 200
        user, err = _require_auth()
        if err:
            return err
        items = IntegrationToken.query.filter_by(user_id=user.id).all()
        return jsonify({
            'success': True,
            'integrations': [{
                'service': i.service,
                'is_active': i.is_active,
                'has_webhook': bool(i.webhook_url),
            } for i in items],
        }), 200

    @app.route('/api/integrations/<service>', methods=['POST', 'OPTIONS'])
    def save_integration(service):
        if request.method == 'OPTIONS':
            return '', 200
        if not DB_AVAILABLE:
            return jsonify({'success': True}), 200
        user, err = _require_auth()
        if err:
            return err
        data = request.get_json() or {}
        item = IntegrationToken.query.filter_by(user_id=user.id, service=service).first()
        if not item:
            item = IntegrationToken(user_id=user.id, service=service)
            db.session.add(item)
        if 'webhook_url' in data:
            item.webhook_url = data['webhook_url']
        if 'access_token' in data:
            item.access_token = data['access_token']
        item.is_active = data.get('is_active', True)
        db.session.commit()
        return jsonify({'success': True}), 200

    # ══════════════════════════════════════════════════════════════════════════
    # HEALTH CHECK + FRONTEND SERVING
    # ══════════════════════════════════════════════════════════════════════════

    @app.route('/health', methods=['GET'])
    def health():
        return jsonify({
            'status': 'ok',
            'service': 'GhostChat API',
            'database': 'connected' if DB_AVAILABLE else 'disabled',
            'version': '2.0.0',
        }), 200

    @app.route('/', methods=['GET'])
    def frontend_index():
        frontend_dir = os.path.join(os.path.dirname(__file__), '..', 'frontend')
        return send_from_directory(frontend_dir, 'index.html')

    ALLOWED_EXTENSIONS = ('.html', '.css', '.js', '.png', '.jpg', '.jpeg', '.gif', '.svg', '.ico', '.json', '.woff', '.woff2', '.ttf', '.webp')

    @app.route('/<path:filename>', methods=['GET'])
    def serve_frontend_files(filename):
        frontend_dir = os.path.join(os.path.dirname(__file__), '..', 'frontend')
        if any(filename.lower().endswith(ext) for ext in ALLOWED_EXTENSIONS):
            return send_from_directory(frontend_dir, filename)
        return jsonify({'error': 'Not Found'}), 404

    log.info("GhostChat ready → http://127.0.0.1:5000")
    return app


# Create the app instance for gunicorn
app = create_app()

if __name__ == '__main__':
    print("=" * 60)
    print("GhostChat Server")
    print("=" * 60)
    app.run(host='0.0.0.0', port=int(os.environ.get('PORT', 5000)), debug=os.environ.get('FLASK_DEBUG', '0') == '1')
