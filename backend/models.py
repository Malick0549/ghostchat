"""
GhostChat Database Models
User authentication and message storage
"""

from flask_sqlalchemy import SQLAlchemy
from flask_bcrypt import Bcrypt
from datetime import datetime, timedelta
import uuid
import secrets

db = SQLAlchemy()
bcrypt = Bcrypt()

class User(db.Model):
    """User model for authentication"""
    __tablename__ = 'users'
    
    id = db.Column(db.String(36), primary_key=True, default=lambda: str(uuid.uuid4()))
    username = db.Column(db.String(80), unique=True, nullable=False)
    email = db.Column(db.String(120), unique=True, nullable=False)
    password_hash = db.Column(db.String(128), nullable=False)
    avatar = db.Column(db.String(500), default='/assets/images/default-avatar.png')
    two_factor_enabled = db.Column(db.Boolean, default=False)
    created_at = db.Column(db.DateTime, default=datetime.utcnow)
    last_login = db.Column(db.DateTime, nullable=True)
    is_active = db.Column(db.Boolean, default=True)
    
    # Password reset fields
    reset_token = db.Column(db.String(100), nullable=True)
    reset_token_expires = db.Column(db.DateTime, nullable=True)

    # ── 2FA (email OTP) fields ──
    # two_factor_code is short-lived (OTP_EXPIRY_MINUTES) and single-use;
    # never logged, never returned in any API response.
    two_factor_code = db.Column(db.String(10), nullable=True)
    two_factor_code_expires = db.Column(db.DateTime, nullable=True)
    two_factor_attempts = db.Column(db.Integer, default=0)
    # Set once a user has passed 2FA on this session's login; used to gate
    # /api/auth/me and friends until the second factor is satisfied.
    
    # Chat fields
    phone = db.Column(db.String(20), nullable=True)
    about = db.Column(db.String(200), default='Available')
    last_seen = db.Column(db.DateTime, default=datetime.utcnow)
    is_online = db.Column(db.Boolean, default=False)
    is_verified = db.Column(db.Boolean, default=False)
    is_admin = db.Column(db.Boolean, default=False)

    # Email verification fields (registration gate)
    verification_code = db.Column(db.String(10), nullable=True)
    verification_code_expires = db.Column(db.DateTime, nullable=True)

    # Last-known location/device (updated at login) — admin visibility only
    last_ip = db.Column(db.String(45), nullable=True)
    last_location = db.Column(db.String(200), nullable=True)
    last_device = db.Column(db.String(200), nullable=True)
    
    # Relationships - FIXED: Specify foreign_keys to avoid ambiguity
    messages = db.relationship('Message', foreign_keys='Message.user_id', backref='user', lazy=True)
    sessions = db.relationship('UserSession', backref='user', lazy=True)
    contacts = db.relationship('Contact', foreign_keys='Contact.user_id', backref='user', lazy=True)
    contacts_added = db.relationship('Contact', foreign_keys='Contact.contact_id', backref='contact_user', lazy=True)
    groups = db.relationship('GroupMember', backref='member', lazy=True)
    
    def set_password(self, password):
        if password:
            self.password_hash = bcrypt.generate_password_hash(password).decode('utf-8')
    
    def check_password(self, password):
        if not self.password_hash or not password:
            return False
        return bcrypt.check_password_hash(self.password_hash, password)
    
    def generate_reset_token(self):
        self.reset_token = secrets.token_urlsafe(32)
        self.reset_token_expires = datetime.utcnow() + timedelta(hours=24)
        return self.reset_token
    
    def verify_reset_token(self, token):
        if not self.reset_token or not self.reset_token_expires:
            return False
        return (self.reset_token == token and 
                datetime.utcnow() < self.reset_token_expires)
    
    def to_dict(self):
        return {
            'id': self.id,
            'username': self.username,
            'email': self.email,
            'avatar': self.avatar,
            'two_factor_enabled': self.two_factor_enabled,
            'created_at': self.created_at.isoformat() if self.created_at else None,
            'last_login': self.last_login.isoformat() if self.last_login else None,
            'phone': self.phone,
            'about': self.about,
            'last_seen': self.last_seen.isoformat() if self.last_seen else None,
            'is_online': self.is_online,
            'is_verified': self.is_verified,
            'is_admin': self.is_admin
        }

    def to_admin_dict(self):
        """Extended dict for the admin dashboard only — includes location/device."""
        d = self.to_dict()
        d.update({
            'last_ip': self.last_ip,
            'last_location': self.last_location,
            'last_device': self.last_device,
        })
        return d
    
    def __repr__(self):
        return f'<User {self.username}>'


class UserSession(db.Model):
    __tablename__ = 'user_sessions'
    
    id = db.Column(db.String(36), primary_key=True, default=lambda: str(uuid.uuid4()))
    user_id = db.Column(db.String(36), db.ForeignKey('users.id'), nullable=False)
    session_token = db.Column(db.String(256), unique=True, nullable=False)
    device_info = db.Column(db.String(256), nullable=True)
    ip_address = db.Column(db.String(45), nullable=True)
    created_at = db.Column(db.DateTime, default=datetime.utcnow)
    expires_at = db.Column(db.DateTime, nullable=False)
    is_active = db.Column(db.Boolean, default=True)
    
    def to_dict(self):
        return {
            'id': self.id,
            'device_info': self.device_info,
            'created_at': self.created_at.isoformat() if self.created_at else None,
            'expires_at': self.expires_at.isoformat() if self.expires_at else None,
            'is_active': self.is_active
        }


class Contact(db.Model):
    __tablename__ = 'contacts'
    
    id = db.Column(db.String(36), primary_key=True, default=lambda: str(uuid.uuid4()))
    user_id = db.Column(db.String(36), db.ForeignKey('users.id'), nullable=False)
    contact_id = db.Column(db.String(36), db.ForeignKey('users.id'), nullable=False)
    display_name = db.Column(db.String(80), nullable=True)
    is_favorite = db.Column(db.Boolean, default=False)
    is_blocked = db.Column(db.Boolean, default=False)
    created_at = db.Column(db.DateTime, default=datetime.utcnow)
    
    __table_args__ = (db.UniqueConstraint('user_id', 'contact_id', name='unique_contact'),)


class ContactRequest(db.Model):
    __tablename__ = 'contact_requests'

    id = db.Column(db.String(36), primary_key=True, default=lambda: str(uuid.uuid4()))
    sender_id = db.Column(db.String(36), db.ForeignKey('users.id'), nullable=False)
    recipient_id = db.Column(db.String(36), db.ForeignKey('users.id'), nullable=False)
    status = db.Column(db.String(20), default='pending')
    created_at = db.Column(db.DateTime, default=datetime.utcnow)
    updated_at = db.Column(db.DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)

    __table_args__ = (
        db.UniqueConstraint('sender_id', 'recipient_id', name='unique_contact_request'),
    )


class Message(db.Model):
    __tablename__ = 'messages'
    
    id = db.Column(db.String(36), primary_key=True, default=lambda: str(uuid.uuid4()))
    user_id = db.Column(db.String(36), db.ForeignKey('users.id'), nullable=False)
    encrypted_content = db.Column(db.Text, nullable=False)
    emoji_content = db.Column(db.Text, nullable=True)
    message_type = db.Column(db.String(20), default='encryption')
    created_at = db.Column(db.DateTime, default=datetime.utcnow)
    
    # Chat fields
    sender_id = db.Column(db.String(36), db.ForeignKey('users.id'), nullable=True)
    receiver_id = db.Column(db.String(36), db.ForeignKey('users.id'), nullable=True)
    group_id = db.Column(db.String(36), nullable=True)
    is_read = db.Column(db.Boolean, default=False)
    read_at = db.Column(db.DateTime, nullable=True)
    is_delivered = db.Column(db.Boolean, default=False)
    delivered_at = db.Column(db.DateTime, nullable=True)
    is_starred = db.Column(db.Boolean, default=False)
    is_deleted = db.Column(db.Boolean, default=False)
    deleted_for = db.Column(db.Text, nullable=True)
    deleted_at = db.Column(db.DateTime, nullable=True)
    deleted_by = db.Column(db.String(36), nullable=True)
    reply_to_id = db.Column(db.String(36), nullable=True)
    reactions = db.Column(db.Text, default='{}')
    media_url = db.Column(db.String(500), nullable=True)
    file_name = db.Column(db.String(200), nullable=True)
    file_size = db.Column(db.Integer, nullable=True)
    media_data = db.Column(db.LargeBinary, nullable=True)
    media_type = db.Column(db.String(100), nullable=True)
    
    def to_dict(self):
        return {
            'id': self.id,
            'encrypted_content': self.encrypted_content,
            'emoji_content': self.emoji_content,
            'message_type': self.message_type,
            'created_at': self.created_at.isoformat() if self.created_at else None,
            'sender_id': self.sender_id,
            'receiver_id': self.receiver_id,
            'group_id': self.group_id,
            'is_read': self.is_read,
            'read_at': self.read_at.isoformat() if self.read_at else None,
            'is_delivered': self.is_delivered,
            'is_starred': self.is_starred,
            'reply_to_id': self.reply_to_id,
            'reactions': self.reactions,
            'media_url': self.media_url,
            'file_name': self.file_name,
            'file_size': self.file_size
        }


class ActivityLog(db.Model):
    """Audit trail for admin visibility — logins, registrations, connection
    requests, password resets, and message activity (counts only, never
    content, since chat messages are end-to-end style encrypted)."""
    __tablename__ = 'activity_logs'

    id = db.Column(db.String(36), primary_key=True, default=lambda: str(uuid.uuid4()))
    user_id = db.Column(db.String(36), db.ForeignKey('users.id'), nullable=True)
    event_type = db.Column(db.String(50), nullable=False)
    description = db.Column(db.String(500), nullable=True)
    ip_address = db.Column(db.String(45), nullable=True)
    location = db.Column(db.String(200), nullable=True)
    device = db.Column(db.String(200), nullable=True)
    created_at = db.Column(db.DateTime, default=datetime.utcnow)

    def to_dict(self):
        u = User.query.get(self.user_id) if self.user_id else None
        return {
            'id': self.id,
            'user_id': self.user_id,
            'username': u.username if u else None,
            'event_type': self.event_type,
            'description': self.description,
            'ip_address': self.ip_address,
            'location': self.location,
            'device': self.device,
            'created_at': self.created_at.isoformat() if self.created_at else None,
        }


class Group(db.Model):
    __tablename__ = 'groups'
    
    id = db.Column(db.String(36), primary_key=True, default=lambda: str(uuid.uuid4()))
    name = db.Column(db.String(100), nullable=False)
    description = db.Column(db.String(200), nullable=True)
    avatar = db.Column(db.String(500), nullable=True)
    created_by = db.Column(db.String(36), db.ForeignKey('users.id'), nullable=False)
    is_active = db.Column(db.Boolean, default=True)
    created_at = db.Column(db.DateTime, default=datetime.utcnow)
    
    members = db.relationship('GroupMember', backref='group', lazy=True)
    
    def to_dict(self):
        return {
            'id': self.id,
            'name': self.name,
            'description': self.description,
            'avatar': self.avatar,
            'created_by': self.created_by,
            'created_at': self.created_at.isoformat() if self.created_at else None,
            'member_count': len(self.members)
        }


class GroupMember(db.Model):
    __tablename__ = 'group_members'
    
    id = db.Column(db.String(36), primary_key=True, default=lambda: str(uuid.uuid4()))
    group_id = db.Column(db.String(36), db.ForeignKey('groups.id'), nullable=False)
    user_id = db.Column(db.String(36), db.ForeignKey('users.id'), nullable=False)
    role = db.Column(db.String(20), default='member')
    joined_at = db.Column(db.DateTime, default=datetime.utcnow)
    
    __table_args__ = (db.UniqueConstraint('group_id', 'user_id', name='unique_group_member'),)


class TypingStatus(db.Model):
    __tablename__ = 'typing_status'
    
    id = db.Column(db.String(36), primary_key=True, default=lambda: str(uuid.uuid4()))
    user_id = db.Column(db.String(36), db.ForeignKey('users.id'), nullable=False)
    chat_id = db.Column(db.String(36), nullable=False)
    is_typing = db.Column(db.Boolean, default=False)
    updated_at = db.Column(db.DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)


class IntegrationToken(db.Model):
    __tablename__ = 'integration_tokens'
    
    id = db.Column(db.String(36), primary_key=True, default=lambda: str(uuid.uuid4()))
    user_id = db.Column(db.String(36), db.ForeignKey('users.id'), nullable=False)
    service = db.Column(db.String(50), nullable=False)
    access_token = db.Column(db.Text, nullable=True)
    refresh_token = db.Column(db.Text, nullable=True)
    webhook_url = db.Column(db.String(500), nullable=True)
    is_active = db.Column(db.Boolean, default=True)
    created_at = db.Column(db.DateTime, default=datetime.utcnow)
    updated_at = db.Column(db.DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)
    
    __table_args__ = (db.UniqueConstraint('user_id', 'service', name='unique_user_service'),)
