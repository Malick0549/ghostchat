"""
GhostChat :: backend/hardening.py
Security hardening layer. Installed once from flask_app.py with install_hardening(...).

What it adds (each item is covered by a test in the security suite):
  * socket rooms: nobody can join another user's room, listen to a conversation they
    are not part of, or push typing events into rooms they are not in
  * sockets reject visitors who are not signed in; messages are rate limited; the
    sender's name/avatar come from the server, never from the client
  * REST + socket messaging only between connected, un-blocked contacts
  * account lockout after repeated failed sign-ins (works even if the attacker rotates IPs)
  * verification-code guessing and reset-mail flooding capped per account / per email
  * password policy (length, common passwords, letters+digits, not your own name)
  * username format check (no HTML / odd characters)
  * sessions stop working after a password change or reset (and live sockets are dropped)
  * timing equalisation so "unknown user" and "wrong password" take the same time
  * upload checks (real file signature for audio/video) and safe download filenames
  * history API cannot be used to forge chat messages
  * notification to the OLD address when an account email is changed
"""

import os
import re
import time
import hashlib
import threading
from collections import defaultdict, deque
from datetime import datetime, timedelta

from flask import request, session, jsonify, g

# ── tunables (all overridable from Render environment variables) ──────────────
def _int(name, default):
    try:
        return int(os.environ.get(name, default))
    except (TypeError, ValueError):
        return default

LOCK_THRESHOLD   = _int('ACCOUNT_LOCK_THRESHOLD', 8)      # failed sign-ins ...
LOCK_WINDOW_MIN  = _int('ACCOUNT_LOCK_MINUTES', 15)       # ... within this many minutes
VERIFY_FAILS     = _int('VERIFY_CODE_MAX_FAILS', 6)       # wrong codes per email per 15 min
MSG_BURST        = _int('MSG_RATE_LIMIT', 30)             # messages per user ...
MSG_WINDOW_SEC   = _int('MSG_RATE_WINDOW', 10)            # ... per this many seconds
MEDIA_PER_MIN    = _int('MEDIA_RATE_LIMIT', 10)

_USERNAME_RE = re.compile(r'^[A-Za-z0-9_.\-]{3,30}$')

_COMMON = {
    'password', 'password1', 'password12', 'password123', 'passw0rd', 'p@ssw0rd', 'p@ssword',
    'qwerty', 'qwerty12', 'qwerty123', 'qwertyui', 'qwertyuiop', 'asdfghjk', 'asdfghjkl',
    'zxcvbnm', 'letmein', 'letmein1', 'welcome', 'welcome1', 'welcome123', 'iloveyou',
    'iloveyou1', 'admin', 'admin123', 'administrator', 'monkey', 'dragon', 'football',
    'baseball', 'abc12345', 'abcd1234', 'abcdefgh', '11111111', '00000000', '12345678',
    '123456789', '1234567890', '987654321', '1q2w3e4r', '1qaz2wsx', 'changeme', 'secret',
    'trustno1', 'superman', 'batman', 'sunshine', 'princess', 'whatever', 'freedom',
    'ghostchat', 'ghostchat1', 'ghostchat123', 'passwordpassword', 'masterkey', 'shadow',
}

_SEQ = '0123456789abcdefghijklmnopqrstuvwxyz'


def password_problem(password, *identity_bits):
    """Return a human readable reason the password is rejected, or None if it is fine."""
    if not isinstance(password, str):
        return 'Password is required'
    if len(password) < 8:
        return 'Password must be at least 8 characters'
    if len(password) > 128:
        return 'Password must be 128 characters or fewer'
    low = password.lower()
    if low in _COMMON or low.rstrip('0123456789!@#$%') in _COMMON:
        return 'That password is too common. Pick something harder to guess.'
    if len(set(low)) <= 2:
        return 'That password is too repetitive.'
    if low in _SEQ or low in _SEQ[::-1]:
        return 'That password is a simple sequence.'
    has_letter = any(c.isalpha() for c in password)
    has_digit = any(c.isdigit() for c in password)
    has_other = any(not c.isalnum() for c in password)
    # a long passphrase is fine without digits; short ones need a mix
    if len(password) < 14 and not (has_letter and (has_digit or has_other)):
        return 'Use letters together with at least one number or symbol (or make it 14+ characters).'
    for bit in identity_bits:
        bit = (bit or '').strip().lower()
        if len(bit) >= 4 and bit in low:
            return 'Your password should not contain your username or email name.'
    return None


class _Counter:
    """Small thread-safe sliding-window counter."""
    def __init__(self):
        self._d = defaultdict(deque)
        self._lock = threading.Lock()

    def count(self, key, window):
        now = time.time()
        with self._lock:
            q = self._d[key]
            while q and now - q[0] > window:
                q.popleft()
            if not q:
                self._d.pop(key, None)
                return 0
            return len(q)

    def hit(self, key, window):
        now = time.time()
        with self._lock:
            q = self._d[key]
            while q and now - q[0] > window:
                q.popleft()
            q.append(now)
            if len(self._d) > 20000:       # memory guard
                for k in list(self._d)[:5000]:
                    self._d.pop(k, None)
            return len(q)

    def clear(self, key):
        with self._lock:
            self._d.pop(key, None)


def _pv(user):
    """Short fingerprint of the current password. Changes whenever the password does."""
    return hashlib.sha256((user.password_hash or '').encode()).hexdigest()[:16]


_SIGNATURES = {
    'audio': [
        (0, b'\x1a\x45\xdf\xa3'),          # webm / matroska
        (0, b'OggS'),
        (0, b'ID3'),
        (0, b'\xff\xfb'), (0, b'\xff\xf3'), (0, b'\xff\xf2'), (0, b'\xff\xe3'), (0, b'\xff\xf1'),
        (4, b'ftyp'),                      # mp4 / m4a
        (0, b'RIFF'),                      # wav (checked further below)
    ],
    'video': [
        (0, b'\x1a\x45\xdf\xa3'),
        (4, b'ftyp'), (4, b'moov'), (4, b'mdat'), (4, b'free'), (4, b'wide'),
    ],
}


def _signature_ok(kind, head):
    if kind not in _SIGNATURES:
        return True
    for off, sig in _SIGNATURES[kind]:
        if head[off:off + len(sig)] == sig:
            if sig == b'RIFF' and head[8:12] != b'WAVE':
                continue
            return True
    return False


def _safe_filename(name):
    name = re.sub(r'[\r\n\x00"\\/]', '', name or '')
    name = re.sub(r'[^\w.\- ()]', '_', name).strip(' .')
    return (name or 'file')[:120]


def install_hardening(app, *, db, User, Contact, ActivityLog, Message, socketio, log,
                      log_activity, send_email, sid_to_user, bcrypt=None, db_available=True):
    """Wire everything. Call once, after the audit module is installed and before `return app`."""

    try:                                           # image bomb protection
        from PIL import Image
        Image.MAX_IMAGE_PIXELS = 40_000_000
    except Exception:
        pass

    verify_fails = _Counter()      # email -> wrong verification codes
    resend_hits = _Counter()       # email -> verification mails requested
    reset_hits = _Counter()        # email -> reset mails requested
    msg_hits = _Counter()          # user id -> chat messages
    media_hits = _Counter()        # user id -> uploads
    typing_hits = _Counter()       # sid -> typing events

    DUMMY_HASH = None
    if bcrypt is not None:
        try:
            DUMMY_HASH = bcrypt.generate_password_hash('not-a-real-password').decode()
        except Exception:
            DUMMY_HASH = None

    def _json():
        return request.get_json(silent=True) or {}

    def _user_by_login(name):
        name = (name or '').strip()
        if not name:
            return None
        return (User.query.filter_by(username=name).first()
                or User.query.filter_by(email=name).first())

    def _may_message(sender_id, receiver_id):
        if not sender_id or not receiver_id or sender_id == receiver_id:
            return False
        mine = Contact.query.filter_by(user_id=sender_id, contact_id=receiver_id).first()
        if not mine or mine.is_blocked:
            return False
        theirs = Contact.query.filter_by(user_id=receiver_id, contact_id=sender_id).first()
        if theirs is not None and theirs.is_blocked:
            return False
        return True

    def _recent_failures(user):
        """Failed sign-ins since the last good sign-in / password reset, inside the window."""
        since = datetime.utcnow() - timedelta(minutes=LOCK_WINDOW_MIN)
        good = (ActivityLog.query
                .filter(ActivityLog.user_id == user.id,
                        ActivityLog.event_type.in_(('login', 'password_reset_completed')),
                        ActivityLog.created_at >= since)
                .order_by(ActivityLog.created_at.desc()).first())
        if good and good.created_at > since:
            since = good.created_at
        return (ActivityLog.query
                .filter(ActivityLog.user_id == user.id,
                        ActivityLog.event_type == 'login_failed',
                        ActivityLog.created_at >= since).count())

    def _drop_sockets(uid):
        try:
            for sid, u in list(sid_to_user.items()):
                if u == uid:
                    sid_to_user.pop(sid, None)
                    socketio.server.disconnect(sid)
        except Exception as e:
            log.warning(f'[hardening] could not drop sockets for {uid}: {e}')

    # ═══════════════════════════════════════════════════════════════════════════
    # REST: one guard that runs before every request
    # ═══════════════════════════════════════════════════════════════════════════
    CHAT_MSG_RE = re.compile(r'^/api/chat/([^/]+)/(messages|media)$')

    @app.before_request
    def hardening_guard():
        if not db_available:
            return None
        path, method = request.path, request.method

        # ── sessions die when the password changes ──
        uid = session.get('user_id')
        if uid and not session.get('pending_2fa'):
            pv = session.get('pv')
            if pv:
                u = db.session.get(User, uid)
                if u is None or pv != _pv(u):
                    session.clear()
                    if path.startswith('/api/'):
                        return jsonify({'error': 'Session expired. Please sign in again.'}), 401

        if method == 'OPTIONS':
            return None

        # ── legacy public upload folder: signed-in users only ──
        if path.startswith('/assets/uploads/') and not session.get('user_id'):
            return jsonify({'error': 'Not authenticated'}), 401

        if method == 'POST' and path == '/api/auth/login':
            name = (_json().get('username') or '').strip()
            u = _user_by_login(name)
            if u is None:
                if DUMMY_HASH and bcrypt is not None:      # same cost as a real check
                    try:
                        bcrypt.check_password_hash(DUMMY_HASH, str(_json().get('password') or '')[:128])
                    except Exception:
                        pass
            elif _recent_failures(u) >= LOCK_THRESHOLD:
                if not (ActivityLog.query.filter(
                        ActivityLog.user_id == u.id, ActivityLog.event_type == 'login_locked',
                        ActivityLog.created_at >= datetime.utcnow() - timedelta(minutes=LOCK_WINDOW_MIN)).first()):
                    log_activity(u.id, 'login_locked',
                                 f'Sign-in locked for {LOCK_WINDOW_MIN} min after repeated failures', severity='critical')
                return jsonify({'error': f'Too many failed attempts. Try again in {LOCK_WINDOW_MIN} minutes, '
                                         f'or reset your password.', 'locked': True}), 429
            return None

        if method == 'POST' and path == '/api/auth/register':
            d = _json()
            username = (d.get('username') or '').strip()
            email = (d.get('email') or '').strip()
            if username and not _USERNAME_RE.match(username):
                return jsonify({'error': 'Username must be 3–30 characters: letters, numbers, dot, dash or underscore.'}), 400
            if len(email) > 254:
                return jsonify({'error': 'Please enter a valid email address'}), 400
            bad = password_problem(d.get('password') or '', username, email.split('@')[0])
            if bad and (d.get('password') or ''):
                return jsonify({'error': bad}), 400
            return None

        if method == 'POST' and path == '/api/auth/reset-password':
            tok = (_json().get('token') or '').strip()
            ru = User.query.filter_by(reset_token=tok).first() if tok else None
            g._pw_uid = ru.id if ru else None
            bad = password_problem(_json().get('new_password') or '')
            if bad and _json().get('new_password'):
                return jsonify({'error': bad}), 400
            return None

        if method == 'PUT' and path == '/api/profile/password':
            g._pw_uid = uid
            u = db.session.get(User, uid) if uid else None
            new = _json().get('new_password') or ''
            if u and new:
                bad = password_problem(new, u.username, (u.email or '').split('@')[0])
                if bad:
                    return jsonify({'error': bad}), 400
                if new == (_json().get('old_password') or ''):
                    return jsonify({'error': 'Choose a password different from the current one.'}), 400
            return None

        if method == 'PUT' and path == '/api/profile':
            name = (_json().get('username') or '').strip()
            u = db.session.get(User, uid) if uid else None
            if name and u and name != u.username and not _USERNAME_RE.match(name):
                return jsonify({'error': 'Username must be 3–30 characters: letters, numbers, dot, dash or underscore.'}), 400
            return None

        if method == 'POST' and path == '/api/auth/verify-email':
            email = (_json().get('email') or '').strip().lower()
            if email and verify_fails.count(email, 900) >= VERIFY_FAILS:
                return jsonify({'error': 'Too many incorrect codes. Wait 15 minutes, then request a new code.'}), 429
            return None

        if method == 'POST' and path == '/api/auth/resend-verification':
            email = (_json().get('email') or '').strip().lower()
            if email and resend_hits.count(email, 3600) >= 5:
                return jsonify({'success': True, 'message': 'If that email needs verification, a new code has been sent.'}), 200
            if email:
                resend_hits.hit(email, 3600)
            return None

        if method == 'POST' and path == '/api/auth/forgot-password':
            email = (_json().get('email') or '').strip().lower()
            if email and reset_hits.count(email, 3600) >= 5:
                return jsonify({'success': True, 'message': 'If that email is registered, a reset link has been sent.'}), 200
            if email:
                reset_hits.hit(email, 3600)
            return None

        if method == 'POST' and path == '/api/messages':
            d = _json()
            if d.get('message_type', 'encryption') not in ('encryption', 'decryption'):
                return jsonify({'error': 'Invalid message type'}), 400
            for k in ('encrypted_content', 'emoji_content'):
                if len(str(d.get(k) or '')) > 200000:
                    return jsonify({'error': 'Entry too large'}), 400
            return None

        m = CHAT_MSG_RE.match(path)
        if m and method == 'POST' and uid:
            other, kind = m.group(1), m.group(2)
            if msg_hits.count(uid, MSG_WINDOW_SEC) >= MSG_BURST:
                return jsonify({'error': 'You are sending too fast. Slow down a little.'}), 429
            msg_hits.hit(uid, MSG_WINDOW_SEC)
            if not _may_message(uid, other):
                return jsonify({'error': 'You can only message people you are connected with'}), 403
            if kind == 'media':
                if media_hits.count(uid, 60) >= MEDIA_PER_MIN:
                    return jsonify({'error': 'Too many uploads. Try again in a minute.'}), 429
                media_hits.hit(uid, 60)
                f = request.files.get('file')
                mk = (request.form.get('media_type') or '').strip().lower()
                if f is not None and mk in _SIGNATURES:
                    head = f.stream.read(16)
                    f.stream.seek(0)
                    if not _signature_ok(mk, head):
                        return jsonify({'error': f'File does not look like a real {mk} file'}), 400
            return None

        if method == 'POST' and re.match(r'^/api/messages/[^/]+/forward$', path) and uid:
            to = _json().get('contact_id')
            if to and not _may_message(uid, str(to)):
                return jsonify({'error': 'You can only message people you are connected with'}), 403
        return None

    @app.after_request
    def hardening_after(resp):
        try:
            path, method = request.path, request.method
            # remember which password this session was created with
            if session.get('user_id') and not session.get('pending_2fa') and 'pv' not in session and db_available:
                u = db.session.get(User, session['user_id'])
                if u:
                    session['pv'] = _pv(u)

            if method == 'POST' and path == '/api/auth/verify-email':
                email = (_json().get('email') or '').strip().lower()
                if email and resp.status_code == 400:
                    verify_fails.hit(email, 900)
                elif email and resp.status_code == 200:
                    verify_fails.clear(email)

            if path in ('/api/profile/password', '/api/auth/reset-password') and resp.status_code == 200:
                if getattr(g, '_pw_uid', None):
                    _drop_sockets(g._pw_uid)      # open sockets keep old rights until dropped

            if path.startswith('/api/media/') and resp.status_code == 200:
                cd = resp.headers.get('Content-Disposition', '')
                kind = 'attachment' if cd.startswith('attachment') else 'inline'
                m = re.search(r'filename="([^"]*)"', cd)
                resp.headers['Content-Disposition'] = f'{kind}; filename="{_safe_filename(m.group(1) if m else "")}"'
                resp.headers['Content-Security-Policy'] = "sandbox; default-src 'none'"
                resp.headers['Cross-Origin-Resource-Policy'] = 'same-origin'
        except Exception as e:                       # hardening must never break a response
            log.error(f'[hardening] after_request: {e}')
        return resp

    # ── email change: tell the OLD address (account-takeover early warning) ──
    @app.before_request
    def _remember_old_email():
        if request.method == 'PUT' and request.path == '/api/profile' and session.get('user_id') and db_available:
            u = db.session.get(User, session['user_id'])
            g._old_email = u.email if u else None

    @app.after_request
    def _notify_email_change(resp):
        try:
            old = getattr(g, '_old_email', None)
            if old and request.path == '/api/profile' and request.method == 'PUT' and resp.status_code == 200:
                u = db.session.get(User, session.get('user_id'))
                if u and u.email != old:
                    log_activity(u.id, 'email_changed', f'Account email changed from {old} to {u.email}', severity='warning')
                    send_email(
                        subject='Your GhostChat email address was changed',
                        recipient=old,
                        html_body=('<p>The email address on your GhostChat account was just changed.</p>'
                                   '<p>If this was you, nothing else to do. If it was not, reset your password '
                                   'right away and contact the site admin.</p>'),
                        text_body=('The email address on your GhostChat account was just changed. '
                                   'If this was not you, reset your password right away.'),
                    )
        except Exception as e:
            log.error(f'[hardening] email change notice failed: {e}')
        return resp

    # ═══════════════════════════════════════════════════════════════════════════
    # SOCKETS — these replace the older handlers of the same name
    # ═══════════════════════════════════════════════════════════════════════════
    from flask_socketio import emit, join_room, rooms as sock_rooms

    def _sock_user():
        """The signed-in, active, current-password user behind this socket, or None."""
        uid = session.get('user_id')
        if not uid or session.get('pending_2fa') or not db_available:
            return None
        u = db.session.get(User, uid)
        if not u or not u.is_active:
            return None
        pv = session.get('pv')
        if pv and pv != _pv(u):
            return None
        return u

    @socketio.on('connect')
    def hs_connect():
        if not _sock_user():
            log.info(f'[security] socket {request.sid} refused: not signed in')
            return False
        emit('connected', {'status': 'connected', 'sid': request.sid})

    @socketio.on('join_user_room')
    def hs_join_user_room(data):
        data = data if isinstance(data, dict) else {}
        u = _sock_user()
        if not u or data.get('user_id') != u.id:
            log.warning(f'[security] sid={request.sid} join_user_room rejected')
            emit('room_join_denied', {'reason': 'Session does not match requested user'})
            return
        join_room(f'user_{u.id}')
        sid_to_user[request.sid] = u.id
        emit('joined_room', {'room': f'user_{u.id}'})
        try:
            u.is_online = True
            u.last_seen = datetime.utcnow()
            db.session.commit()
            for c in Contact.query.filter_by(user_id=u.id, is_blocked=False).all():
                socketio.emit('user_online', {'user_id': u.id}, room=f'user_{c.contact_id}')
        except Exception as e:
            db.session.rollback()
            log.error(f'[presence] failed to mark {u.id} online: {e}')

    @socketio.on('join_room')
    def hs_join_room(data):
        data = data if isinstance(data, dict) else {}
        room = str(data.get('room') or '')
        u = _sock_user()
        ok = False
        if u and room.startswith('private_') and len(room) < 100:
            parts = room[len('private_'):].split('_')
            if len(parts) == 2 and u.id in parts:
                other = parts[1] if parts[0] == u.id else parts[0]
                ok = bool(Contact.query.filter_by(user_id=u.id, contact_id=other).first()
                          or Contact.query.filter_by(user_id=other, contact_id=u.id).first())
        if not ok:
            log.warning(f'[security] sid={request.sid} join_room({room[:60]!r}) rejected')
            emit('room_join_denied', {'reason': 'Not allowed to join this room'})
            return
        join_room(room)
        emit('joined_room', {'room': room})

    @socketio.on('send_private_message')
    def hs_send_private_message(data):
        import uuid
        data = data if isinstance(data, dict) else {}
        temp_id = str(data.get('temp_id') or '')[:64]
        content = str(data.get('content') or '').strip()
        receiver_id = str(data.get('receiver_id') or '')
        u = _sock_user()
        if not u or data.get('sender_id') != u.id:
            emit('message_failed', {'temp_id': temp_id, 'error': 'Authentication mismatch'})
            return
        if not content or not receiver_id:
            return
        if len(content) > 20000:
            emit('message_failed', {'temp_id': temp_id, 'error': 'Message too long'})
            return
        if msg_hits.count(u.id, MSG_WINDOW_SEC) >= MSG_BURST:
            emit('message_failed', {'temp_id': temp_id, 'error': 'You are sending too fast. Slow down a little.'})
            return
        msg_hits.hit(u.id, MSG_WINDOW_SEC)
        if not _may_message(u.id, receiver_id):
            emit('message_failed', {'temp_id': temp_id, 'error': 'You can only message people you are connected with'})
            return
        msg_id = str(uuid.uuid4())
        try:
            msg = Message(id=msg_id, user_id=u.id, sender_id=u.id, receiver_id=receiver_id,
                          encrypted_content=content, message_type='chat', is_delivered=True)
            db.session.add(msg)
            db.session.commit()
            created_at = msg.created_at.isoformat()
            log_activity(u.id, 'message_sent', 'text message')
        except Exception as e:
            db.session.rollback()
            log.error(f'Save chat msg failed: {e}')
            emit('message_failed', {'temp_id': temp_id, 'error': 'Could not save message'})
            return
        payload = {'id': msg_id, 'content': content, 'sender_id': u.id,
                   'sender': u.username, 'avatar': u.avatar or '',      # always from the server
                   'receiver_id': receiver_id, 'created_at': created_at, 'temp_id': temp_id}
        emit('receive_message', payload, room=f'user_{receiver_id}')
        emit('receive_message', payload, room=f'user_{u.id}')

    def _typing(event):
        def handler(data):
            data = data if isinstance(data, dict) else {}
            room = str(data.get('room') or '')
            u = _sock_user()
            if not u or not room or room not in sock_rooms():
                return
            if typing_hits.count(request.sid, 5) >= 25:
                return
            typing_hits.hit(request.sid, 5)
            body = {'user_id': u.id}
            if event == 'typing':
                body['username'] = u.username
            emit(event, body, room=room, include_self=False)
        return handler

    socketio.on('typing')(_typing('typing'))
    socketio.on('stop_typing')(_typing('stop_typing'))

    log.info('Security hardening installed')
