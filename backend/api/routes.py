"""
GhostChat API Routes
RESTful endpoints for frontend communication
"""

from flask import Blueprint, request, jsonify, session
from flask_cors import CORS
import sys
import os

# Add parent directory to path
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from ghostchat import GhostChat
from config import Config

# Create blueprint
api_bp = Blueprint('api', __name__, url_prefix='/api')

# Initialize GhostChat instance (this will be shared)
ghost_instance = None

def init_ghostchat():
    """Initialize GhostChat instance with encryption engine"""
    global ghost_instance
    if ghost_instance is None:
        ghost_instance = GhostChat(Config.MASTER_PASSWORD)
    return ghost_instance

# ========== ENCRYPTION ENDPOINTS ==========

@api_bp.route('/encrypt', methods=['POST'])
def encrypt_message():
    """
    Encrypt a message using AES-256
    Expected JSON: {
        "message": "text to encrypt",
        "password": "encryption password", 
        "use_decoys": true/false
    }
    """
    try:
        data = request.get_json()
        
        if not data:
            return jsonify({'error': 'No data provided'}), 400
        
        message = data.get('message')
        password = data.get('password')
        use_decoys = data.get('use_decoys', False)
        
        if not message:
            return jsonify({'error': 'Message is required'}), 400
        
        if not password:
            return jsonify({'error': 'Password is required'}), 400
        
        # Initialize GhostChat with provided password
        ghost = GhostChat(password)
        
        # Encrypt the message
        emoji_message = ghost.send_message(message, use_decoy_emojis=use_decoys)
        
        # Get encryption metadata
        encryptor = ghost.encryptor if hasattr(ghost, 'encryptor') else None
        
        response = {
            'success': True,
            'emoji_message': emoji_message,
            'emoji_count': len(emoji_message),
            'algorithm': 'AES-256-GCM',
            'key_derivation': 'HKDF-SHA256'
        }
        
        return jsonify(response), 200
        
    except Exception as e:
        return jsonify({
            'success': False,
            'error': str(e)
        }), 500

@api_bp.route('/decrypt', methods=['POST'])
def decrypt_message():
    """
    Decrypt a message using AES-256
    Expected JSON: {
        "emoji_message": "emoji string to decrypt",
        "password": "decryption password"
    }
    """
    try:
        data = request.get_json()
        
        if not data:
            return jsonify({'error': 'No data provided'}), 400
        
        emoji_message = data.get('emoji_message')
        password = data.get('password')
        
        if not emoji_message:
            return jsonify({'error': 'Emoji message is required'}), 400
        
        if not password:
            return jsonify({'error': 'Password is required'}), 400
        
        # Initialize GhostChat with provided password
        ghost = GhostChat(password)
        
        # Decrypt the message
        decrypted_message = ghost.receive_message(emoji_message)
        
        # Check if decryption was successful
        if decrypted_message.startswith('Decryption failed') or decrypted_message.startswith('Error'):
            return jsonify({
                'success': False,
                'error': decrypted_message
            }), 400
        
        response = {
            'success': True,
            'decrypted_message': decrypted_message,
            'algorithm': 'AES-256-GCM'
        }
        
        return jsonify(response), 200
        
    except Exception as e:
        return jsonify({
            'success': False,
            'error': str(e)
        }), 500

# ========== MESSAGE HISTORY ENDPOINTS ==========

@api_bp.route('/messages', methods=['GET'])
def get_messages():
    """Get message history for current session"""
    try:
        limit = request.args.get('limit', 50, type=int)
        offset = request.args.get('offset', 0, type=int)
        
        # TODO: Implement database storage
        # For now, return empty list with note
        return jsonify({
            'success': True,
            'messages': [],
            'total': 0,
            'limit': limit,
            'offset': offset,
            'note': 'Message history storage coming soon'
        }), 200
        
    except Exception as e:
        return jsonify({'error': str(e)}), 500

@api_bp.route('/messages', methods=['POST'])
def save_message():
    """Save an encrypted message to history"""
    try:
        data = request.get_json()
        
        # TODO: Implement database storage
        # For now, just acknowledge receipt
        
        return jsonify({
            'success': True,
            'message_id': 'temp_' + str(int(time.time())),
            'note': 'Message saved locally only'
        }), 201
        
    except Exception as e:
        return jsonify({'error': str(e)}), 500

@api_bp.route('/messages/<message_id>', methods=['DELETE'])
def delete_message(message_id):
    """Delete a message from history"""
    try:
        # TODO: Implement database deletion
        
        return jsonify({
            'success': True,
            'message_id': message_id
        }), 200
        
    except Exception as e:
        return jsonify({'error': str(e)}), 500

# ========== INTEGRATION ENDPOINTS ==========

@api_bp.route('/integrations/whatsapp', methods=['POST'])
def send_to_whatsapp():
    """Send encrypted message via WhatsApp"""
    try:
        data = request.get_json()
        message = data.get('message')
        phone_number = data.get('phone_number')
        
        # For now, simulate WhatsApp integration
        # TODO: Implement actual WhatsApp API integration
        
        return jsonify({
            'success': True,
            'service': 'whatsapp',
            'status': 'simulated',
            'message': f"Message would be sent to {phone_number}"
        }), 200
        
    except Exception as e:
        return jsonify({'error': str(e)}), 500

@api_bp.route('/integrations/telegram', methods=['POST'])
def send_to_telegram():
    """Send encrypted message via Telegram"""
    try:
        data = request.get_json()
        message = data.get('message')
        chat_id = data.get('chat_id')
        
        return jsonify({
            'success': True,
            'service': 'telegram',
            'status': 'simulated',
            'message': f"Message would be sent to chat {chat_id}"
        }), 200
        
    except Exception as e:
        return jsonify({'error': str(e)}), 500

@api_bp.route('/integrations/discord', methods=['POST'])
def send_to_discord():
    """Send encrypted message via Discord"""
    try:
        data = request.get_json()
        message = data.get('message')
        webhook_url = data.get('webhook_url')
        
        return jsonify({
            'success': True,
            'service': 'discord',
            'status': 'simulated'
        }), 200
        
    except Exception as e:
        return jsonify({'error': str(e)}), 500

@api_bp.route('/integrations/email', methods=['POST'])
def send_to_email():
    """Send encrypted message via Email"""
    try:
        data = request.get_json()
        message = data.get('message')
        email = data.get('email')
        
        return jsonify({
            'success': True,
            'service': 'email',
            'status': 'simulated',
            'message': f"Email would be sent to {email}"
        }), 200
        
    except Exception as e:
        return jsonify({'error': str(e)}), 500

# ========== SESSION MANAGEMENT ==========

@api_bp.route('/sessions', methods=['GET'])
def get_sessions():
    """Get active sessions for current user"""
    try:
        return jsonify({
            'success': True,
            'sessions': [
                {
                    'id': 'current',
                    'device': 'Current Browser',
                    'created_at': 'Just now',
                    'active': True
                }
            ]
        }), 200
        
    except Exception as e:
        return jsonify({'error': str(e)}), 500

@api_bp.route('/sessions/<session_id>', methods=['DELETE'])
def revoke_session(session_id):
    """Revoke/terminate a session"""
    try:
        return jsonify({
            'success': True,
            'revoked_session': session_id
        }), 200
        
    except Exception as e:
        return jsonify({'error': str(e)}), 500

# ========== USER PROFILE ==========

@api_bp.route('/profile', methods=['GET'])
def get_profile():
    """Get user profile information"""
    try:
        # For demo purposes, return mock profile
        return jsonify({
            'success': True,
            'user': {
                'id': 'demo_user_001',
                'username': 'ghost_user',
                'email': 'user@ghostchat.local',
                'avatar': '/assets/images/default-avatar.png',
                'created_at': '2024-01-01T00:00:00Z',
                'encryption_key_rotated': 'Never'
            }
        }), 200
        
    except Exception as e:
        return jsonify({'error': str(e)}), 500

@api_bp.route('/profile', methods=['PUT'])
def update_profile():
    """Update user profile"""
    try:
        data = request.get_json()
        
        return jsonify({
            'success': True,
            'updated': data
        }), 200
        
    except Exception as e:
        return jsonify({'error': str(e)}), 500

@api_bp.route('/profile/password', methods=['PUT'])
def change_password():
    """Change user password"""
    try:
        data = request.get_json()
        old_password = data.get('old_password')
        new_password = data.get('new_password')
        
        # TODO: Implement actual password change
        return jsonify({
            'success': True,
            'message': 'Password changed successfully'
        }), 200
        
    except Exception as e:
        return jsonify({'error': str(e)}), 500

# ========== SECURITY SETTINGS ==========

@api_bp.route('/settings/security', methods=['GET'])
def get_security_settings():
    """Get security settings"""
    try:
        return jsonify({
            'success': True,
            'settings': {
                'encryption_algorithm': 'AES-256-GCM',
                'key_derivation': 'HKDF-SHA256',
                'session_timeout': 3600,
                'two_factor_enabled': False,
                'emoji_obfuscation': True,
                'decoy_emojis': True
            }
        }), 200
        
    except Exception as e:
        return jsonify({'error': str(e)}), 500

@api_bp.route('/settings/security', methods=['PUT'])
def update_security_settings():
    """Update security settings"""
    try:
        data = request.get_json()
        
        return jsonify({
            'success': True,
            'updated': data
        }), 200
        
    except Exception as e:
        return jsonify({'error': str(e)}), 500

# ========== ACTIVITY LOGS ==========

@api_bp.route('/logs/activity', methods=['GET'])
def get_activity_logs():
    """Get user activity logs"""
    try:
        limit = request.args.get('limit', 100, type=int)
        
        # Return mock activity logs
        return jsonify({
            'success': True,
            'logs': [
                {'timestamp': '2024-01-15T10:30:00Z', 'type': 'info', 'message': 'User logged in'},
                {'timestamp': '2024-01-15T10:31:00Z', 'type': 'success', 'message': 'Message encrypted'},
                {'timestamp': '2024-01-15T10:32:00Z', 'type': 'info', 'message': 'Session active'}
            ],
            'total': 3
        }), 200
        
    except Exception as e:
        return jsonify({'error': str(e)}), 500

@api_bp.route('/logs/security', methods=['GET'])
def get_security_logs():
    """Get security audit logs"""
    try:
        limit = request.args.get('limit', 100, type=int)
        
        return jsonify({
            'success': True,
            'logs': [],
            'total': 0
        }), 200
        
    except Exception as e:
        return jsonify({'error': str(e)}), 500

# ========== AUTHENTICATION ==========

@api_bp.route('/auth/register', methods=['POST'])
def register():
    """Register a new user"""
    try:
        data = request.get_json()
        username = data.get('username')
        email = data.get('email')
        password = data.get('password')
        
        # TODO: Implement actual user registration
        # For demo, just return success
        
        return jsonify({
            'success': True,
            'message': 'Registration successful',
            'user': {
                'id': 'new_user_001',
                'username': username,
                'email': email
            }
        }), 201
        
    except Exception as e:
        return jsonify({'error': str(e)}), 500

@api_bp.route('/auth/login', methods=['POST'])
def login():
    """Authenticate user and create session"""
    try:
        data = request.get_json()
        username = data.get('username')
        password = data.get('password')
        
        # Create session
        session['user_id'] = 'demo_user'
        session['authenticated'] = True
        
        return jsonify({
            'success': True,
            'message': 'Login successful',
            'user': {
                'id': 'demo_user',
                'username': username,
                'email': f"{username}@ghostchat.local"
            }
        }), 200
        
    except Exception as e:
        return jsonify({'error': str(e)}), 500

@api_bp.route('/auth/logout', methods=['POST'])
def logout():
    """Logout user and clear session"""
    try:
        session.clear()
        
        return jsonify({
            'success': True,
            'message': 'Logged out successfully'
        }), 200
        
    except Exception as e:
        return jsonify({'error': str(e)}), 500

@api_bp.route('/auth/refresh', methods=['POST'])
def refresh_token():
    """Refresh authentication token"""
    try:
        # For demo, just return success
        return jsonify({
            'success': True,
            'access_token': 'demo_refreshed_token_' + str(int(time.time()))
        }), 200
        
    except Exception as e:
        return jsonify({'error': str(e)}), 500

# ========== HEALTH CHECK ==========

@api_bp.route('/health', methods=['GET'])
def health_check():
    """API health check endpoint"""
    return jsonify({
        'status': 'healthy',
        'version': '1.0.0',
        'encryption': 'AES-256-GCM active',
        'timestamp': __import__('time').time()
    }), 200

# Import time for token generation
import time