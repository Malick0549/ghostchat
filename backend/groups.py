"""
GhostChat group chats — end-to-end encrypted.

What the server does and does NOT know
  • It knows who is in a group, the group name, and when messages are sent (like a normal chat).
  • It NEVER sees the group key or any message / file contents. The key is made in a member's
    browser and handed to each member wrapped (encrypted) for that member with their own
    one-to-one end-to-end key. The server only stores and forwards those wrapped keys.
  • Keys are versioned. When someone is added, removed or leaves, the group is flagged
    `rekey_needed`; the next member's browser makes a NEW key version for the current members only,
    so people who left cannot read what is sent after they left, and people who join cannot read
    what was sent before they joined.

Routes (all need a signed-in user; CSRF is enforced for every POST/PUT/DELETE by the app)
  GET    /api/groups                         my groups
  POST   /api/groups                         create  {name, description?, member_ids[]}
  GET    /api/groups/<id>                    members + key status
  PUT    /api/groups/<id>                    rename (admin)
  DELETE /api/groups/<id>                    delete the group (admin)
  POST   /api/groups/<id>/members            add a contact (admin)           {user_id}
  DELETE /api/groups/<id>/members/<uid>      remove a member (admin)
  POST   /api/groups/<id>/leave              leave
  GET    /api/groups/<id>/keys               my wrapped keys (all versions)
  POST   /api/groups/<id>/keys               publish wrapped keys {version, keys:[{user_id, packet}]}
  GET    /api/groups/<id>/messages           history
  POST   /api/groups/<id>/messages           send a text message {content}  (content = encrypted packet)
  POST   /api/groups/<id>/media              send an encrypted file/photo/voice/video (multipart)
  DELETE /api/groups/<id>/messages/<mid>     delete a message (its sender, or a group admin)
"""
import re
import time
import uuid
from collections import defaultdict, deque
from datetime import datetime

from flask import jsonify, request

from backend.models import db, Group, GroupMember

MAX_MEMBERS = 50
MAX_NAME = 60


class GroupKey(db.Model):
    """A group key (one version) wrapped for ONE member. The server cannot open it."""
    __tablename__ = 'group_keys'
    id = db.Column(db.String(36), primary_key=True, default=lambda: str(uuid.uuid4()))
    group_id = db.Column(db.String(36), nullable=False, index=True)
    user_id = db.Column(db.String(36), db.ForeignKey('users.id'), nullable=False, index=True)   # recipient
    version = db.Column(db.Integer, nullable=False)
    sender_id = db.Column(db.String(36), nullable=True)                                          # who wrapped it
    packet = db.Column(db.Text, nullable=False)
    created_at = db.Column(db.DateTime, default=datetime.utcnow)
    __table_args__ = (db.UniqueConstraint('group_id', 'user_id', 'version', name='unique_group_key'),)


class GroupMeta(db.Model):
    __tablename__ = 'group_meta'
    group_id = db.Column(db.String(36), primary_key=True)
    key_version = db.Column(db.Integer, default=0, nullable=False)
    rekey_needed = db.Column(db.Boolean, default=True, nullable=False)


# The 256 fixed emoji used for encrypted packets (identical to js/e2e.js). A packet is made ONLY of these,
# so a plaintext message or note can never be stored by mistake.
_EMO = set()
for _a, _b in ((0x1F300, 0x1F320), (0x1F330, 0x1F335), (0x1F337, 0x1F37C), (0x1F380, 0x1F393), (0x1F3A0, 0x1F3C4),
               (0x1F3E0, 0x1F3F0), (0x1F400, 0x1F43E), (0x1F440, 0x1F440), (0x1F442, 0x1F44A)):
    _EMO.update(chr(c) for c in range(_a, _b + 1))


def _is_packet(s, max_len):
    return isinstance(s, str) and 1 <= len(s) <= max_len and all(ch in _EMO for ch in s)


def _clean(text, limit):
    t = re.sub(r'[\u0000-\u001f\u007f\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]', '', str(text or '')).strip()
    return t[:limit]


class _Window:
    def __init__(self): self.d = defaultdict(deque)
    def over(self, k, limit, sec):
        q = self.d[k]; now = time.time()
        while q and now - q[0] > sec: q.popleft()
        return len(q) >= limit
    def hit(self, k): self.d[k].append(time.time())


def install_groups(app, *, User, Message, Contact, socketio, log, log_activity, require_auth, db_available=True):
    if not db_available:
        return
    msg_w, media_w, make_w = _Window(), _Window(), _Window()

    # ── helpers ──────────────────────────────────────────────────────────────
    def _member(gid, uid):
        return GroupMember.query.filter_by(group_id=gid, user_id=uid).first()

    def _group_for(user, gid, admin=False):
        """(group, membership, error-response). Hides groups from non-members (404)."""
        g = db.session.get(Group, gid)
        m = _member(gid, user.id) if g and g.is_active else None
        if not g or not g.is_active or not m:
            return None, None, (jsonify({'error': 'Group not found'}), 404)
        if admin and m.role != 'admin':
            return None, None, (jsonify({'error': 'Only a group admin can do that'}), 403)
        return g, m, None

    def _meta(gid):
        m = db.session.get(GroupMeta, gid)
        if not m:
            m = GroupMeta(group_id=gid, key_version=0, rekey_needed=True)
            db.session.add(m); db.session.flush()
        return m

    def _may_add(admin, target_id):
        mine = Contact.query.filter_by(user_id=admin.id, contact_id=target_id).first()
        if not mine or mine.is_blocked:
            return False
        theirs = Contact.query.filter_by(user_id=target_id, contact_id=admin.id).first()
        return not (theirs is not None and theirs.is_blocked)

    def _members_payload(gid):
        rows = (db.session.query(GroupMember, User).join(User, User.id == GroupMember.user_id)
                .filter(GroupMember.group_id == gid).order_by(GroupMember.joined_at).all())
        return [{'user_id': u.id, 'username': u.username, 'avatar': u.avatar, 'role': m.role} for m, u in rows]

    def _detail(g, me_id):
        meta = _meta(g.id)
        members = _members_payload(g.id)
        have = {k.user_id for k in GroupKey.query.filter_by(group_id=g.id, version=meta.key_version).all()} if meta.key_version else set()
        mine = next((m for m in members if m['user_id'] == me_id), None)
        return {
            'id': g.id, 'name': g.name, 'description': g.description, 'created_by': g.created_by,
            'created_at': g.created_at.isoformat() if g.created_at else None,
            'role': mine['role'] if mine else None, 'members': members, 'member_count': len(members),
            'key_version': meta.key_version, 'rekey_needed': bool(meta.rekey_needed),
            'missing_keys': [m['user_id'] for m in members if m['user_id'] not in have] if meta.key_version else [],
        }

    def _notify(gid, event, extra=None, uids=None):
        if not socketio:
            return
        ids = uids if uids is not None else [m.user_id for m in GroupMember.query.filter_by(group_id=gid).all()]
        for uid in ids:
            socketio.emit(event, {'group_id': gid, **(extra or {})}, room=f'user_{uid}')

    def _wipe_group(gid):
        Message.query.filter_by(group_id=gid).delete(synchronize_session=False)
        GroupKey.query.filter_by(group_id=gid).delete(synchronize_session=False)
        GroupMember.query.filter_by(group_id=gid).delete(synchronize_session=False)
        GroupMeta.query.filter_by(group_id=gid).delete(synchronize_session=False)
        g = db.session.get(Group, gid)
        if g: db.session.delete(g)

    def _drop_member(g, uid):
        GroupMember.query.filter_by(group_id=g.id, user_id=uid).delete(synchronize_session=False)
        GroupKey.query.filter_by(group_id=g.id, user_id=uid).delete(synchronize_session=False)
        _meta(g.id).rekey_needed = True
        left = GroupMember.query.filter_by(group_id=g.id).order_by(GroupMember.joined_at).all()
        if not left:
            _wipe_group(g.id)
            return
        if not any(m.role == 'admin' for m in left):        # never leave a group without an admin
            left[0].role = 'admin'

    # ── list / create / read ─────────────────────────────────────────────────
    @app.route('/api/groups', methods=['GET'])
    def groups_list():
        user, err = require_auth()
        if err: return err
        rows = (db.session.query(Group, GroupMember).join(GroupMember, GroupMember.group_id == Group.id)
                .filter(GroupMember.user_id == user.id, Group.is_active == True).all())     # noqa: E712
        out = []
        for g, m in rows:
            meta = db.session.get(GroupMeta, g.id)
            last = (Message.query.filter(Message.group_id == g.id, Message.is_deleted == False)       # noqa: E712
                    .order_by(Message.created_at.desc()).first())
            out.append({'id': g.id, 'name': g.name, 'description': g.description, 'role': m.role,
                        'member_count': GroupMember.query.filter_by(group_id=g.id).count(),
                        'key_version': meta.key_version if meta else 0, 'rekey_needed': bool(meta.rekey_needed) if meta else True,
                        'last_message_at': last.created_at.isoformat() if last else None,
                        'created_at': g.created_at.isoformat() if g.created_at else None})
        out.sort(key=lambda x: x['last_message_at'] or x['created_at'] or '', reverse=True)
        return jsonify({'success': True, 'groups': out})

    @app.route('/api/groups', methods=['POST'])
    def groups_create():
        user, err = require_auth()
        if err: return err
        if make_w.over(user.id, 5, 3600):
            return jsonify({'error': 'You are creating groups too quickly. Try again later.'}), 429
        d = request.get_json(silent=True) or {}
        name = _clean(d.get('name'), MAX_NAME)
        if len(name) < 1:
            return jsonify({'error': 'Give the group a name'}), 400
        ids = []
        for x in (d.get('member_ids') or []):
            x = str(x)
            if x != user.id and x not in ids: ids.append(x)
        if len(ids) + 1 > MAX_MEMBERS:
            return jsonify({'error': f'A group can have up to {MAX_MEMBERS} people'}), 400
        for x in ids:
            if not _may_add(user, x):
                return jsonify({'error': 'You can only add people from your contacts'}), 400
        make_w.hit(user.id)
        g = Group(name=name, description=_clean(d.get('description'), 200) or None, created_by=user.id)
        db.session.add(g); db.session.flush()
        db.session.add(GroupMember(group_id=g.id, user_id=user.id, role='admin'))
        for x in ids:
            db.session.add(GroupMember(group_id=g.id, user_id=x, role='member'))
        db.session.add(GroupMeta(group_id=g.id, key_version=0, rekey_needed=True))
        db.session.commit()
        log_activity(user.id, 'group_created', f'{user.username} created a group with {len(ids) + 1} people')
        _notify(g.id, 'group_updated', {'reason': 'created'})
        return jsonify({'success': True, 'group': _detail(g, user.id)}), 201

    @app.route('/api/groups/<gid>', methods=['GET'])
    def groups_get(gid):
        user, err = require_auth()
        if err: return err
        g, m, e = _group_for(user, gid)
        if e: return e
        db.session.commit()
        return jsonify({'success': True, 'group': _detail(g, user.id)})

    @app.route('/api/groups/<gid>', methods=['PUT'])
    def groups_update(gid):
        user, err = require_auth()
        if err: return err
        g, m, e = _group_for(user, gid, admin=True)
        if e: return e
        d = request.get_json(silent=True) or {}
        if 'name' in d:
            n = _clean(d.get('name'), MAX_NAME)
            if not n: return jsonify({'error': 'Give the group a name'}), 400
            g.name = n
        if 'description' in d:
            g.description = _clean(d.get('description'), 200) or None
        db.session.commit()
        _notify(gid, 'group_updated', {'reason': 'renamed'})
        return jsonify({'success': True, 'group': _detail(g, user.id)})

    @app.route('/api/groups/<gid>', methods=['DELETE'])
    def groups_delete(gid):
        user, err = require_auth()
        if err: return err
        g, m, e = _group_for(user, gid, admin=True)
        if e: return e
        ids = [x.user_id for x in GroupMember.query.filter_by(group_id=gid).all()]
        _wipe_group(gid); db.session.commit()
        log_activity(user.id, 'group_deleted', f'{user.username} deleted a group')
        _notify(gid, 'group_removed', {}, uids=ids)
        return jsonify({'success': True})

    # ── members ──────────────────────────────────────────────────────────────
    @app.route('/api/groups/<gid>/members', methods=['POST'])
    def groups_add_member(gid):
        user, err = require_auth()
        if err: return err
        g, m, e = _group_for(user, gid, admin=True)
        if e: return e
        uid = str((request.get_json(silent=True) or {}).get('user_id') or '')
        if _member(gid, uid): return jsonify({'error': 'Already in the group'}), 400
        if GroupMember.query.filter_by(group_id=gid).count() >= MAX_MEMBERS:
            return jsonify({'error': f'A group can have up to {MAX_MEMBERS} people'}), 400
        if not _may_add(user, uid): return jsonify({'error': 'You can only add people from your contacts'}), 400
        db.session.add(GroupMember(group_id=gid, user_id=uid, role='member'))
        _meta(gid).rekey_needed = True
        db.session.commit()
        _notify(gid, 'group_updated', {'reason': 'member_added'})
        return jsonify({'success': True, 'group': _detail(g, user.id)})

    @app.route('/api/groups/<gid>/members/<uid>', methods=['DELETE'])
    def groups_remove_member(gid, uid):
        user, err = require_auth()
        if err: return err
        g, m, e = _group_for(user, gid, admin=True)
        if e: return e
        if uid == user.id: return jsonify({'error': 'Use "Leave group" to leave'}), 400
        if not _member(gid, uid): return jsonify({'error': 'Not in the group'}), 404
        _drop_member(g, uid); db.session.commit()
        _notify(gid, 'group_updated', {'reason': 'member_removed'})
        _notify(gid, 'group_removed', {}, uids=[uid])
        return jsonify({'success': True, 'group': _detail(g, user.id)})

    @app.route('/api/groups/<gid>/leave', methods=['POST'])
    def groups_leave(gid):
        user, err = require_auth()
        if err: return err
        g, m, e = _group_for(user, gid)
        if e: return e
        _drop_member(g, user.id); db.session.commit()
        _notify(gid, 'group_updated', {'reason': 'member_left'})
        return jsonify({'success': True})

    # ── keys ─────────────────────────────────────────────────────────────────
    @app.route('/api/groups/<gid>/keys', methods=['GET'])
    def groups_keys_get(gid):
        user, err = require_auth()
        if err: return err
        g, m, e = _group_for(user, gid)
        if e: return e
        rows = GroupKey.query.filter_by(group_id=gid, user_id=user.id).order_by(GroupKey.version).all()
        return jsonify({'success': True, 'keys': [{'version': k.version, 'sender_id': k.sender_id, 'packet': k.packet} for k in rows]})

    @app.route('/api/groups/<gid>/keys', methods=['POST'])
    def groups_keys_post(gid):
        user, err = require_auth()
        if err: return err
        g, m, e = _group_for(user, gid)
        if e: return e
        d = request.get_json(silent=True) or {}
        try: ver = int(d.get('version'))
        except (TypeError, ValueError): return jsonify({'error': 'version required'}), 400
        keys = d.get('keys') or []
        if not isinstance(keys, list) or not keys or len(keys) > MAX_MEMBERS:
            return jsonify({'error': 'keys required'}), 400
        meta = _meta(gid)
        member_ids = {x.user_id for x in GroupMember.query.filter_by(group_id=gid).all()}
        new_version = ver == meta.key_version + 1
        sync = bool(d.get('sync'))                                   # "I hold this key; here it is for people who lack it"
        if new_version:
            if m.role != 'admin':                                    # one writer per version: only admins make keys
                return jsonify({'error': 'Only a group admin can change the group key'}), 403
        elif not (sync and ver == meta.key_version and ver > 0):
            return jsonify({'error': 'Another admin already changed the key', 'key_version': meta.key_version}), 409
        have = {k.user_id for k in GroupKey.query.filter_by(group_id=gid, version=ver).all()}
        added = 0
        for k in keys:
            rid, pk = str(k.get('user_id') or ''), k.get('packet')
            if rid not in member_ids or not _is_packet(pk, 4000): continue
            if rid in have: continue                              # first writer wins, never overwritten
            db.session.add(GroupKey(group_id=gid, user_id=rid, version=ver, sender_id=user.id, packet=pk)); have.add(rid); added += 1
        if not added and new_version:
            return jsonify({'error': 'No valid keys were provided'}), 400
        if new_version:
            meta.key_version = ver; meta.rekey_needed = False
        db.session.commit()
        _notify(gid, 'group_updated', {'reason': 'keys'})
        return jsonify({'success': True, 'key_version': meta.key_version, 'added': added})

    # ── messages ─────────────────────────────────────────────────────────────
    def _payload(msg, user):
        return {'id': msg.id, 'group_id': msg.group_id, 'sender_id': msg.sender_id, 'sender': user.username, 'avatar': user.avatar,
                'created_at': msg.created_at.isoformat(), 'message_type': msg.message_type, 'content': msg.encrypted_content,
                'media_url': f'/api/media/{msg.id}' if msg.media_data else None, 'file_name': msg.file_name, 'file_size': msg.file_size}

    @app.route('/api/groups/<gid>/messages', methods=['GET'])
    def groups_messages(gid):
        user, err = require_auth()
        if err: return err
        g, m, e = _group_for(user, gid)
        if e: return e
        limit = max(1, min(request.args.get('limit', 50, type=int), 200))
        q = Message.query.filter(Message.group_id == gid, Message.is_deleted == False)               # noqa: E712
        if m.joined_at:                                          # new members never receive what was said before they joined
            q = q.filter(Message.created_at >= m.joined_at)
        before = request.args.get('before')
        if before: q = q.filter(Message.created_at < before)
        rows = q.order_by(Message.created_at.desc()).limit(limit).all(); rows.reverse()
        names = {u.id: u for u in User.query.filter(User.id.in_({r.sender_id for r in rows} or {''})).all()}
        out = []
        for r in rows:
            d = r.to_dict(); u = names.get(r.sender_id)
            d['sender'] = u.username if u else 'Former member'; d['avatar'] = u.avatar if u else None
            d['media_url'] = f'/api/media/{r.id}' if r.media_data else None
            out.append(d)
        return jsonify({'success': True, 'messages': out})

    @app.route('/api/groups/<gid>/messages', methods=['POST'])
    def groups_send(gid):
        user, err = require_auth()
        if err: return err
        g, m, e = _group_for(user, gid)
        if e: return e
        if msg_w.over(user.id, 30, 10):
            return jsonify({'error': 'You are sending too fast. Slow down a little.'}), 429
        content = (request.get_json(silent=True) or {}).get('content')
        if not _is_packet(content, 8000):
            return jsonify({'error': 'Group messages must be end-to-end encrypted'}), 400
        msg_w.hit(user.id)
        msg = Message(user_id=user.id, sender_id=user.id, receiver_id=None, group_id=gid, encrypted_content=content,
                      message_type='chat', is_delivered=True)
        db.session.add(msg); db.session.commit()
        log_activity(user.id, 'message_sent', 'group message')
        p = _payload(msg, user); _notify(gid, 'group_message', p)
        return jsonify({'success': True, 'message': p}), 201

    @app.route('/api/groups/<gid>/media', methods=['POST'])
    def groups_media(gid):
        user, err = require_auth()
        if err: return err
        g, m, e = _group_for(user, gid)
        if e: return e
        if media_w.over(user.id, 10, 60):
            return jsonify({'error': 'Too many uploads. Try again in a minute.'}), 429
        caption = (request.form.get('caption') or '').strip()
        if not _is_packet(caption, 8000):
            return jsonify({'error': 'Files must be end-to-end encrypted before sending'}), 400
        f = request.files.get('file')
        data = f.read() if f else b''
        if not data: return jsonify({'error': 'Empty file'}), 400
        if len(data) > 41 * 1024 * 1024: return jsonify({'error': 'File is too large'}), 400
        media_w.hit(user.id)
        msg = Message(user_id=user.id, sender_id=user.id, receiver_id=None, group_id=gid, encrypted_content=caption,
                      message_type='document', media_data=data, media_type='application/octet-stream',
                      file_name='encrypted-document', file_size=len(data), is_delivered=True)
        db.session.add(msg); db.session.commit()
        log_activity(user.id, 'message_sent', 'group file')
        p = _payload(msg, user); _notify(gid, 'group_message', p)
        return jsonify({'success': True, 'message': p}), 201

    @app.route('/api/groups/<gid>/messages/<mid>', methods=['DELETE'])
    def groups_delete_message(gid, mid):
        user, err = require_auth()
        if err: return err
        g, m, e = _group_for(user, gid)
        if e: return e
        msg = Message.query.filter_by(id=mid, group_id=gid).first()
        if not msg: return jsonify({'error': 'Message not found'}), 404
        if msg.sender_id != user.id and m.role != 'admin':
            return jsonify({'error': 'Only the sender or a group admin can delete this'}), 403
        msg.is_deleted = True; msg.deleted_at = datetime.utcnow(); msg.deleted_by = user.id
        msg.media_data = None                                   # free the space; the file is gone for everyone
        db.session.commit()
        _notify(gid, 'group_message_deleted', {'message_id': mid})
        return jsonify({'success': True})

    def cleanup_user(uid):
        """Called when an administrator deletes an account: leave every group cleanly and keep groups consistent."""
        for mm in GroupMember.query.filter_by(user_id=uid).all():
            g = db.session.get(Group, mm.group_id)
            if g:
                gid = g.id
                _drop_member(g, uid)
                _notify(gid, 'group_updated', {'reason': 'member_left'})
        db.session.flush()
        for g in Group.query.filter_by(created_by=uid).all():
            a = GroupMember.query.filter_by(group_id=g.id, role='admin').first()
            if a: g.created_by = a.user_id
            else: _wipe_group(g.id)
        db.session.flush()
    app.extensions['gc_group_cleanup'] = cleanup_user

    log.info('Group chats installed')
