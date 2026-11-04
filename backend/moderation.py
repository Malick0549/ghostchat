"""
GhostChat :: backend/moderation.py
Admin moderation tools + user abuse reports.

Admin (all under /api/admin/console, admin only, rate limited, every action audit-logged):
  POST   /users/<id>/verify      {verified: true|false, reason?, notify?}
  POST   /users/<id>/suspend     {days: 0-365 (0 = until lifted), reason, notify?}
  POST   /users/<id>/unsuspend   {notify?}
  POST   /users/<id>/delete      {confirm: "<username>", reason?, notify?}      (permanent)
  GET    /reports?status=open|actioned|dismissed|all
  GET    /reports/summary
  POST   /reports/<id>/resolve   {action: dismiss|warn|suspend|delete|none, note, days?, notify_reporter?}

Users:
  POST   /api/reports            {reported_id, reason, details?, evidence?, block?}
  GET    /api/reports/mine

Messages are end-to-end encrypted, so the server cannot read them. A reporter can
choose to paste the text of what they received as `evidence`; nothing is attached
automatically.
"""
import re
import threading
import time
import uuid
from datetime import datetime, timedelta

from flask import jsonify, request, session

from backend.models import db
from backend import audit as _audit

REASONS = {
    'harassment':    'Harassment or bullying',
    'spam':          'Spam or unwanted messages',
    'scam':          'Scam or fraud',
    'hate':          'Hate or threats',
    'inappropriate': 'Inappropriate or explicit content',
    'impersonation': 'Pretending to be someone else',
    'other':         'Something else',
}


class Suspension(db.Model):
    __tablename__ = 'suspensions'
    user_id = db.Column(db.String(36), primary_key=True)
    until = db.Column(db.DateTime, nullable=True)            # None = until an admin lifts it
    reason = db.Column(db.String(200), nullable=True)
    admin_id = db.Column(db.String(36), nullable=True)
    created_at = db.Column(db.DateTime, default=datetime.utcnow)


class Report(db.Model):
    __tablename__ = 'reports'
    id = db.Column(db.String(36), primary_key=True, default=lambda: str(uuid.uuid4()))
    reporter_id = db.Column(db.String(36), nullable=True, index=True)     # no foreign keys on purpose:
    reporter_name = db.Column(db.String(80), nullable=True)               # reports must outlive deleted users
    reported_id = db.Column(db.String(36), nullable=False, index=True)
    reported_name = db.Column(db.String(80), nullable=True)
    reason = db.Column(db.String(20), nullable=False)
    details = db.Column(db.Text, nullable=True)
    evidence = db.Column(db.Text, nullable=True)
    status = db.Column(db.String(12), default='open', index=True)         # open | actioned | dismissed
    action = db.Column(db.String(20), nullable=True)
    admin_note = db.Column(db.String(500), nullable=True)
    resolved_by = db.Column(db.String(36), nullable=True)
    resolved_at = db.Column(db.DateTime, nullable=True)
    created_at = db.Column(db.DateTime, default=datetime.utcnow)


_audit.EVENTS.update({
    'user_verified':     ('Account marked verified',   'warning',  'admin'),
    'user_unverified':   ('Account marked unverified', 'warning',  'admin'),
    'user_suspended':    ('Account suspended',         'critical', 'admin'),
    'user_unsuspended':  ('Suspension lifted',         'warning',  'admin'),
    'user_deleted':      ('Account deleted',           'critical', 'admin'),
    'user_reported':     ('User reported',             'warning',  'chat'),
    'report_resolved':   ('Report resolved',           'info',     'admin'),
})


def _iso(dt):
    return dt.isoformat() + 'Z' if dt else None


def install_moderation(app, *, User, Message, Contact, ActivityLog, send_email, require_admin,
                       require_auth, limiter, admin_limit, socketio, log, log_activity,
                       sid_to_user, db_available=True):
    P = '/api/admin/console'
    _last_alert = {'t': 0.0}

    # ── helpers ─────────────────────────────────────────────────────────────
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

    def drop_sockets(uid):
        try:
            for sid, u in list(sid_to_user.items()):
                if u == uid:
                    sid_to_user.pop(sid, None)
                    socketio.server.disconnect(sid)
        except Exception as e:
            log.warning(f'[moderation] could not drop sockets for {uid}: {e}')

    def mail(admin, user, kind, subject, message):
        """Send a branded email and keep it in the admin email history."""
        try:
            h, t = _audit.build_email(kind, subject, message, user.username)
            ok = bool(send_email(subject=f'[GhostChat] {subject}', recipient=user.email, html_body=h, text_body=t))
        except Exception as exc:
            log.error(f'[moderation] mail failed: {exc}')
            ok = False
        try:
            db.session.add(_audit.AdminEmail(admin_id=admin.id, user_id=user.id, to_email=user.email, kind=kind,
                                             subject=subject[:200], body=message, status='sent' if ok else 'failed'))
            db.session.commit()
        except Exception:
            db.session.rollback()
        return ok

    def lift(uid, set_active=True):
        s = db.session.get(Suspension, uid)
        if s:
            db.session.delete(s)
        if set_active:
            u = db.session.get(User, uid)
            if u:
                u.is_active = True
        db.session.commit()

    def human_until(s):
        return s.until.strftime('%d %b %Y, %H:%M UTC') if s and s.until else 'until an administrator lifts it'

    def do_suspend(admin, u, days, reason, notify):
        until = datetime.utcnow() + timedelta(days=days) if days else None
        s = db.session.get(Suspension, u.id) or Suspension(user_id=u.id)
        s.until, s.reason, s.admin_id, s.created_at = until, reason[:200], admin.id, datetime.utcnow()
        db.session.add(s)
        u.is_active = False
        u.is_online = False
        db.session.commit()
        drop_sockets(u.id)
        log_activity(admin.id, 'user_suspended',
                     f'{admin.username} suspended {u.username} ({"for %d day(s)" % days if days else "until lifted"}): {reason}',
                     meta={'target': u.id})
        notified = None
        if notify:
            when = f'until {human_until(s)}' if days else 'until an administrator lifts it'
            notified = mail(admin, u, 'security', 'Your GhostChat account has been suspended',
                            f'Your account is suspended {when}.\n\nReason: {reason}\n\n'
                            'If you think this is a mistake, contact the person who runs this service.')
        return notified

    def do_delete(admin, u, reason, notify):
        uid, name, email = u.id, u.username, u.email
        notified = None
        if notify:
            notified = mail(admin, u, 'security', 'Your GhostChat account has been deleted',
                            'Your account and its messages have been permanently deleted.' +
                            (f'\n\nReason: {reason}' if reason else ''))
        drop_sockets(uid)
        try:
            Message.query.filter(db.or_(Message.user_id == uid, Message.sender_id == uid,
                                        Message.receiver_id == uid)).delete(synchronize_session=False)
            for t in db.metadata.sorted_tables:                       # everything else that points at this user
                if t.name == 'users':
                    continue
                for fk in t.foreign_keys:
                    if fk.column.table.name == 'users':
                        col = fk.parent
                        if col.nullable:
                            db.session.execute(t.update().where(col == uid).values({col.name: None}))
                        else:
                            db.session.execute(t.delete().where(col == uid))
            s = db.session.get(Suspension, uid)
            if s:
                db.session.delete(s)
            db.session.flush()
            db.session.delete(db.session.get(User, uid))
            db.session.commit()
        except Exception as exc:
            db.session.rollback()
            log.error(f'[moderation] delete failed for {uid}: {exc}')
            return None, False
        log_activity(admin.id, 'user_deleted',
                     f'{admin.username} permanently deleted {name} <{email}>' + (f': {reason}' if reason else ''),
                     meta={'target': uid, 'username': name})
        return notified, True

    def guard_target(admin, uid, what):
        u = db.session.get(User, uid)
        if not u:
            return None, (jsonify({'error': 'User not found'}), 404)
        if u.id == admin.id:
            return None, (jsonify({'error': f'You cannot {what} your own account.'}), 400)
        if u.is_admin:
            return None, (jsonify({'error': f'Admin accounts cannot be {what}d here.'}), 400)
        return u, None

    # ── enforcement: suspended / unverified accounts are signed out ──────────
    @app.before_request
    def _mod_enforce():
        if not db_available:
            return None
        path = request.path
        try:
            # sign-in attempt: lift expired suspensions, and tell a correct password why it fails
            if request.method == 'POST' and path == '/api/auth/login':
                d = request.get_json(silent=True) or {}
                name = (d.get('username') or '').strip()
                u = (User.query.filter_by(username=name).first() or User.query.filter_by(email=name).first()) if name else None
                s = db.session.get(Suspension, u.id) if u else None
                if u and s:
                    if s.until and s.until <= datetime.utcnow():
                        lift(u.id)
                    elif u.check_password(d.get('password') or ''):
                        return jsonify({'error': f'Your account is suspended {"until " + human_until(s) if s.until else "until an administrator lifts it"}.'
                                                 + (f' Reason: {s.reason}' if s.reason else ''),
                                        'suspended': True}), 403
                return None
            uid = session.get('user_id')
            if not uid or not path.startswith('/api/') or path == '/api/auth/logout':
                return None
            row = db.session.query(User.is_active, User.is_verified, User.is_admin).filter(User.id == uid).first()
            if row is None:
                return None
            s = db.session.get(Suspension, uid)
            if s:
                if row.is_active is not False:
                    db.session.delete(s)                                 # stale row: admin re-enabled by hand
                    db.session.commit()
                elif s.until and s.until <= datetime.utcnow():
                    lift(uid)
                else:
                    session.clear()
                    return jsonify({'error': 'Your account is suspended.', 'suspended': True}), 403
            if row.is_verified is False and not row.is_admin:
                session.clear()
                return jsonify({'error': 'Please verify your email to continue.', 'requires_verification': True}), 401
        except Exception as exc:
            db.session.rollback()
            log.error(f'[moderation] enforce: {exc}')
        return None

    # ═══════════════════════════════════════════════════════════════════════
    # Admin: verify / suspend / delete
    # ═══════════════════════════════════════════════════════════════════════
    @app.route(f'{P}/users/<uid>/verify', methods=['POST'])
    @limiter.limit(admin_limit)
    @admin_only
    def mod_verify(admin, uid):
        data = request.get_json(silent=True) or {}
        u, err = guard_target(admin, uid, 'change verification on')
        if err:
            return err
        verified = bool(data.get('verified'))
        reason = (data.get('reason') or '').strip()[:200]
        if not verified and len(reason) < 3:
            return jsonify({'error': 'Write a short reason. It is kept in the audit log.'}), 400
        u.is_verified = verified
        if verified:
            u.verification_code = None
            u.verification_code_expires = None
        db.session.commit()
        log_activity(admin.id, 'user_verified' if verified else 'user_unverified',
                     f'{admin.username} marked {u.username} as {"verified" if verified else "unverified"}'
                     + (f': {reason}' if reason else ''), meta={'target': u.id})
        notified = None
        if data.get('notify'):
            notified = mail(admin, u, 'notice' if verified else 'security',
                            'Your account is verified' if verified else 'Please verify your email again',
                            'An administrator has verified your account. You can sign in.' if verified else
                            'An administrator reset your verification status. On your next sign-in you will be asked '
                            'to confirm your email with a new code.' + (f'\n\nReason: {reason}' if reason else ''))
        return jsonify({'success': True, 'is_verified': verified, 'notified': notified})

    @app.route(f'{P}/users/<uid>/suspend', methods=['POST'])
    @limiter.limit(admin_limit)
    @admin_only
    def mod_suspend(admin, uid):
        data = request.get_json(silent=True) or {}
        u, err = guard_target(admin, uid, 'suspend')
        if err:
            return err
        try:
            days = int(data.get('days') or 0)
        except (TypeError, ValueError):
            days = -1
        reason = (data.get('reason') or '').strip()[:200]
        if not 0 <= days <= 365:
            return jsonify({'error': 'Days must be 0 (until lifted) to 365.'}), 400
        if len(reason) < 3:
            return jsonify({'error': 'Write a short reason. It is kept in the audit log.'}), 400
        notified = do_suspend(admin, u, days, reason, bool(data.get('notify')))
        return jsonify({'success': True, 'is_active': False, 'days': days, 'notified': notified})

    @app.route(f'{P}/users/<uid>/unsuspend', methods=['POST'])
    @limiter.limit(admin_limit)
    @admin_only
    def mod_unsuspend(admin, uid):
        data = request.get_json(silent=True) or {}
        u = db.session.get(User, uid)
        if not u:
            return jsonify({'error': 'User not found'}), 404
        lift(u.id)
        log_activity(admin.id, 'user_unsuspended', f'{admin.username} lifted the suspension on {u.username}', meta={'target': u.id})
        notified = None
        if data.get('notify'):
            notified = mail(admin, u, 'notice', 'Your GhostChat account is active again',
                            'Your account is active again and you can sign in as usual.')
        return jsonify({'success': True, 'is_active': True, 'notified': notified})

    @app.route(f'{P}/users/<uid>/delete', methods=['POST'])
    @limiter.limit(admin_limit)
    @admin_only
    def mod_delete(admin, uid):
        data = request.get_json(silent=True) or {}
        u, err = guard_target(admin, uid, 'delete')
        if err:
            return err
        if (data.get('confirm') or '').strip() != u.username:
            return jsonify({'error': 'Type the exact username to confirm deleting this account.'}), 400
        reason = (data.get('reason') or '').strip()[:200]
        notified, ok = do_delete(admin, u, reason, bool(data.get('notify')))
        if not ok:
            return jsonify({'error': 'Could not delete this account. Nothing was changed.'}), 500
        return jsonify({'success': True, 'notified': notified})

    # ═══════════════════════════════════════════════════════════════════════
    # Users: report abuse
    # ═══════════════════════════════════════════════════════════════════════
    def alert_admins_of_report(rep):
        now = time.time()
        if now - _last_alert['t'] < 120:               # at most one alert email every 2 minutes
            return
        _last_alert['t'] = now

        def run():
            with app.app_context():
                try:
                    for a in User.query.filter_by(is_admin=True).all():
                        if a.email and a.is_active is not False:
                            text = (f'{rep["reporter"]} reported {rep["reported"]} for "{REASONS.get(rep["reason"], rep["reason"])}".\n\n'
                                    'Open the admin console, Reports tab, to review it.')
                            h, t = _audit.build_email('warning', 'New abuse report', text, a.username)
                            send_email(subject='[GhostChat] New abuse report', recipient=a.email, html_body=h, text_body=t)
                except Exception as exc:
                    log.error(f'[moderation] admin alert failed: {exc}')
        try:
            socketio.start_background_task(run)
        except Exception:
            threading.Thread(target=run, daemon=True).start()

    @app.route('/api/reports', methods=['POST', 'OPTIONS'])
    def create_report():
        if request.method == 'OPTIONS':
            return '', 200
        user, err = require_auth()
        if err:
            return err
        d = request.get_json(silent=True) or {}
        rid = str(d.get('reported_id') or '')
        reason = str(d.get('reason') or '')
        if reason not in REASONS:
            return jsonify({'error': 'Choose a reason for the report.'}), 400
        details = str(d.get('details') or '').strip()[:1000]
        evidence = str(d.get('evidence') or '').strip()[:2000]
        if rid == user.id:
            return jsonify({'error': 'You cannot report yourself.'}), 400
        target = db.session.get(User, rid)
        if not target:
            return jsonify({'error': 'User not found'}), 404
        linked = (Contact.query.filter_by(user_id=user.id, contact_id=rid).first()
                  or Contact.query.filter_by(user_id=rid, contact_id=user.id).first())
        if not linked:
            return jsonify({'error': 'You can only report people you have been connected with.'}), 403
        now = datetime.utcnow()
        if Report.query.filter(Report.reporter_id == user.id, Report.created_at >= now - timedelta(hours=1)).count() >= 5:
            return jsonify({'error': 'You have sent several reports recently. Please wait a while.'}), 429
        if Report.query.filter(Report.reporter_id == user.id, Report.reported_id == rid, Report.status == 'open',
                               Report.created_at >= now - timedelta(days=1)).first():
            return jsonify({'success': True, 'duplicate': True,
                            'message': 'You already reported this person. The admin will review it.'}), 200
        rep = Report(reporter_id=user.id, reporter_name=user.username, reported_id=rid, reported_name=target.username,
                     reason=reason, details=details, evidence=evidence)
        db.session.add(rep)
        mine = Contact.query.filter_by(user_id=user.id, contact_id=rid).first()
        if d.get('block') and mine:
            mine.is_blocked = True
        db.session.commit()
        log_activity(user.id, 'user_reported', f'{user.username} reported {target.username}: {REASONS[reason]}',
                     meta={'report': rep.id, 'target': rid})
        alert_admins_of_report({'reporter': user.username, 'reported': target.username, 'reason': reason})
        return jsonify({'success': True, 'id': rep.id, 'blocked': bool(d.get('block') and mine),
                        'message': 'Thanks. The admin will review your report.'}), 201

    @app.route('/api/reports/mine', methods=['GET', 'OPTIONS'])
    def my_reports():
        if request.method == 'OPTIONS':
            return '', 200
        user, err = require_auth()
        if err:
            return err
        rows = Report.query.filter_by(reporter_id=user.id).order_by(Report.created_at.desc()).limit(30).all()
        return jsonify({'success': True, 'reports': [
            {'id': r.id, 'reported': r.reported_name, 'reason': REASONS.get(r.reason, r.reason),
             'status': r.status, 'created_at': _iso(r.created_at)} for r in rows]})

    # ═══════════════════════════════════════════════════════════════════════
    # Admin: report queue
    # ═══════════════════════════════════════════════════════════════════════
    @app.route(f'{P}/reports/summary', methods=['GET'])
    @admin_only
    def mod_reports_summary(admin):
        return jsonify({'success': True, 'open': Report.query.filter_by(status='open').count()})

    @app.route(f'{P}/reports', methods=['GET'])
    @admin_only
    def mod_reports(admin):
        status = request.args.get('status', 'open')
        q = Report.query
        if status in ('open', 'actioned', 'dismissed'):
            q = q.filter_by(status=status)
        total = q.count()
        limit = min(request.args.get('limit', 50, type=int), 200)
        rows = q.order_by(Report.created_at.desc()).offset(max(request.args.get('offset', 0, type=int), 0)).limit(limit).all()
        ids = {r.reported_id for r in rows}
        users = {u.id: u for u in User.query.filter(User.id.in_(ids)).all()} if ids else {}
        out = []
        for r in rows:
            u = users.get(r.reported_id)
            s = db.session.get(Suspension, r.reported_id) if u else None
            out.append({
                'id': r.id, 'created_at': _iso(r.created_at), 'status': r.status, 'action': r.action,
                'reason': r.reason, 'reason_label': REASONS.get(r.reason, r.reason),
                'details': r.details, 'evidence': r.evidence, 'admin_note': r.admin_note,
                'resolved_at': _iso(r.resolved_at),
                'reporter': {'id': r.reporter_id, 'username': r.reporter_name},
                'reported': {'id': r.reported_id, 'username': (u.username if u else r.reported_name), 'exists': bool(u),
                             'is_active': (u.is_active is not False) if u else None,
                             'is_verified': bool(u.is_verified) if u else None,
                             'is_admin': bool(u.is_admin) if u else None,
                             'suspended_until': _iso(s.until) if s else None,
                             'reports_total': Report.query.filter_by(reported_id=r.reported_id).count(),
                             'reports_open': Report.query.filter_by(reported_id=r.reported_id, status='open').count()},
            })
        return jsonify({'success': True, 'total': total, 'reports': out})

    @app.route(f'{P}/reports/<rid>/resolve', methods=['POST'])
    @limiter.limit(admin_limit)
    @admin_only
    def mod_resolve(admin, rid):
        d = request.get_json(silent=True) or {}
        rep = db.session.get(Report, rid)
        if not rep:
            return jsonify({'error': 'Report not found'}), 404
        action = d.get('action')
        if action not in ('dismiss', 'warn', 'suspend', 'delete', 'none'):
            return jsonify({'error': 'Choose what to do with this report.'}), 400
        note = (d.get('note') or '').strip()[:500]
        u = db.session.get(User, rep.reported_id)
        result = {}
        if action in ('warn', 'suspend', 'delete'):
            if not u:
                return jsonify({'error': 'That account no longer exists.'}), 400
            if u.id == admin.id or u.is_admin:
                return jsonify({'error': 'Admin accounts cannot be moderated here.'}), 400
            if len(note) < 3:
                return jsonify({'error': 'Write a short note. It is sent to the user and kept in the audit log.'}), 400
        if action == 'warn':
            result['notified'] = mail(admin, u, 'warning', 'A warning about your behaviour on GhostChat',
                                      f'We received a report about your behaviour.\n\n{note}\n\n'
                                      'Further reports can lead to your account being suspended.')
        elif action == 'suspend':
            try:
                days = int(d.get('days') or 0)
            except (TypeError, ValueError):
                days = -1
            if not 0 <= days <= 365:
                return jsonify({'error': 'Days must be 0 (until lifted) to 365.'}), 400
            result['notified'] = do_suspend(admin, u, days, note, True)
        elif action == 'delete':
            if (d.get('confirm') or '').strip() != u.username:
                return jsonify({'error': 'Type the exact username to confirm deleting this account.'}), 400
            notified, ok = do_delete(admin, u, note, True)
            if not ok:
                return jsonify({'error': 'Could not delete this account. Nothing was changed.'}), 500
            result['notified'] = notified
        now = datetime.utcnow()
        status = 'dismissed' if action == 'dismiss' else 'actioned'
        targets = [rep]
        if action in ('suspend', 'delete'):
            targets = Report.query.filter_by(reported_id=rep.reported_id, status='open').all() + [rep]
        for r in {t.id: t for t in targets}.values():
            r.status, r.action, r.admin_note, r.resolved_by, r.resolved_at = status, action, note, admin.id, now
        db.session.commit()
        log_activity(admin.id, 'report_resolved',
                     f'{admin.username} resolved a report on {rep.reported_name} ({action})' + (f': {note}' if note else ''),
                     meta={'report': rep.id})
        if d.get('notify_reporter') and rep.reporter_id:
            ru = db.session.get(User, rep.reporter_id)
            if ru:
                result['reporter_notified'] = mail(
                    admin, ru, 'notice', 'We reviewed your report',
                    'Thank you for your report. We reviewed it and ' +
                    ('decided no action was needed.' if action == 'dismiss' else 'took appropriate action.'))
        return jsonify({'success': True, 'status': status, **result})

    log.info('Moderation tools installed')
