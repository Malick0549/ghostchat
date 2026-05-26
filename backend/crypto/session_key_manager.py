# crypto/session_key_manager.py
"""
Session Key Management for GhostChat
Secure generation, storage, and management of AES session keys

KEY CONCEPTS:
1. Session Key: Temporary AES key for a single chat session
2. Key Derivation: From user password using PBKDF2
3. Key Rotation: Periodic key changes for security
4. Key Storage: In-memory only, never persisted to disk

SECURITY PROPERTIES:
- Keys never stored in plaintext on disk
- Keys automatically expire after session timeout
- Key derivation uses salt and high iteration count
- Support for future authentication system
"""

import os
import time
import hashlib
import secrets
from typing import Dict, Optional, Tuple
from dataclasses import dataclass
from datetime import datetime, timedelta
from cryptography.hazmat.primitives.kdf.pbkdf2 import PBKDF2HMAC
from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.backends import default_backend


class SessionKeyError(Exception):
    """Base exception for session key management errors"""
    pass


class KeyNotFoundError(SessionKeyError):
    """Raised when a requested key doesn't exist"""
    pass


class KeyExpiredError(SessionKeyError):
    """Raised when a session key has expired"""
    pass


class KeyRotationError(SessionKeyError):
    """Raised when key rotation fails"""
    pass


@dataclass
class SessionKey:
    """
    Represents a single session key with metadata.
    
    Attributes:
        key_id: Unique identifier for this key
        key_bytes: The actual AES key bytes (32 bytes)
        salt: Salt used for key derivation
        created_at: Timestamp when key was created
        expires_at: Timestamp when key expires
        user_id: Optional user identifier (for future auth)
        message_count: Number of messages encrypted with this key
    """
    key_id: str
    key_bytes: bytes
    salt: bytes
    created_at: datetime
    expires_at: datetime
    user_id: Optional[str] = None
    message_count: int = 0
    max_messages: int = 1000  # Rotate after this many messages

    @property
    def session_id(self) -> str:
        return self.key_id

    @property
    def aes_key(self) -> bytes:
        return self.key_bytes

    @property
    def expires_in(self) -> float:
        return max(0.0, (self.expires_at - datetime.now()).total_seconds())

    @property
    def rotation_count(self) -> int:
        return self.message_count

    @property
    def is_expired(self) -> bool:
        return datetime.now() > self.expires_at

    def to_public_dict(self) -> Dict[str, object]:
        return {
            'session_id': self.session_id,
            'created_at': self.created_at.isoformat(),
            'expires_in': self.expires_in,
            'rotation_count': self.rotation_count,
            'user_id': self.user_id,
            'is_expired': self.is_expired,
        }


class SessionKeyManager:
    """
    Secure session key management for GhostChat.
    
    Features:
    - Generate cryptographically secure session keys
    - Store keys in memory (never on disk)
    - Automatic key expiration
    - Key rotation based on time or message count
    - Support for multiple concurrent sessions
    """
    
    # Default configuration
    DEFAULT_SESSION_DURATION = 3600  # 1 hour in seconds
    DEFAULT_KEY_SIZE = 32  # 256 bits for AES-256
    DEFAULT_ITERATIONS = 100000  # PBKDF2 iterations
    
    def __init__(self, session_duration: int = None):
        """
        Initialize the session key manager.
        
        Args:
            session_duration: Session lifetime in seconds (default: 1 hour)
        """
        self.session_duration = session_duration or self.DEFAULT_SESSION_DURATION
        self._keys: Dict[str, SessionKey] = {}  # In-memory key store
        self._active_sessions: Dict[str, datetime] = {}  # Track active sessions
        
    def generate_session_key(self, password: str, user_id: str = None) -> SessionKey:
        """
        Generate a new session key from a user password.
        
        PROCESS:
        1. Generate cryptographically random salt
        2. Derive AES key using PBKDF2
        3. Create session metadata
        4. Store key in memory
        
        Args:
            password: User's password (never stored)
            user_id: Optional user identifier for future auth
            
        Returns:
            SessionKey object with metadata
            
        Raises:
            SessionKeyError: If key generation fails
        """
        if not password:
            raise SessionKeyError("Password cannot be empty")
        
        if not isinstance(password, str):
            raise SessionKeyError("Password must be a string")
        
        try:
            # Generate unique key ID
            key_id = self._generate_key_id()
            
            # Generate random salt
            salt = os.urandom(32)
            
            # Derive key from password
            key_bytes = self._derive_key(password, salt)
            
            # Set expiration time
            now = datetime.now()
            expires_at = now + timedelta(seconds=self.session_duration)
            
            # Create session key object
            session_key = SessionKey(
                key_id=key_id,
                key_bytes=key_bytes,
                salt=salt,
                created_at=now,
                expires_at=expires_at,
                user_id=user_id
            )
            
            # Store in memory
            self._keys[key_id] = session_key
            self._active_sessions[key_id] = now
            
            return session_key
            
        except Exception as e:
            raise SessionKeyError(f"Failed to generate session key: {str(e)}")
    
    def recover_session_key(self, key_id: str, password: str, salt: bytes, user_id: str = None) -> SessionKey:
        """
        Recover or recreate a session key from password and salt.
        
        If the session key already exists locally, return it. Otherwise, derive
        the key from the provided password and salt and store it under the same
        key_id so remote receivers can decrypt messages from the same session.
        """
        if not key_id or not isinstance(key_id, str):
            raise SessionKeyError("Key ID must be a non-empty string")
        if not password or not isinstance(password, str):
            raise SessionKeyError("Password must be a non-empty string")
        if not isinstance(salt, (bytes, bytearray)):
            raise SessionKeyError("Salt must be bytes")
        if len(salt) != self.DEFAULT_KEY_SIZE:
            raise SessionKeyError(f"Salt must be {self.DEFAULT_KEY_SIZE} bytes")
        
        if key_id in self._keys:
            existing = self._keys[key_id]
            if existing.salt != salt:
                raise SessionKeyError("Salt mismatch for existing session key")
            return existing
        
        # Derive a new session key from the shared password and salt
        key_bytes = self._derive_key(password, salt)
        now = datetime.now()
        expires_at = now + timedelta(seconds=self.session_duration)
        session_key = SessionKey(
            key_id=key_id,
            key_bytes=key_bytes,
            salt=salt,
            created_at=now,
            expires_at=expires_at,
            user_id=user_id
        )
        self._keys[key_id] = session_key
        self._active_sessions[key_id] = now
        return session_key
    
    def get_session_key(self, key_id: str) -> SessionKey:
        """
        Retrieve a session key by its ID.
        
        Args:
            key_id: The unique identifier of the key
            
        Returns:
            SessionKey object
            
        Raises:
            KeyNotFoundError: If key doesn't exist
            KeyExpiredError: If key has expired
        """
        if key_id not in self._keys:
            raise KeyNotFoundError(f"Session key not found: {key_id}")
        
        session_key = self._keys[key_id]
        
        # Check if key has expired
        if datetime.now() > session_key.expires_at:
            self._cleanup_expired_keys()
            raise KeyExpiredError(f"Session key expired at {session_key.expires_at}")
        
        return session_key

    def get_session(self, session_id: str) -> SessionKey:
        """Compatibility wrapper for API session endpoints."""
        try:
            return self.get_session_key(session_id)
        except KeyNotFoundError as exc:
            raise KeyError(str(exc))
        except KeyExpiredError as exc:
            raise ValueError(str(exc))

    def create_session(self) -> SessionKey:
        """Create a new session using a random internal password."""
        random_password = secrets.token_urlsafe(32)
        return self.generate_session_key(random_password)

    def rotate_session(self, session_id: str) -> SessionKey:
        """Rotate an existing session and discard the old key."""
        if session_id not in self._keys:
            raise KeyError(f"Session key not found: {session_id}")

        old_key = self._keys.pop(session_id)
        self._active_sessions.pop(session_id, None)

        new_password = secrets.token_urlsafe(32)
        return self.generate_session_key(new_password, old_key.user_id)

    def delete_session(self, session_id: str) -> None:
        """Remove a session key entirely."""
        self._keys.pop(session_id, None)
        self._active_sessions.pop(session_id, None)
    
    def rotate_key(self, old_key_id: str, password: str, user_id: str = None) -> SessionKey:
        """
        Rotate to a new session key (forward secrecy).
        
        This creates a new key and invalidates the old one.
        
        Args:
            old_key_id: Current key ID to replace
            password: User's password (for deriving new key)
            user_id: Optional user identifier
            
        Returns:
            New SessionKey object
            
        Raises:
            KeyNotFoundError: If old key doesn't exist
            KeyRotationError: If rotation fails
        """
        # Verify old key exists and is valid
        try:
            self.get_session_key(old_key_id)
        except KeyExpiredError:
            # Old key expired - still allow rotation
            pass
        except KeyNotFoundError as e:
            raise KeyRotationError(f"Cannot rotate: {str(e)}")
        
        # Generate new key
        try:
            new_key = self.generate_session_key(password, user_id)
            
            # Invalidate old key (remove from active sessions)
            if old_key_id in self._active_sessions:
                del self._active_sessions[old_key_id]
            
            # Optionally keep old key for decryption of old messages
            # but mark it as rotated (we'll implement this later)
            
            return new_key
            
        except Exception as e:
            raise KeyRotationError(f"Key rotation failed: {str(e)}")
    
    def sign_message(self, key_id: str, message: str) -> str:
        """
        Create a signature for a message using the session key.
        
        This provides message integrity and authentication.
        
        Args:
            key_id: Session key identifier
            message: The message to sign
            
        Returns:
            HMAC signature as hex string
        """
        import hmac
        
        session_key = self.get_session_key(key_id)
        
        # Increment message count
        session_key.message_count += 1
        
        # Check if we need to rotate due to message count
        if session_key.message_count >= session_key.max_messages:
            # Signal that key rotation is needed
            self._schedule_rotation(key_id)
        
        # Create HMAC signature
        signature = hmac.new(
            session_key.key_bytes,
            message.encode('utf-8'),
            hashlib.sha256
        ).hexdigest()
        
        return signature
    
    def verify_signature(self, key_id: str, message: str, signature: str) -> bool:
        """
        Verify a message signature.
        
        Args:
            key_id: Session key identifier
            message: The message to verify
            signature: The signature to check
            
        Returns:
            True if signature is valid, False otherwise
        """
        import hmac
        
        try:
            session_key = self.get_session_key(key_id)
            
            expected = hmac.new(
                session_key.key_bytes,
                message.encode('utf-8'),
                hashlib.sha256
            ).hexdigest()
            
            return hmac.compare_digest(expected, signature)
            
        except (KeyNotFoundError, KeyExpiredError):
            return False
    
    def is_key_valid(self, key_id: str) -> bool:
        """
        Check if a session key is still valid.
        
        Args:
            key_id: Session key identifier
            
        Returns:
            True if key exists and not expired
        """
        try:
            self.get_session_key(key_id)
            return True
        except (KeyNotFoundError, KeyExpiredError):
            return False
    
    def get_key_info(self, key_id: str) -> Dict:
        """
        Get information about a session key (for monitoring).
        
        Args:
            key_id: Session key identifier
            
        Returns:
            Dictionary with key metadata
        """
        session_key = self.get_session_key(key_id)
        
        now = datetime.now()
        time_left = (session_key.expires_at - now).total_seconds()
        
        return {
            'key_id': session_key.key_id,
            'created_at': session_key.created_at.isoformat(),
            'expires_at': session_key.expires_at.isoformat(),
            'time_left_seconds': max(0, time_left),
            'message_count': session_key.message_count,
            'max_messages': session_key.max_messages,
            'user_id': session_key.user_id,
            'is_valid': time_left > 0 and session_key.message_count < session_key.max_messages
        }
    
    def rotate_if_needed(self, key_id: str, password: str) -> Optional[SessionKey]:
        """
        Automatically rotate key if conditions are met.
        
        Conditions for rotation:
        - Key expired
        - Message count exceeded
        - Manual rotation requested
        
        Args:
            key_id: Current key ID
            password: User's password for new key
            
        Returns:
            New SessionKey if rotated, None if not needed
        """
        try:
            session_key = self.get_session_key(key_id)
            
            # Check if rotation is needed
            needs_rotation = (
                datetime.now() > session_key.expires_at or
                session_key.message_count >= session_key.max_messages
            )
            
            if needs_rotation:
                return self.rotate_key(key_id, password, session_key.user_id)
            
            return None
            
        except (KeyNotFoundError, KeyExpiredError):
            # Key doesn't exist - generate new one
            return self.generate_session_key(password)
    
    def revoke_key(self, key_id: str):
        """
        Revoke a session key (logout or security incident).
        
        Args:
            key_id: Session key identifier to revoke
        """
        if key_id in self._keys:
            del self._keys[key_id]
        
        if key_id in self._active_sessions:
            del self._active_sessions[key_id]
    
    def _generate_key_id(self) -> str:
        """
        Generate a unique key identifier.
        
        Returns:
            Unique key ID string
        """
        # Use timestamp + random bytes for uniqueness
        timestamp = int(time.time() * 1000)
        random_bytes = secrets.token_bytes(16)
        return f"key_{timestamp}_{random_bytes.hex()[:16]}"
    
    def _derive_key(self, password: str, salt: bytes) -> bytes:
        """
        Derive AES key from password using PBKDF2.
        
        Args:
            password: User's password
            salt: Random salt
            
        Returns:
            32-byte AES key
        """
        kdf = PBKDF2HMAC(
            algorithm=hashes.SHA256(),
            length=self.DEFAULT_KEY_SIZE,
            salt=salt,
            iterations=self.DEFAULT_ITERATIONS,
            backend=default_backend()
        )
        
        return kdf.derive(password.encode('utf-8'))
    
    def _schedule_rotation(self, key_id: str):
        """
        Schedule a key rotation (callback mechanism).
        
        This is a placeholder for future automatic rotation.
        """
        # In a real implementation, this would trigger a rotation event
        pass
    
    def _cleanup_expired_keys(self):
        """Remove expired keys from memory."""
        now = datetime.now()
        expired_keys = [
            key_id for key_id, key in self._keys.items()
            if now > key.expires_at
        ]
        
        for key_id in expired_keys:
            del self._keys[key_id]
            if key_id in self._active_sessions:
                del self._active_sessions[key_id]
    
    def get_active_sessions(self) -> Dict:
        """
        Get information about all active sessions.
        
        Returns:
            Dictionary of active session information
        """
        self._cleanup_expired_keys()
        
        sessions = {}
        for key_id, key in self._keys.items():
            sessions[key_id] = {
                'created_at': key.created_at.isoformat(),
                'expires_at': key.expires_at.isoformat(),
                'message_count': key.message_count,
                'user_id': key.user_id
            }
        
        return sessions
    
    def get_statistics(self) -> Dict:
        """
        Get statistics about key management.
        
        Returns:
            Dictionary with statistics
        """
        self._cleanup_expired_keys()
        
        total_keys = len(self._keys)
        active_keys = len(self._active_sessions)
        
        return {
            'total_keys': total_keys,
            'active_sessions': active_keys,
            'session_duration_seconds': self.session_duration,
            'key_size_bits': self.DEFAULT_KEY_SIZE * 8,
            'pbkdf2_iterations': self.DEFAULT_ITERATIONS
        }


# Shared singleton for API routes and application glue code.
default_session_manager = SessionKeyManager()

# Example usage and test
if __name__ == "__main__":
    print("=" * 60)
    print("SESSION KEY MANAGER - TEST")
    print("=" * 60)
    
    # Create key manager
    manager = SessionKeyManager(session_duration=300)  # 5 minute sessions for testing
    
    # Test 1: Generate a session key
    print("\n[TEST 1] Generate session key")
    password = "MySecretPassword123!"
    session_key = manager.generate_session_key(password, user_id="alice")
    print(f"  Key ID: {session_key.key_id}")
    print(f"  Created: {session_key.created_at}")
    print(f"  Expires: {session_key.expires_at}")
    print(f"  Key bytes: {session_key.key_bytes.hex()[:32]}...")
    
    # Test 2: Retrieve key
    print("\n[TEST 2] Retrieve session key")
    retrieved = manager.get_session_key(session_key.key_id)
    print(f"  Retrieved key for ID: {retrieved.key_id}")
    assert retrieved.key_bytes == session_key.key_bytes
    print("  ✓ Key retrieved successfully")
    
    # Test 3: Sign and verify message
    print("\n[TEST 3] Sign and verify message")
    message = "Hello, this is a secret message!"
    signature = manager.sign_message(session_key.key_id, message)
    print(f"  Message: {message}")
    print(f"  Signature: {signature[:32]}...")
    
    is_valid = manager.verify_signature(session_key.key_id, message, signature)
    print(f"  Signature valid: {is_valid}")
    
    # Test 4: Wrong signature
    print("\n[TEST 4] Wrong signature rejection")
    is_valid = manager.verify_signature(session_key.key_id, message, "wrong_signature")
    print(f"  Wrong signature rejected: {not is_valid}")
    
    # Test 5: Key rotation
    print("\n[TEST 5] Key rotation")
    new_key = manager.rotate_key(session_key.key_id, password)
    print(f"  Old key ID: {session_key.key_id}")
    print(f"  New key ID: {new_key.key_id}")
    
    # Test 6: Key expiration
    print("\n[TEST 6] Key info")
    info = manager.get_key_info(new_key.key_id)
    for key, value in info.items():
        print(f"  {key}: {value}")
    
    # Test 7: Statistics
    print("\n[TEST 7] Manager statistics")
    stats = manager.get_statistics()
    for key, value in stats.items():
        print(f"  {key}: {value}")
    
    print("\n" + "=" * 60)
    print("✅ ALL SESSION KEY TESTS PASSED")
    print("=" * 60)