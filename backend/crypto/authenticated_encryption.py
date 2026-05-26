# crypto/authenticated_encryption.py
"""
Authenticated Encryption for GhostChat
Combines AES-256 encryption with HMAC authentication

SECURITY PROPERTIES:
- Confidentiality: AES-256-CBC encryption
- Integrity: HMAC-SHA256 message authentication
- Authenticity: Session key verification
- Freshness: Unique IV per message
"""

import os
import base64
import hashlib
import hmac
from typing import Dict, Tuple
from cryptography.hazmat.primitives.ciphers import Cipher, algorithms, modes
from cryptography.hazmat.backends import default_backend

from crypto.session_key_manager import SessionKeyManager, SessionKeyError


class AuthenticatedEncryptionError(Exception):
    """Base exception for authenticated encryption"""
    pass


class AuthenticationFailedError(AuthenticatedEncryptionError):
    """Raised when HMAC verification fails"""
    pass


class AuthenticatedEncryption:
    """
    Provides authenticated encryption using session keys.
    
    Each encrypted message includes:
    - Ciphertext (AES-256 encrypted)
    - IV (Initialization Vector)
    - HMAC signature (for integrity)
    """
    
    BLOCK_SIZE = 16
    IV_SIZE = 16
    
    def __init__(self, key_manager: SessionKeyManager):
        """
        Initialize authenticated encryption.
        
        Args:
            key_manager: SessionKeyManager instance
        """
        self.key_manager = key_manager
    
    def encrypt(self, key_id: str, plaintext: str) -> Dict[str, str]:
        """
        Encrypt and authenticate a message.
        
        Steps:
        1. Get session key
        2. Generate random IV
        3. Encrypt with AES-256-CBC
        4. Create HMAC signature
        5. Return combined package
        
        Args:
            key_id: Session key identifier
            plaintext: Message to encrypt
            
        Returns:
            Dictionary with ciphertext, iv, and signature
        """
        # Get session key
        session_key = self.key_manager.get_session_key(key_id)
        
        # Generate random IV
        iv = os.urandom(self.IV_SIZE)
        
        # Create AES cipher
        cipher = Cipher(
            algorithms.AES(session_key.key_bytes),
            modes.CBC(iv),
            backend=default_backend()
        )
        encryptor = cipher.encryptor()
        
        # Pad and encrypt
        plaintext_bytes = plaintext.encode('utf-8')
        padded_plaintext = self._pad(plaintext_bytes)
        ciphertext = encryptor.update(padded_plaintext) + encryptor.finalize()
        
        # Create HMAC signature (covers ciphertext + IV)
        signature = self._create_signature(session_key.key_bytes, ciphertext, iv)
        
        # Update message count
        session_key.message_count += 1
        
        return {
            'ciphertext': base64.b64encode(ciphertext).decode('utf-8'),
            'iv': base64.b64encode(iv).decode('utf-8'),
            'signature': signature,
            'key_id': key_id
        }
    
    def decrypt(self, encrypted_package: Dict[str, str]) -> str:
        """
        Decrypt and verify a message.
        
        Steps:
        1. Extract components
        2. Verify HMAC signature
        3. Decrypt with AES-256-CBC
        4. Return plaintext
        
        Args:
            encrypted_package: Dictionary with ciphertext, iv, signature, key_id
            
        Returns:
            Original plaintext message
            
        Raises:
            AuthenticationFailedError: If HMAC verification fails
        """
        # Extract components
        key_id = encrypted_package.get('key_id')
        ciphertext_b64 = encrypted_package.get('ciphertext')
        iv_b64 = encrypted_package.get('iv')
        signature = encrypted_package.get('signature')
        
        if not all([key_id, ciphertext_b64, iv_b64, signature]):
            raise AuthenticatedEncryptionError("Missing required fields")
        
        # Get session key
        session_key = self.key_manager.get_session_key(key_id)
        
        # Decode from Base64
        ciphertext = base64.b64decode(ciphertext_b64)
        iv = base64.b64decode(iv_b64)
        
        # Verify signature
        expected_signature = self._create_signature(session_key.key_bytes, ciphertext, iv)
        if not hmac.compare_digest(expected_signature, signature):
            raise AuthenticationFailedError("Message authentication failed - signature mismatch")
        
        # Decrypt
        cipher = Cipher(
            algorithms.AES(session_key.key_bytes),
            modes.CBC(iv),
            backend=default_backend()
        )
        decryptor = cipher.decryptor()
        
        decrypted_padded = decryptor.update(ciphertext) + decryptor.finalize()
        plaintext_bytes = self._unpad(decrypted_padded)
        
        return plaintext_bytes.decode('utf-8')
    
    def _pad(self, data: bytes) -> bytes:
        """Add PKCS7 padding."""
        padding_length = self.BLOCK_SIZE - (len(data) % self.BLOCK_SIZE)
        padding = bytes([padding_length] * padding_length)
        return data + padding
    
    def _unpad(self, data: bytes) -> bytes:
        """Remove PKCS7 padding."""
        padding_length = data[-1]
        if padding_length > self.BLOCK_SIZE:
            raise ValueError("Invalid padding")
        return data[:-padding_length]
    
    def _create_signature(self, key: bytes, ciphertext: bytes, iv: bytes) -> str:
        """Create HMAC signature for ciphertext and IV."""
        # Combine ciphertext and IV for signing
        data = ciphertext + iv
        signature = hmac.new(key, data, hashlib.sha256).hexdigest()
        return signature


# Test
if __name__ == "__main__":
    print("=" * 60)
    print("AUTHENTICATED ENCRYPTION - TEST")
    print("=" * 60)
    
    # Create key manager and authenticated encryption
    key_manager = SessionKeyManager()
    auth_enc = AuthenticatedEncryption(key_manager)
    
    # Generate session key
    password = "test123"
    session_key = key_manager.generate_session_key(password, user_id="test_user")
    print(f"\n✓ Session key generated: {session_key.key_id}")
    
    # Encrypt a message
    original = "This is a secret message with authentication!"
    encrypted = auth_enc.encrypt(session_key.key_id, original)
    print(f"\n✓ Message encrypted")
    print(f"  Signature: {encrypted['signature'][:32]}...")
    
    # Decrypt the message
    decrypted = auth_enc.decrypt(encrypted)
    print(f"\n✓ Message decrypted: {decrypted}")
    
    # Test tampering detection
    print("\n[TEST] Tamper detection")
    tampered = encrypted.copy()
    tampered['signature'] = "fakesignature"
    
    try:
        auth_enc.decrypt(tampered)
        print("  ✗ Should have rejected tampered message")
    except AuthenticationFailedError as e:
        print(f"  ✓ Correctly rejected: {e}")
    
    assert original == decrypted, "Encryption/decryption failed!"
    print("\n✅ ALL TESTS PASSED")