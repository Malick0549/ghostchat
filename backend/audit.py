"""
GhostChat · Security audit + admin console backend  (v1)

Adds, without touching the existing routes:
  • richer audit events (severity, failed-login / brute-force detection,
    denied admin access, rate-limit hits, account changes)
  • presence tracking (who is active right now)
  • enforcement: a disabled account is signed out on its next request
  • admin API under /api/admin/console/...  (overview, audit, security,
    users, user detail, email one user, email many, account on/off)

Never logged: message content, passwords, OTP codes, keys.
Installed with one call from flask_app.py:  install_audit(...)
"""
import csv
import html as _html
import io
import json
import os
import re
import threading
import time
import urllib.error
import urllib.request
import uuid
from datetime import datetime, timedelta

from flask import Response, jsonify, request, session
from sqlalchemy import and_, func, or_

from backend.models import db


# ═════════════════════════════════════════════════════════════════════════════
# Model: every email an admin sends (an audit trail of its own)
# ═════════════════════════════════════════════════════════════════════════════
class AdminEmail(db.Model):
    __tablename__ = 'admin_emails'

    id = db.Column(db.String(36), primary_key=True, default=lambda: str(uuid.uuid4()))
    admin_id = db.Column(db.String(36), nullable=True)
    user_id = db.Column(db.String(36), nullable=True)
    to_email = db.Column(db.String(120), nullable=False)
    kind = db.Column(db.String(20), nullable=False)
    subject = db.Column(db.String(200), nullable=False)
    body = db.Column(db.Text, nullable=True)
    status = db.Column(db.String(10), default='sent')      # sent | failed
    created_at = db.Column(db.DateTime, default=datetime.utcnow)


# ═════════════════════════════════════════════════════════════════════════════
# Event catalogue: label, default severity, category
# ═════════════════════════════════════════════════════════════════════════════
EVENTS = {
    # sign-in and account access
    'login':                    ('Signed in',               'info',     'auth'),
    'login_failed':             ('Failed sign-in',          'warning',  'auth'),
    'login_blocked_disabled':   ('Blocked: disabled account', 'warning', 'auth'),
    'login_unverified':         ('Sign-in before verifying email', 'info', 'auth'),
    '2fa_failed':               ('Wrong 2FA code',          'warning',  'auth'),
    'logout':                   ('Signed out',              'info',     'auth'),
    'register':                 ('New account',             'info',     'auth'),
    'email_verified':           ('Email verified',          'info',     'auth'),
    'password_reset_requested': ('Password reset requested', 'warning', 'auth'),
    'password_reset_completed': ('Password reset done',     'warning',  'auth'),
    'password_changed':         ('Password changed',        'warning',  'account'),
    # attacks and abuse
    'brute_force_suspected':    ('Brute-force suspected',   'critical', 'security'),
    'admin_denied':             ('Admin access denied',     'critical', 'security'),
    'rate_limited':             ('Rate limit hit',          'warning',  'security'),
    'csrf_failed':              ('CSRF check failed',       'warning',  'security'),
    'server_error':             ('Server error',            'warning',  'system'),
    # account changes
    'profile_updated':          ('Profile updated',         'info',     'account'),
    'avatar_changed':           ('Photo changed',           'info',     'account'),
    'e2e_key':                  ('Encryption key updated',  'info',     'account'),
    'e2e_backup':               ('Key backup updated',      'info',     'account'),
    # chat
    'contact_request_sent':     ('Contact request sent',    'info',     'chat'),
    'contact_request_accepted': ('Contact request accepted', 'info',    'chat'),
    'contact_request_rejected': ('Contact request declined', 'info',    'chat'),
    'contact_removed':          ('Contact removed',         'info',     'chat'),
    'contact_blocked':          ('Contact blocked',         'warning',  'chat'),
    'message_sent':             ('Message sent',            'info',     'chat'),
    'message_received':         ('Message received',        'info',     'chat'),
    'message_deleted':          ('Message deleted',         'info',     'chat'),
    'message_restored':         ('Delete undone',           'info',     'chat'),
    # admin actions
    'admin_email_sent':         ('Admin emailed a user',    'info',     'admin'),
    'admin_broadcast':          ('Admin sent a broadcast',  'info',     'admin'),
    'user_disabled':            ('Account disabled',        'critical', 'admin'),
    'user_enabled':             ('Account re-enabled',      'warning',  'admin'),
    'audit_cleared':            ('Audit log cleared',       'critical', 'admin'),
    'audit_purged':             ('Old audit entries purged', 'critical', 'admin'),
    'audit_exported':           ('Audit log exported',      'info',     'admin'),
}
CATEGORIES = ['auth', 'security', 'account', 'chat', 'admin', 'system']
SEVERITIES = ['info', 'warning', 'critical']
# Events that justify a (slow) geo lookup; the rest only use the cache.
_LOOKUP_EVENTS = {'login', 'login_failed', 'register', '2fa_failed', 'brute_force_suspected',
                  'login_blocked_disabled', 'password_reset_requested', 'admin_denied'}

KINDS = {
    'guide':    ('Guide',          '#6d5bd0'),
    'notice':   ('Notice',         '#2f7fd1'),
    'warning':  ('Warning',        '#d98a00'),
    'security': ('Security alert', '#d6455d'),
    'custom':   ('Message',        '#5a6073'),
}

CHAT_TYPES = ['chat', 'image', 'audio', 'video']


def _iso(dt):
    return (dt.isoformat() + 'Z') if dt else None


def _csv_safe(v):
    s = '' if v is None else str(v)
    return ("'" + s) if s[:1] in ('=', '+', '-', '@', '\t', '\r') else s


def email_configured():
    return bool(os.environ.get('SENDGRID_API_KEY') or os.environ.get('RESEND_API_KEY')
                or (os.environ.get('SMTP_HOST') and os.environ.get('SMTP_USER') and os.environ.get('SMTP_PASSWORD')))


# ═════════════════════════════════════════════════════════════════════════════
# Email body
# ═════════════════════════════════════════════════════════════════════════════
def build_email(kind, subject, message, username):
    label, color = KINDS.get(kind, KINDS['custom'])
    safe = _html.escape(message.strip())
    paras = ''.join(
        f'<p style="margin:0 0 14px;font-size:15px;line-height:1.6;color:#23262f;">{p.replace(chr(10), "<br>")}</p>'
        for p in re.split(r'\n\s*\n', safe) if p.strip()
    )
    html = f"""<!doctype html><html><body style="margin:0;padding:24px;background:#f2f1f6;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center">
<table role="presentation" width="560" cellpadding="0" cellspacing="0" style="max-width:560px;width:100%;background:#ffffff;border-radius:14px;overflow:hidden;">
<tr><td style="background:#0c0f16;padding:18px 24px;color:#ecebf4;font-size:18px;font-weight:700;">GhostChat</td></tr>
<tr><td style="padding:24px;">
<span style="display:inline-block;background:{color};color:#fff;font-size:12px;font-weight:600;padding:4px 10px;border-radius:999px;margin-bottom:14px;">{_html.escape(label)}</span>
<h1 style="margin:0 0 16px;font-size:20px;color:#14161d;">{_html.escape(subject)}</h1>
<p style="margin:0 0 14px;font-size:15px;color:#23262f;">Hi {_html.escape(username)},</p>
{paras}
</td></tr>
<tr><td style="padding:16px 24px;background:#f7f7fa;color:#7b8092;font-size:12px;line-height:1.5;">
You received this because you have a GhostChat account. GhostChat will never ask for your password or your encryption keys by email.
</td></tr></table></td></tr></table></body></html>"""
    text = f"{label}: {subject}\n\nHi {username},\n\n{message.strip()}\n\n— GhostChat\nGhostChat will never ask for your password or your encryption keys by email."
    return html, text


def _personalize(text, user):
    return (text or '').replace('{{username}}', user.username)


# ═════════════════════════════════════════════════════════════════════════════
def install_audit(app, *, ActivityLog, User, Message, Contact, send_email, require_admin,
                  limiter, admin_limit, socketio, log, db_available=True):
    """Wire everything. Returns (log_activity, geolocate_ip, client_ip) so the
    caller can replace its older helpers with these."""

    # ── client IP ───────────────────────────────────────────────────────────
    def client_ip():
        """TRUSTED_PROXY_HOPS=0 keeps the old behaviour (leftmost X-Forwarded-For).
        Set it to N to use the Nth entry from the right, which a visitor cannot forge."""
        parts = [p.strip() for p in request.headers.get('X-Forwarded-For', '').split(',') if p.strip()]
        try:
            hops = int(os.environ.get('TRUSTED_PROXY_HOPS', '0') or 0)
        except ValueError:
            hops = 0
        if parts:
            ip = parts[-hops] if (hops > 0 and len(parts) >= hops) else parts[0]
        else:
            ip = request.remote_addr or ''
        return ip[:45]

    # ── geolocation with a cache that forgets failures ──────────────────────
    _geo = {}                      # ip -> (text, expires_at)
    _GEO_OK, _GEO_FAIL = 7 * 86400, 600

    def geolocate(ip, lookup=True):
        if not ip or ip in ('127.0.0.1', 'localhost', '::1'):
            return 'Local'
        if re.match(r'^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|fc|fd)', ip):
            return 'Private network'
        hit = _geo.get(ip)
        if hit and hit[1] > time.time():
            return hit[0]
        if not lookup:
            return 'Unknown'
        try:
            with urllib.request.urlopen(f'https://ipapi.co/{ip}/json/', timeout=2.5) as resp:
                data = json.loads(resp.read().decode('utf-8'))
            if data.get('error'):
                raise ValueError(data.get('reason') or 'lookup error')
            loc = ', '.join(p for p in (data.get('city'), data.get('country_name')) if p) or 'Unknown'
            _geo[ip] = (loc, time.time() + (_GEO_OK if loc != 'Unknown' else _GEO_FAIL))
        except Exception:
            loc = 'Unknown'
            _geo[ip] = (loc, time.time() + _GEO_FAIL)
        if len(_geo) > 5000:
            _geo.clear()
        return loc

    def parse_device(ua):
        if not ua:
            return 'Unknown device'
        os_name = ('iPhone' if 'iPhone' in ua else 'iPad' if 'iPad' in ua else 'Android' if 'Android' in ua
                   else 'Windows' if 'Windows' in ua else 'macOS' if 'Mac OS X' in ua
                   else 'Linux' if 'Linux' in ua else 'Unknown OS')
        br = ('Edge' if 'Edg/' in ua else 'Opera' if ('OPR/' in ua or 'Opera' in ua)
              else 'Chrome' if ('Chrome/' in ua and 'Chromium' not in ua) else 'Firefox' if 'Firefox/' in ua
              else 'Safari' if ('Safari/' in ua and 'Chrome/' not in ua) else 'Unknown browser')
        return f'{br} on {os_name}'

    # ── alerts to the admins (throttled) ────────────────────────────────────
    _alert_last = {}

    def alert_admins(event, text):
        emails = [e.strip() for e in os.environ.get('ADMIN_EMAILS', '').split(',') if e.strip()]
        if not emails or not email_configured() or os.environ.get('AUDIT_ALERTS', '1') == '0':
            return
        key = event + ':' + client_ip()
        if time.time() - _alert_last.get(key, 0) < 1800:
            return
        _alert_last[key] = time.time()
        base = request.host_url

        def run():
            try:
                with app.test_request_context('/', base_url=base):
                    for e in emails:
                        h, t = build_email('security', f'GhostChat security alert: {EVENTS[event][0]}', text, 'admin')
                        send_email(subject=f'[GhostChat] Security alert: {EVENTS[event][0]}', recipient=e, html_body=h, text_body=t)
            except Exception as exc:
                log.error(f'Admin alert failed: {exc}')
        threading.Thread(target=run, daemon=True).start()

    # ── the logger ──────────────────────────────────────────────────────────
    def _write(user_id, event_type, description, severity=None, meta=None, lookup=False):
        ip = client_ip()
        sev = severity or EVENTS.get(event_type, ('', 'info', ''))[1]
        db.session.add(ActivityLog(
            user_id=user_id, event_type=event_type[:50], description=(description or '')[:500],
            ip_address=ip, location=geolocate(ip, lookup=lookup),
            device=parse_device(request.headers.get('User-Agent', '')),
            severity=sev, meta=json.dumps(meta) if meta else None,
        ))
        db.session.commit()

    def log_activity(user_id, event_type, description='', severity=None, meta=None):
        if not db_available:
            return
        try:
            _write(user_id, event_type, description, severity, meta, lookup=event_type in _LOOKUP_EVENTS)
            if event_type == 'login_failed':
                _check_brute_force(user_id)
            elif event_type == 'admin_denied':
                alert_admins('admin_denied', description)
        except Exception as exc:
            log.error(f'Audit write failed ({event_type}): {exc}')
            db.session.rollback()

    def _check_brute_force(user_id):
        limit = int(os.environ.get('BRUTE_FORCE_THRESHOLD', '5'))
        since = datetime.utcnow() - timedelta(minutes=15)
        ip = client_ip()
        by_ip = ActivityLog.query.filter(ActivityLog.event_type == 'login_failed',
                                         ActivityLog.ip_address == ip, ActivityLog.created_at >= since).count()
        if by_ip == limit:
            txt = f'{limit} failed sign-ins from {ip} in 15 minutes.'
            _write(None, 'brute_force_suspected', txt, meta={'ip': ip})
            alert_admins('brute_force_suspected', txt)
        if user_id:
            by_user = ActivityLog.query.filter(ActivityLog.event_type == 'login_failed',
                                               ActivityLog.user_id == user_id, ActivityLog.created_at >= since).count()
            if by_user == limit:
                u = db.session.get(User, user_id)
                txt = f'{limit} failed sign-ins on the account "{u.username if u else user_id}" in 15 minutes.'
                _write(user_id, 'brute_force_suspected', txt, meta={'target': user_id})
                alert_admins('brute_force_suspected', txt)

    # ── disabled accounts are signed out; presence is tracked ──────────────
    _status = {}           # uid -> (checked_at, active)
    _touched = {}          # uid -> last write

    @app.before_request
    def _audit_enforce():
        if not db_available:
            return None
        uid = session.get('user_id')
        if not uid or not request.path.startswith('/api/') or request.path == '/api/auth/logout':
            return None
        hit = _status.get(uid)
        if not hit or time.time() - hit[0] > 60:
            try:
                active = db.session.query(User.is_active).filter(User.id == uid).scalar()
            except Exception:
                db.session.rollback()
                active = True
            _status[uid] = (time.time(), active is not False)
            hit = _status[uid]
        if not hit[1]:
            session.clear()
            return jsonify({'error': 'Account is disabled'}), 401
        return None

    _ROUTES = [
        ('PUT', r'^/api/profile$', 'profile_updated', 'Profile details changed'),
        ('PUT', r'^/api/profile/password$', 'password_changed', 'Password changed'),
        ('POST', r'^/api/profile/avatar$', 'avatar_changed', 'Profile photo changed'),
        ('DELETE', r'^/api/contacts/[^/]+$', 'contact_removed', 'Removed a contact'),
        ('POST', r'^/api/contacts/[^/]+/block$', 'contact_blocked', 'Blocked a contact'),
        ('POST', r'^/api/admin/activity-logs/clear$', 'audit_cleared', 'Audit log cleared with the old Clear Logs button'),
    ]

    @app.after_request
    def _audit_after(resp):
        if not db_available or request.method == 'OPTIONS':
            return resp
        try:
            path, status, method = request.path, resp.status_code, request.method
            uid = session.get('user_id')

            # presence (at most one write a minute per user)
            if uid and path.startswith('/api/') and status < 400 and not session.get('pending_2fa'):
                if time.time() - _touched.get(uid, 0) > 60:
                    _touched[uid] = time.time()
                    db.session.query(User).filter(User.id == uid).update({'last_seen': datetime.utcnow()})
                    db.session.commit()

            if not path.startswith('/api/'):
                return resp
            body = resp.get_json(silent=True) if resp.mimetype == 'application/json' else None
            err = ((body or {}).get('error') or '') if isinstance(body, dict) else ''

            if status == 429:
                log_activity(uid, 'rate_limited', f'Too many requests: {method} {path}')
            elif path.startswith('/api/admin') and status in (401, 403):
                log_activity(uid, 'admin_denied', f'Tried to open an admin endpoint: {method} {path}')
            elif status == 403 and 'csrf' in err.lower():
                log_activity(uid, 'csrf_failed', f'{method} {path} rejected: {err[:120]}')
            elif status >= 500:
                log_activity(uid, 'server_error', f'{method} {path} returned {status}')
            elif path == '/api/auth/login' and method == 'POST':
                if status == 401 and 'disabled' in err.lower():
                    log_activity(None, 'login_blocked_disabled', 'Sign-in attempt on a disabled account')
                elif status == 403 and isinstance(body, dict) and body.get('requires_verification'):
                    log_activity(None, 'login_unverified', 'Sign-in before verifying email')
            elif path == '/api/auth/2fa/verify' and method == 'POST' and status in (400, 401, 403):
                log_activity(session.get('pending_2fa_user_id'), '2fa_failed', 'Wrong or expired 2FA code')
            elif 200 <= status < 300:
                for m, rx, ev, desc in _ROUTES:
                    if method == m and re.match(rx, path):
                        log_activity(uid, ev, desc)
                        break
        except Exception as exc:
            log.error(f'Audit after_request failed: {exc}')
            try:
                db.session.rollback()
            except Exception:
                pass
        return resp

    # ═══════════════════════════════════════════════════════════════════════
    # Admin API
    # ═══════════════════════════════════════════════════════════════════════
    P = '/api/admin/console'

    def admin_only(fn):
        def wrapper(*a, **kw):
            admin, err = require_admin()
            if err:
                return err
            if not db_available:
                return jsonify({'error': 'Storage unavailable'}), 503
            return fn(admin, *a, **kw)
        wrapper.__name__ = fn.__name__
        return wrapper

    def sev_of(row):
        return row.severity or EVENTS.get(row.event_type, ('', 'info', ''))[1]

    def ev_row(row, username=None):
        return {
            'id': row.id, 'time': _iso(row.created_at), 'event': row.event_type,
            'label': EVENTS.get(row.event_type, (row.event_type.replace('_', ' ').capitalize(), '', ''))[0],
            'severity': sev_of(row), 'category': EVENTS.get(row.event_type, ('', '', 'system'))[2],
            'user_id': row.user_id, 'username': username, 'description': row.description,
            'ip': row.ip_address, 'location': row.location, 'device': row.device,
        }

    def usernames(ids):
        ids = [i for i in set(ids) if i]
        if not ids:
            return {}
        return {i: n for i, n in db.session.query(User.id, User.username).filter(User.id.in_(ids)).all()}

    def online_filter(now):
        return or_(User.last_seen >= now - timedelta(minutes=5),
                   and_(User.is_online == True, User.last_seen >= now - timedelta(minutes=30)))  # noqa: E712

    def country_of(loc):
        if not loc or loc in ('Unknown', 'Local', 'Private network'):
            return loc or 'Unknown'
        return loc.split(',')[-1].strip()

    # ── overview ────────────────────────────────────────────────────────────
    @app.route(f'{P}/overview', methods=['GET'])
    @admin_only
    def audit_overview(admin):
        now = datetime.utcnow()
        d1, d7, d14 = now - timedelta(days=1), now - timedelta(days=7), now - timedelta(days=14)

        def ev_count(events, since):
            return ActivityLog.query.filter(ActivityLog.event_type.in_(events), ActivityLog.created_at >= since).count()

        totals = {
            'users': User.query.count(),
            'verified': User.query.filter_by(is_verified=True).count(),
            'unverified': User.query.filter_by(is_verified=False).count(),
            'disabled': User.query.filter_by(is_active=False).count(),
            'admins': User.query.filter_by(is_admin=True).count(),
            'two_factor': User.query.filter_by(two_factor_enabled=True).count(),
            'new_24h': User.query.filter(User.created_at >= d1).count(),
            'new_7d': User.query.filter(User.created_at >= d7).count(),
            'online_now': User.query.filter(online_filter(now)).count(),
            'active_24h': User.query.filter(User.last_seen >= d1).count(),
            'active_7d': User.query.filter(User.last_seen >= d7).count(),
            'messages_total': Message.query.filter(Message.message_type.in_(CHAT_TYPES)).count(),
            'messages_24h': Message.query.filter(Message.message_type.in_(CHAT_TYPES), Message.created_at >= d1).count(),
            'logins_24h': ev_count(['login'], d1),
            'failed_logins_24h': ev_count(['login_failed'], d1),
            'critical_24h': ActivityLog.query.filter(ActivityLog.created_at >= d1, or_(
                ActivityLog.severity == 'critical',
                and_(ActivityLog.severity.is_(None), ActivityLog.event_type.in_(
                    [e for e, v in EVENTS.items() if v[1] == 'critical'])))).count(),
            'emails_sent': AdminEmail.query.filter_by(status='sent').count(),
        }

        # 14-day trend
        rows = (db.session.query(func.date(ActivityLog.created_at), ActivityLog.event_type, func.count(ActivityLog.id))
                .filter(ActivityLog.created_at >= d14,
                        ActivityLog.event_type.in_(['login', 'login_failed', 'register', 'message_sent']))
                .group_by(func.date(ActivityLog.created_at), ActivityLog.event_type).all())
        days = [(now - timedelta(days=i)).date().isoformat() for i in range(13, -1, -1)]
        series = {k: {d: 0 for d in days} for k in ('login', 'login_failed', 'register', 'message_sent')}
        for d, ev, n in rows:
            d = str(d)[:10]
            if d in series[ev]:
                series[ev][d] = n
        trend = {'days': days, **{k: [v[d] for d in days] for k, v in series.items()}}

        # where users are
        locs = (db.session.query(User.last_location, func.count(User.id))
                .filter(User.last_location.isnot(None)).group_by(User.last_location).all())
        by_country = {}
        for loc, n in locs:
            c = country_of(loc)
            by_country[c] = by_country.get(c, 0) + n
        countries = sorted(({'country': c, 'users': n} for c, n in by_country.items()), key=lambda x: -x['users'])[:10]

        attention = (ActivityLog.query.filter(ActivityLog.created_at >= d7).order_by(ActivityLog.created_at.desc())
                     .filter(or_(ActivityLog.severity.in_(['critical', 'warning']),
                                 and_(ActivityLog.severity.is_(None), ActivityLog.event_type.in_(
                                     [e for e, v in EVENTS.items() if v[1] != 'info'])))).limit(12).all())
        names = usernames([r.user_id for r in attention])
        return jsonify({'success': True, 'totals': totals, 'trend': trend, 'countries': countries,
                        'attention': [ev_row(r, names.get(r.user_id)) for r in attention],
                        'email_configured': email_configured(), 'generated': _iso(now)})

    # ── audit log ───────────────────────────────────────────────────────────
    def audit_query():
        a = request.args
        q = db.session.query(ActivityLog, User.username).outerjoin(User, User.id == ActivityLog.user_id)
        if a.get('event_type'):
            q = q.filter(ActivityLog.event_type.in_([e for e in a['event_type'].split(',') if e]))
        if a.get('category') in CATEGORIES:
            q = q.filter(ActivityLog.event_type.in_([e for e, v in EVENTS.items() if v[2] == a['category']]))
        if a.get('severity') in SEVERITIES:
            sev = a['severity']
            q = q.filter(or_(ActivityLog.severity == sev, and_(ActivityLog.severity.is_(None),
                         ActivityLog.event_type.in_([e for e, v in EVENTS.items() if v[1] == sev]))))
        if a.get('user_id'):
            q = q.filter(ActivityLog.user_id == a['user_id'])
        if a.get('ip'):
            q = q.filter(ActivityLog.ip_address == a['ip'].strip())
        if a.get('hours', type=int):
            q = q.filter(ActivityLog.created_at >= datetime.utcnow() - timedelta(hours=min(a.get('hours', type=int), 24 * 365)))
        for key, op in (('date_from', '>='), ('date_to', '<')):
            if a.get(key):
                try:
                    d = datetime.strptime(a[key][:10], '%Y-%m-%d') + (timedelta(days=1) if key == 'date_to' else timedelta())
                    q = q.filter(ActivityLog.created_at >= d if op == '>=' else ActivityLog.created_at < d)
                except ValueError:
                    pass
        if a.get('q'):
            like = f"%{a['q'].strip()[:80]}%"
            q = q.filter(or_(ActivityLog.description.ilike(like), ActivityLog.ip_address.ilike(like),
                             ActivityLog.location.ilike(like), ActivityLog.device.ilike(like),
                             User.username.ilike(like), ActivityLog.event_type.ilike(like)))
        return q.order_by(ActivityLog.created_at.desc())

    @app.route(f'{P}/audit', methods=['GET'])
    @admin_only
    def audit_list(admin):
        q = audit_query()
        total = q.count()
        limit = min(request.args.get('limit', 50, type=int), 200)
        offset = max(request.args.get('offset', 0, type=int), 0)
        rows = q.offset(offset).limit(limit).all()
        return jsonify({'success': True, 'total': total, 'limit': limit, 'offset': offset,
                        'events': [ev_row(r, n) for r, n in rows],
                        'catalogue': {k: {'label': v[0], 'severity': v[1], 'category': v[2]} for k, v in EVENTS.items()}})

    @app.route(f'{P}/audit.csv', methods=['GET'])
    @admin_only
    def audit_csv(admin):
        rows = audit_query().limit(5000).all()
        buf = io.StringIO()
        w = csv.writer(buf)
        w.writerow(['time_utc', 'severity', 'event', 'user', 'description', 'ip', 'location', 'device'])
        for r, n in rows:
            e = ev_row(r, n)
            w.writerow([_csv_safe(x) for x in (e['time'], e['severity'], e['event'], e['username'], e['description'],
                                               e['ip'], e['location'], e['device'])])
        log_activity(admin.id, 'audit_exported', f'{admin.username} exported {len(rows)} audit rows')
        return Response(buf.getvalue(), mimetype='text/csv',
                        headers={'Content-Disposition': 'attachment; filename=ghostchat-audit.csv'})

    @app.route(f'{P}/audit/purge', methods=['POST'])
    @limiter.limit(admin_limit)
    @admin_only
    def audit_purge(admin):
        data = request.get_json(silent=True) or {}
        days = int(data.get('days') or 0)
        if days < 30 or data.get('confirm') is not True:
            return jsonify({'error': 'Send {"days": 30 or more, "confirm": true}. Newer entries are never purged.'}), 400
        cutoff = datetime.utcnow() - timedelta(days=days)
        n = ActivityLog.query.filter(ActivityLog.created_at < cutoff).delete(synchronize_session=False)
        db.session.commit()
        log_activity(admin.id, 'audit_purged', f'{admin.username} purged {n} entries older than {days} days')
        return jsonify({'success': True, 'purged': n})

    # ── security view ───────────────────────────────────────────────────────
    @app.route(f'{P}/security', methods=['GET'])
    @admin_only
    def audit_security(admin):
        now = datetime.utcnow()
        d1, d7 = now - timedelta(days=1), now - timedelta(days=7)
        failed = ActivityLog.query.filter(ActivityLog.event_type == 'login_failed', ActivityLog.created_at >= d1).all()
        by_ip, by_user = {}, {}
        for r in failed:
            m = re.search(r'for "(.*)"', r.description or '')
            tried = m.group(1) if m else None
            e = by_ip.setdefault(r.ip_address or '?', {'ip': r.ip_address, 'location': r.location, 'count': 0,
                                                       'last': None, 'tried': set()})
            e['count'] += 1
            e['last'] = max(e['last'] or r.created_at, r.created_at)
            if tried:
                e['tried'].add(tried)
                by_user[tried] = by_user.get(tried, 0) + 1
        top_ips = sorted(by_ip.values(), key=lambda x: -x['count'])[:15]
        for e in top_ips:
            e['last'] = _iso(e['last'])
            e['tried'] = sorted(e['tried'])[:6]
        top_targets = sorted(({'name': k, 'count': v} for k, v in by_user.items()), key=lambda x: -x['count'])[:10]

        def recent(events, n=15, since=d7):
            rows = (ActivityLog.query.filter(ActivityLog.event_type.in_(events), ActivityLog.created_at >= since)
                    .order_by(ActivityLog.created_at.desc()).limit(n).all())
            names = usernames([r.user_id for r in rows])
            return [ev_row(r, names.get(r.user_id)) for r in rows]

        admins = [{'id': u.id, 'username': u.username, 'email': u.email, 'last_login': _iso(u.last_login),
                   'last_ip': u.last_ip, 'location': u.last_location, 'two_factor': bool(u.two_factor_enabled)}
                  for u in User.query.filter_by(is_admin=True).all()]
        hops = os.environ.get('TRUSTED_PROXY_HOPS', '0')
        checks = [
            {'ok': email_configured(), 'text': 'Email sending is configured' if email_configured()
             else 'Email is not configured: warnings, guides and 2FA codes cannot be delivered (set RESEND_API_KEY and MAIL_FROM).'},
            {'ok': all(a['two_factor'] for a in admins) and bool(admins),
             'text': 'Every admin has two-factor sign-in on' if admins and all(a['two_factor'] for a in admins)
             else 'Turn on two-factor sign-in for every admin account (Profile > Two-Factor).'},
            {'ok': hops != '0', 'text': f'Client IPs use the {hops} entry from the right of X-Forwarded-For' if hops != '0'
             else 'IP addresses are read from the first X-Forwarded-For entry, which a visitor can fake. Open Diagnostics, then set TRUSTED_PROXY_HOPS.'},
            {'ok': bool(os.environ.get('ADMIN_EMAILS')), 'text': 'Admins get an email on brute-force and admin-denied alerts'
             if os.environ.get('ADMIN_EMAILS') else 'Set ADMIN_EMAILS so alerts reach you by email.'},
        ]
        return jsonify({'success': True, 'failed_24h': len(failed), 'top_ips': top_ips, 'top_targets': top_targets,
                        'brute_force': recent(['brute_force_suspected'], 20),
                        'admin_denied': recent(['admin_denied'], 20),
                        'blocked_logins': recent(['login_blocked_disabled', '2fa_failed'], 20),
                        'rate_limited': recent(['rate_limited', 'csrf_failed'], 20),
                        'changes': recent(['password_changed', 'password_reset_completed', 'user_disabled', 'user_enabled',
                                           'audit_cleared', 'audit_purged'], 20, d7 - timedelta(days=23)),
                        'admins': admins, 'checks': checks,
                        'disabled_accounts': [{'id': u.id, 'username': u.username, 'email': u.email}
                                              for u in User.query.filter_by(is_active=False).limit(50).all()]})

    @app.route(f'{P}/diagnostics/ip', methods=['GET'])
    @admin_only
    def audit_diag_ip(admin):
        return jsonify({'success': True, 'x_forwarded_for': request.headers.get('X-Forwarded-For'),
                        'remote_addr': request.remote_addr, 'derived_ip': client_ip(),
                        'trusted_proxy_hops': os.environ.get('TRUSTED_PROXY_HOPS', '0'),
                        'https': request.is_secure or request.headers.get('X-Forwarded-Proto') == 'https'})

    # ── users ───────────────────────────────────────────────────────────────
    def user_row(u, sent=None, fails=None):
        now = datetime.utcnow()
        online = bool(u.last_seen and (u.last_seen >= now - timedelta(minutes=5) or
                                       (u.is_online and u.last_seen >= now - timedelta(minutes=30))))
        return {'id': u.id, 'username': u.username, 'email': u.email, 'is_admin': bool(u.is_admin),
                'is_active': u.is_active is not False, 'is_verified': bool(u.is_verified),
                'two_factor': bool(u.two_factor_enabled), 'online': online,
                'created_at': _iso(u.created_at), 'last_login': _iso(u.last_login), 'last_seen': _iso(u.last_seen),
                'last_ip': u.last_ip, 'location': u.last_location, 'device': u.last_device,
                'messages_sent': sent, 'failed_logins_7d': fails}

    @app.route(f'{P}/users', methods=['GET'])
    @admin_only
    def audit_users(admin):
        a = request.args
        now = datetime.utcnow()
        q = User.query
        s = a.get('status', 'all')
        if s == 'online':
            q = q.filter(online_filter(now))
        elif s == 'disabled':
            q = q.filter(User.is_active == False)  # noqa: E712
        elif s == 'unverified':
            q = q.filter(User.is_verified == False)  # noqa: E712
        elif s == 'admin':
            q = q.filter(User.is_admin == True)  # noqa: E712
        elif s == 'no2fa':
            q = q.filter(or_(User.two_factor_enabled == False, User.two_factor_enabled.is_(None)))  # noqa: E712
        elif s == 'new7d':
            q = q.filter(User.created_at >= now - timedelta(days=7))
        if a.get('q'):
            like = f"%{a['q'].strip()[:80]}%"
            q = q.filter(or_(User.username.ilike(like), User.email.ilike(like), User.last_ip.ilike(like),
                             User.last_location.ilike(like)))
        order = {'seen': User.last_seen.desc(), 'login': User.last_login.desc(), 'name': User.username.asc()}.get(
            a.get('sort'), User.created_at.desc())
        total = q.count()
        limit = min(a.get('limit', 50, type=int), 200)
        users = q.order_by(order).offset(max(a.get('offset', 0, type=int), 0)).limit(limit).all()
        ids = [u.id for u in users]
        sent = dict(db.session.query(Message.sender_id, func.count(Message.id))
                    .filter(Message.sender_id.in_(ids), Message.message_type.in_(CHAT_TYPES))
                    .group_by(Message.sender_id).all()) if ids else {}
        fails = dict(db.session.query(ActivityLog.user_id, func.count(ActivityLog.id))
                     .filter(ActivityLog.user_id.in_(ids), ActivityLog.event_type == 'login_failed',
                             ActivityLog.created_at >= now - timedelta(days=7))
                     .group_by(ActivityLog.user_id).all()) if ids else {}
        return jsonify({'success': True, 'total': total, 'users': [user_row(u, sent.get(u.id, 0), fails.get(u.id, 0)) for u in users]})

    @app.route(f'{P}/users/<uid>', methods=['GET'])
    @admin_only
    def audit_user_detail(admin, uid):
        u = db.session.get(User, uid)
        if not u:
            return jsonify({'error': 'User not found'}), 404
        now = datetime.utcnow()
        sent = Message.query.filter(Message.sender_id == uid, Message.message_type.in_(CHAT_TYPES)).count()
        recv = Message.query.filter(Message.receiver_id == uid, Message.message_type.in_(CHAT_TYPES)).count()
        contacts = Contact.query.filter_by(user_id=uid).count()
        events = (ActivityLog.query.filter_by(user_id=uid).order_by(ActivityLog.created_at.desc()).limit(60).all())
        ips = (db.session.query(ActivityLog.ip_address, ActivityLog.location, func.count(ActivityLog.id), func.max(ActivityLog.created_at))
               .filter(ActivityLog.user_id == uid, ActivityLog.ip_address.isnot(None))
               .group_by(ActivityLog.ip_address, ActivityLog.location).order_by(func.max(ActivityLog.created_at).desc()).limit(10).all())
        devices = (db.session.query(ActivityLog.device, func.count(ActivityLog.id))
                   .filter(ActivityLog.user_id == uid, ActivityLog.device.isnot(None))
                   .group_by(ActivityLog.device).order_by(func.count(ActivityLog.id).desc()).limit(6).all())
        fails = ActivityLog.query.filter(ActivityLog.user_id == uid, ActivityLog.event_type == 'login_failed',
                                         ActivityLog.created_at >= now - timedelta(days=7)).count()
        mails = AdminEmail.query.filter_by(user_id=uid).order_by(AdminEmail.created_at.desc()).limit(15).all()
        d = user_row(u, sent, fails)
        d.update({'messages_received': recv, 'contacts': contacts, 'about': u.about, 'phone': u.phone})
        return jsonify({'success': True, 'user': d,
                        'events': [ev_row(r, u.username) for r in events],
                        'ips': [{'ip': i, 'location': l, 'count': c, 'last': _iso(t)} for i, l, c, t in ips],
                        'devices': [{'device': dv, 'count': c} for dv, c in devices],
                        'emails': [{'id': m.id, 'time': _iso(m.created_at), 'kind': m.kind, 'subject': m.subject, 'status': m.status}
                                   for m in mails]})

    # ── email ───────────────────────────────────────────────────────────────
    def clean_mail(data):
        kind = data.get('kind') if data.get('kind') in KINDS else 'custom'
        subject = re.sub(r'[\r\n]+', ' ', (data.get('subject') or '')).strip()
        message = (data.get('message') or '').strip()
        if not (3 <= len(subject) <= 120):
            return None, 'The subject needs 3 to 120 characters.'
        if not (5 <= len(message) <= 5000):
            return None, 'The message needs 5 to 5000 characters.'
        return (kind, subject, message), None

    def deliver(admin, user, kind, subject, message):
        subj, msg = _personalize(subject, user), _personalize(message, user)
        h, t = build_email(kind, subj, msg, user.username)
        try:
            ok = bool(send_email(subject=f'[GhostChat] {subj}', recipient=user.email, html_body=h, text_body=t))
        except Exception as exc:
            log.error(f'Admin email failed: {exc}')
            ok = False
        db.session.add(AdminEmail(admin_id=admin.id, user_id=user.id, to_email=user.email, kind=kind,
                                  subject=subj[:200], body=msg, status='sent' if ok else 'failed'))
        db.session.commit()
        return ok

    @app.route(f'{P}/users/<uid>/email', methods=['POST'])
    @limiter.limit(admin_limit)
    @admin_only
    def audit_email_user(admin, uid):
        u = db.session.get(User, uid)
        if not u:
            return jsonify({'error': 'User not found'}), 404
        parsed, err = clean_mail(request.get_json(silent=True) or {})
        if err:
            return jsonify({'error': err}), 400
        kind, subject, message = parsed
        ok = deliver(admin, u, kind, subject, message)
        log_activity(admin.id, 'admin_email_sent',
                     f'{admin.username} emailed {u.username} ({kind}): {subject[:80]} [{"sent" if ok else "FAILED"}]',
                     meta={'to': u.id})
        if not ok:
            return jsonify({'success': False, 'error': 'The email could not be delivered. Check the email settings on the server.'}), 502
        return jsonify({'success': True})

    def audience_users(name, ids):
        now = datetime.utcnow()
        q = User.query.filter(User.is_active == True)  # noqa: E712
        if name == 'ids':
            q = q.filter(User.id.in_(ids or []))
        elif name == 'all_verified':
            q = q.filter(User.is_verified == True)  # noqa: E712
        elif name == 'active_7d':
            q = q.filter(User.last_seen >= now - timedelta(days=7))
        elif name == 'no2fa':
            q = q.filter(User.is_verified == True, or_(User.two_factor_enabled == False, User.two_factor_enabled.is_(None)))  # noqa: E712
        else:
            return None
        return q.limit(300).all()

    @app.route(f'{P}/email/broadcast', methods=['POST'])
    @limiter.limit('5 per hour')
    @admin_only
    def audit_broadcast(admin):
        data = request.get_json(silent=True) or {}
        users = audience_users(data.get('audience'), data.get('ids'))
        if users is None:
            return jsonify({'error': 'Choose who should receive it.'}), 400
        if data.get('dry_run'):
            return jsonify({'success': True, 'count': len(users)})
        parsed, err = clean_mail(data)
        if err:
            return jsonify({'error': err}), 400
        if data.get('confirm') is not True:
            return jsonify({'error': 'Confirmation required'}), 400
        if not users:
            return jsonify({'error': 'No one matches that audience.'}), 400
        if not email_configured():
            return jsonify({'error': 'Email is not configured on the server.'}), 400
        kind, subject, message = parsed
        ids = [u.id for u in users]
        admin_id, admin_name, base = admin.id, admin.username, request.host_url
        log_activity(admin_id, 'admin_broadcast',
                     f'{admin_name} started a {kind} broadcast to {len(ids)} users: {subject[:80]}')

        def run():
            ok_n = fail_n = 0
            try:
                with app.test_request_context('/', base_url=base):
                    adm = db.session.get(User, admin_id)
                    for i in ids:
                        u = db.session.get(User, i)
                        if not u:
                            continue
                        if deliver(adm, u, kind, subject, message):
                            ok_n += 1
                        else:
                            fail_n += 1
                        time.sleep(0.25)
                    log_activity(admin_id, 'admin_broadcast', f'Broadcast finished: {ok_n} sent, {fail_n} failed')
            except Exception as exc:
                log.error(f'Broadcast crashed: {exc}')

        if socketio is not None and hasattr(socketio, 'start_background_task'):
            socketio.start_background_task(run)
        else:
            threading.Thread(target=run, daemon=True).start()
        return jsonify({'success': True, 'queued': len(ids)})

    @app.route(f'{P}/emails', methods=['GET'])
    @admin_only
    def audit_emails(admin):
        limit = min(request.args.get('limit', 50, type=int), 200)
        offset = max(request.args.get('offset', 0, type=int), 0)
        q = AdminEmail.query.order_by(AdminEmail.created_at.desc())
        rows = q.offset(offset).limit(limit).all()
        names = usernames([r.admin_id for r in rows] + [r.user_id for r in rows])
        return jsonify({'success': True, 'total': q.count(), 'emails': [
            {'id': r.id, 'time': _iso(r.created_at), 'kind': r.kind, 'subject': r.subject, 'status': r.status,
             'to': r.to_email, 'user': names.get(r.user_id), 'admin': names.get(r.admin_id), 'body': r.body} for r in rows]})


    # ── email settings check (shows the real error instead of "check settings") ──
    def probe_email(to):
        import smtplib, socket, ssl as _ssl
        from email.message import EmailMessage
        mail_from = os.environ.get('MAIL_FROM')
        subject = 'GhostChat email test'
        text = 'If you can read this, GhostChat can send email.'
        html = '<p>If you can read this, GhostChat can send email.</p>'
        out = []

        def http(name, url, headers, body, ok_codes, hint_for):
            try:
                req = urllib.request.Request(url, data=json.dumps(body).encode('utf-8'), method='POST', headers=headers)
                with urllib.request.urlopen(req, timeout=12) as r:
                    good = r.status in ok_codes
                    out.append({'provider': name, 'ok': good, 'detail': f'HTTP {r.status}', 'hint': '' if good else 'Unexpected answer from the provider.'})
            except urllib.error.HTTPError as e:
                try:
                    msg = e.read().decode('utf-8', 'replace')[:300]
                except Exception:
                    msg = ''
                out.append({'provider': name, 'ok': False, 'detail': f'HTTP {e.code}: {msg}', 'hint': hint_for(e.code, msg)})
            except Exception as e:
                out.append({'provider': name, 'ok': False, 'detail': str(e)[:300], 'hint': 'The server could not reach the provider.'})

        if os.environ.get('RESEND_API_KEY'):
            frm = mail_from or 'onboarding@resend.dev'
            def rh(code, msg):
                if code in (401, 403) and ('resend.dev' in frm or 'only send' in msg.lower() or 'verify' in msg.lower()):
                    return ('Resend only lets the test sender (onboarding@resend.dev) email YOUR OWN Resend account address. '
                            'Verify a domain at resend.com/domains, then set MAIL_FROM to an address on it, e.g. GhostChat <noreply@yourdomain.com>.')
                if code == 401:
                    return 'The RESEND_API_KEY is wrong or was revoked. Create a new key and update it on Render.'
                if code == 422:
                    return 'MAIL_FROM is not a valid sender. Use the form  GhostChat <noreply@yourdomain.com>  with a verified domain.'
                return 'See the message above.'
            http('Resend', 'https://api.resend.com/emails',
                 {'Authorization': 'Bearer ' + os.environ['RESEND_API_KEY'], 'Content-Type': 'application/json'},
                 {'from': frm, 'to': [to], 'subject': subject, 'html': html, 'text': text}, range(200, 300), rh)
        if os.environ.get('SENDGRID_API_KEY'):
            def sh(code, msg):
                if not mail_from:
                    return 'MAIL_FROM is missing. Set it to your verified SendGrid sender.'
                if code in (401, 403):
                    return 'The SendGrid key is wrong, or the sender in MAIL_FROM is not verified in SendGrid.'
                return 'See the message above.'
            if mail_from:
                http('SendGrid', 'https://api.sendgrid.com/v3/mail/send',
                     {'Authorization': 'Bearer ' + os.environ['SENDGRID_API_KEY'], 'Content-Type': 'application/json'},
                     {'personalizations': [{'to': [{'email': to}]}], 'from': {'email': mail_from}, 'subject': subject,
                      'content': [{'type': 'text/plain', 'value': text}, {'type': 'text/html', 'value': html}]}, (202,), sh)
            else:
                out.append({'provider': 'SendGrid', 'ok': False, 'detail': 'MAIL_FROM is not set', 'hint': sh(0, '')})
        host = os.environ.get('SMTP_HOST')
        if host:
            port = int(os.environ.get('SMTP_PORT', '587') or 587)
            try:
                socket.create_connection((host, port), timeout=7).close()
                try:
                    msg = EmailMessage(); msg['Subject'] = subject; msg['From'] = mail_from or os.environ.get('SMTP_USER'); msg['To'] = to
                    msg.set_content(text)
                    if os.environ.get('SMTP_USE_SSL', '0').lower() in ('1', 'true', 'yes'):
                        with smtplib.SMTP_SSL(host, port, context=_ssl.create_default_context(), timeout=10) as sm:
                            sm.login(os.environ.get('SMTP_USER', ''), os.environ.get('SMTP_PASSWORD', '')); sm.send_message(msg)
                    else:
                        with smtplib.SMTP(host, port, timeout=10) as sm:
                            if os.environ.get('SMTP_USE_TLS', '1').lower() in ('1', 'true', 'yes'):
                                sm.starttls(context=_ssl.create_default_context())
                            sm.login(os.environ.get('SMTP_USER', ''), os.environ.get('SMTP_PASSWORD', '')); sm.send_message(msg)
                    out.append({'provider': f'SMTP {host}:{port}', 'ok': True, 'detail': 'sent', 'hint': ''})
                except Exception as e:
                    out.append({'provider': f'SMTP {host}:{port}', 'ok': False, 'detail': str(e)[:300],
                                'hint': 'Connected, but the server refused the login or the message. Check SMTP_USER, SMTP_PASSWORD and MAIL_FROM.'})
            except Exception as e:
                out.append({'provider': f'SMTP {host}:{port}', 'ok': False, 'detail': str(e)[:300],
                            'hint': 'Could not connect. Render free web services block outbound SMTP (ports 25, 465, 587). '
                                    'Use Resend or SendGrid (they work over HTTPS), or upgrade the Render plan.'})
        if not out:
            out.append({'provider': 'none', 'ok': False, 'detail': 'No email provider is configured',
                        'hint': 'Add RESEND_API_KEY and MAIL_FROM on Render (Environment tab), then redeploy.'})
        return {'from': mail_from or ('onboarding@resend.dev' if os.environ.get('RESEND_API_KEY') else None), 'results': out}

    @app.route(f'{P}/email/test', methods=['POST'])
    @limiter.limit(admin_limit)
    @admin_only
    def audit_email_test(admin):
        r = probe_email(admin.email)
        log_activity(admin.id, 'admin_email_sent', f'{admin.username} ran an email settings test: ' +
                     ('OK' if any(x['ok'] for x in r['results']) else 'FAILED'))
        return jsonify({'success': True, 'to': admin.email, **r})

    # ── account on/off ──────────────────────────────────────────────────────
    @app.route(f'{P}/users/<uid>/status', methods=['POST'])
    @limiter.limit(admin_limit)
    @admin_only
    def audit_user_status(admin, uid):
        data = request.get_json(silent=True) or {}
        u = db.session.get(User, uid)
        if not u:
            return jsonify({'error': 'User not found'}), 404
        if u.id == admin.id:
            return jsonify({'error': 'You cannot disable your own account.'}), 400
        if u.is_admin:
            return jsonify({'error': 'Admin accounts cannot be disabled here.'}), 400
        active = bool(data.get('active'))
        reason = (data.get('reason') or '').strip()[:200]
        if not active and len(reason) < 3:
            return jsonify({'error': 'Write a short reason. It is kept in the audit log.'}), 400
        u.is_active = active
        if not active:
            u.is_online = False
        db.session.commit()
        _status[u.id] = (time.time(), active)
        log_activity(admin.id, 'user_enabled' if active else 'user_disabled',
                     f'{admin.username} {"re-enabled" if active else "disabled"} {u.username}' + (f': {reason}' if reason else ''),
                     meta={'target': u.id})
        notified = None
        if data.get('notify'):
            subj = 'Your GhostChat account is active again' if active else 'Your GhostChat account has been suspended'
            body = ('Your account is active again and you can sign in as usual.' if active else
                    'Your account has been suspended.' + (f'\n\nReason: {reason}' if reason else '') +
                    '\n\nIf you think this is a mistake, reply to the person who runs this service.')
            notified = deliver(admin, u, 'notice' if active else 'security', subj, body)
        return jsonify({'success': True, 'is_active': active, 'notified': notified})

    log.info('Audit + admin console installed')
    return log_activity, geolocate, client_ip