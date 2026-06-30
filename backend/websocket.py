# backend/websocket.py
"""
WebSocket handlers for real-time chat
"""

import json
import uuid
from datetime import datetime
from flask import request
from flask_socketio import SocketIO, emit, join_room, leave_room
from models import db, User, Message, Group, GroupMember, TypingStatus, UserStatus
from ghostchat import GhostChat
from sqlalchemy import or_, and_

socketio = SocketIO(cors_allowed_origins="*", async_mode='eventlet')


# ── Connection Events ─────────────────────────────────────────────────────────

@socketio.on('connect')
def handle_connect():
    """User connected to chat server"""
    user_id = request.headers.get('X-User-ID')
    if user_id:
        user = User.query.get(user_id)
        if user:
            user.is_online = True
            user.last_seen = datetime.utcnow()
            db.session.commit()
            # Broadcast online status
            emit('user_online', {'user_id': user_id}, broadcast=True)
    print(f'🔌 Client connected: {request.sid}')
    return True


@socketio.on('disconnect')
def handle_disconnect():
    """User disconnected from chat server"""
    user_id = request.headers.get('X-User-ID')
    if user_id:
        user = User.query.get(user_id)
        if user:
            user.is_online = False
            user.last_seen = datetime.utcnow()
            db.session.commit()
            # Broadcast offline status
            emit('user_offline', {'user_id': user_id, 'last_seen': user.last_seen.isoformat()}, broadcast=True)
    print(f'🔌 Client disconnected: {request.sid}')


# ── Authentication ─────────────────────────────────────────────────────────────

@socketio.on('authenticate')
def handle_authenticate(data):
    """Authenticate user with session token"""
    token = data.get('token')
    user_id = data.get('user_id')
    
    if user_id:
        user = User.query.get(user_id)
        if user:
            request.user_id = user_id
            emit('authenticated', {'status': 'success', 'user': user.to_dict()})
            return
    
    emit('authenticated', {'status': 'error', 'message': 'Authentication failed'})


# ── Real-time Messaging ──────────────────────────────────────────────────────

@socketio.on('send_message')
def handle_send_message(data):
    """
    Send a message (text, image, file, voice)
    """
    user_id = request.user_id if hasattr(request, 'user_id') else data.get('sender_id')
    
    if not user_id:
        emit('error', {'message': 'Not authenticated'})
        return
    
    chat_type = data.get('chat_type', 'private')  # private, group
    receiver_id = data.get('receiver_id')
    group_id = data.get('group_id')
    message_type = data.get('message_type', 'text')
    encrypted_content = data.get('encrypted_content', '')
    emoji_content = data.get('emoji_content', '')
    media_url = data.get('media_url')
    file_name = data.get('file_name')
    file_size = data.get('file_size')
    reply_to_id = data.get('reply_to_id')
    
    # Create message
    message = Message(
        id=str(uuid.uuid4()),
        sender_id=user_id,
        receiver_id=receiver_id if chat_type == 'private' else None,
        group_id=group_id if chat_type == 'group' else None,
        encrypted_content=encrypted_content,
        emoji_content=emoji_content,
        message_type=message_type,
        media_url=media_url,
        file_name=file_name,
        file_size=file_size,
        reply_to_id=reply_to_id,
        is_delivered=True,
        delivered_at=datetime.utcnow()
    )
    
    db.session.add(message)
    db.session.commit()
    
    # Prepare response
    message_data = {
        'id': message.id,
        'sender_id': message.sender_id,
        'receiver_id': message.receiver_id,
        'group_id': message.group_id,
        'encrypted_content': message.encrypted_content,
        'emoji_content': message.emoji_content,
        'message_type': message.message_type,
        'media_url': message.media_url,
        'file_name': message.file_name,
        'file_size': message.file_size,
        'reply_to_id': message.reply_to_id,
        'created_at': message.created_at.isoformat(),
        'sender': User.query.get(user_id).to_dict() if user_id else None
    }
    
    # Send to specific room
    if chat_type == 'private' and receiver_id:
        room = f"private_{min(user_id, receiver_id)}_{max(user_id, receiver_id)}"
        emit('new_message', message_data, room=room)
        emit('message_sent', {'message_id': message.id, 'status': 'sent'}, room=request.sid)
    elif chat_type == 'group' and group_id:
        room = f"group_{group_id}"
        emit('new_message', message_data, room=room)
        emit('message_sent', {'message_id': message.id, 'status': 'sent'}, room=request.sid)


# ── Read Receipts ────────────────────────────────────────────────────────────

@socketio.on('mark_read')
def handle_mark_read(data):
    """Mark message as read (blue ticks)"""
    user_id = request.user_id if hasattr(request, 'user_id') else data.get('user_id')
    message_id = data.get('message_id')
    
    if not user_id or not message_id:
        return
    
    message = Message.query.get(message_id)
    if message and not message.is_read:
        message.is_read = True
        message.read_at = datetime.utcnow()
        db.session.commit()
        
        emit('message_read', {
            'message_id': message_id,
            'reader_id': user_id,
            'read_at': message.read_at.isoformat()
        }, room=message.sender_id)


# ── Typing Indicators ────────────────────────────────────────────────────────

@socketio.on('typing')
def handle_typing(data):
    """User is typing"""
    user_id = request.user_id if hasattr(request, 'user_id') else data.get('user_id')
    chat_id = data.get('chat_id')  # receiver_id or group_id
    chat_type = data.get('chat_type', 'private')
    is_typing = data.get('is_typing', True)
    
    if not user_id or not chat_id:
        return
    
    # Update typing status in DB
    typing = TypingStatus.query.filter_by(user_id=user_id, chat_id=chat_id).first()
    if typing:
        typing.is_typing = is_typing
        typing.updated_at = datetime.utcnow()
    else:
        typing = TypingStatus(
            user_id=user_id,
            chat_id=chat_id,
            is_typing=is_typing
        )
        db.session.add(typing)
    db.session.commit()
    
    # Broadcast typing status
    if chat_type == 'private':
        room = f"private_{min(user_id, chat_id)}_{max(user_id, chat_id)}"
        emit('user_typing', {
            'user_id': user_id,
            'is_typing': is_typing
        }, room=room)
    else:
        room = f"group_{chat_id}"
        emit('user_typing', {
            'user_id': user_id,
            'is_typing': is_typing
        }, room=room)


# ── Reactions ────────────────────────────────────────────────────────────────

@socketio.on('add_reaction')
def handle_add_reaction(data):
    """Add reaction to message"""
    user_id = request.user_id if hasattr(request, 'user_id') else data.get('user_id')
    message_id = data.get('message_id')
    reaction = data.get('reaction')
    
    if not user_id or not message_id or not reaction:
        return
    
    message = Message.query.get(message_id)
    if not message:
        return
    
    # Parse reactions JSON
    reactions = json.loads(message.reactions) if message.reactions else {}
    if reaction not in reactions:
        reactions[reaction] = []
    if user_id not in reactions[reaction]:
        reactions[reaction].append(user_id)
    
    message.reactions = json.dumps(reactions)
    db.session.commit()
    
    emit('reaction_added', {
        'message_id': message_id,
        'reaction': reaction,
        'user_id': user_id
    }, broadcast=True)


# ── Message Deletion (For Everyone) ──────────────────────────────────────────

@socketio.on('delete_message')
def handle_delete_message(data):
    """Delete message for everyone (or for self)"""
    user_id = request.user_id if hasattr(request, 'user_id') else data.get('user_id')
    message_id = data.get('message_id')
    delete_for = data.get('delete_for', 'everyone')  # everyone, self
    
    if not user_id or not message_id:
        return
    
    message = Message.query.get(message_id)
    if not message:
        return
    
    if delete_for == 'everyone':
        # Only sender can delete for everyone
        if message.sender_id == user_id:
            message.is_deleted = True
            db.session.commit()
            emit('message_deleted', {'message_id': message_id, 'deleted_for': 'everyone'}, broadcast=True)
    else:
        # Delete for self
        deleted_for = json.loads(message.deleted_for) if message.deleted_for else []
        if user_id not in deleted_for:
            deleted_for.append(user_id)
            message.deleted_for = json.dumps(deleted_for)
            db.session.commit()


# ── Room Management ──────────────────────────────────────────────────────────

@socketio.on('join_chat')
def handle_join_chat(data):
    """Join a chat room"""
    user_id = request.user_id if hasattr(request, 'user_id') else data.get('user_id')
    chat_id = data.get('chat_id')
    chat_type = data.get('chat_type', 'private')
    
    if not user_id or not chat_id:
        return
    
    room = f"private_{min(user_id, chat_id)}_{max(user_id, chat_id)}" if chat_type == 'private' else f"group_{chat_id}"
    join_room(room)
    emit('joined_chat', {'room': room, 'status': 'joined'})


@socketio.on('leave_chat')
def handle_leave_chat(data):
    """Leave a chat room"""
    user_id = request.user_id if hasattr(request, 'user_id') else data.get('user_id')
    chat_id = data.get('chat_id')
    chat_type = data.get('chat_type', 'private')
    
    if not user_id or not chat_id:
        return
    
    room = f"private_{min(user_id, chat_id)}_{max(user_id, chat_id)}" if chat_type == 'private' else f"group_{chat_id}"
    leave_room(room)
    emit('left_chat', {'room': room, 'status': 'left'})


# ── Message History ──────────────────────────────────────────────────────────

@socketio.on('get_messages')
def handle_get_messages(data):
    """Get message history for a chat"""
    user_id = request.user_id if hasattr(request, 'user_id') else data.get('user_id')
    chat_id = data.get('chat_id')
    chat_type = data.get('chat_type', 'private')
    limit = data.get('limit', 50)
    before = data.get('before')  # Pagination cursor
    
    if not user_id or not chat_id:
        return
    
    query = Message.query
    
    if chat_type == 'private':
        query = query.filter(
            or_(
                and_(Message.sender_id == user_id, Message.receiver_id == chat_id),
                and_(Message.sender_id == chat_id, Message.receiver_id == user_id)
            )
        )
    else:
        query = query.filter(Message.group_id == chat_id)
    
    # Filter deleted messages
    query = query.filter(Message.is_deleted == False)
    
    # Pagination
    if before:
        query = query.filter(Message.created_at < before)
    
    messages = query.order_by(Message.created_at.desc()).limit(limit).all()
    
    emit('messages_history', {
        'messages': [m.to_dict() for m in messages[::-1]],
        'has_more': len(messages) == limit
    }, room=request.sid)