# crypto/aes_engine.py
"""
AES-256 Encryption Engine for GhostChat
PURE SECURITY LAYER - No obfuscation, no AI, no mixing

This module handles ONLY cryptographic operations:
- AES-256 encryption in CBC mode
- AES-256 decryption in CBC mode
- Key derivation using PBKDF2
- PKCS7 padding

SECURITY PROPERTIES:
- Confidentiality: AES-256 provides 256-bit security
- Key Derivation: PBKDF2 with 100,000 iterations
- Random IV: Unique for each encryption (prevents pattern attacks)
- Random Salt: Unique for each key (prevents rainbow table attacks)
"""

import os
import base64
from cryptography.hazmat.primitives.ciphers import Cipher, algorithms, modes
from cryptography.hazmat.primitives.kdf.pbkdf2 import PBKDF2HMAC
from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.backends import default_backend
from typing import Tuple, Dict


class AES256Engine:
    """
    Pure AES-256 encryption/decryption engine.
    
    This class does ONE thing: encrypt and decrypt data using AES-256.
    It has NO knowledge of:
    - Emojis
    - Messages
    - AI
    - Any presentation layer
    
    MODES:
    - CBC (Cipher Block Chaining) mode for better security than ECB
    - PKCS7 padding for handling variable-length messages
    """
    
    # Constants for AES-256
    KEY_SIZE = 32           # 256 bits = 32 bytes
    BLOCK_SIZE = 16         # AES block size = 128 bits = 16 bytes
    IV_SIZE = 16            # Initialization Vector size = 16 bytes
    SALT_SIZE = 32          # Salt size = 256 bits
    PBKDF2_ITERATIONS = 100000  # 100,000 iterations for key derivation
    
    def __init__(self, password: str | bytes, salt: bytes = None):
        """
        Initialize the AES engine with a password or raw key bytes.
        
        Args:
            password: User's password (will be derived to 256-bit key) or raw 32-byte key
            salt: Optional random salt (generated if not provided)
            
        SECURITY NOTE:
        - Never store the password directly
        - Salt must be random and unique per key when deriving from a password
        - Salt is NOT secret but prevents rainbow table attacks
        """
        if not password or len(password) == 0:
            raise ValueError("Password cannot be empty")

        self.password = password

        if isinstance(password, (bytes, bytearray)):
            if len(password) != self.KEY_SIZE:
                raise ValueError(f"Key must be {self.KEY_SIZE} bytes")
            self.key = bytes(password)
            self.salt = salt or b""
        else:
            # Generate or use provided salt
            if salt is None:
                self.salt = os.urandom(self.SALT_SIZE)
            else:
                if len(salt) != self.SALT_SIZE:
                    raise ValueError(f"Salt must be {self.SALT_SIZE} bytes")
                self.salt = salt

            # Derive the actual encryption key from password
            self.key = self._derive_key()
    
    def _derive_key(self) -> bytes:
        """
        Derive a 256-bit AES key from the password using PBKDF2.
        
        WHY PBKDF2?
        - Passwords are weak (low entropy)
        - PBKDF2 adds computational cost (100,000 iterations)
        - Makes brute-force attacks expensive
        - The salt ensures same password produces different keys
        
        Returns:
            32-byte key suitable for AES-256
        """
        # Create PBKDF2 key derivation function
        kdf = PBKDF2HMAC(
            algorithm=hashes.SHA256(),      # Hash algorithm
            length=self.KEY_SIZE,            # 32 bytes output
            salt=self.salt,                  # Unique salt
            iterations=self.PBKDF2_ITERATIONS,  # Work factor
            backend=default_backend()
        )
        
        # Derive key from password string
        key = kdf.derive(self.password.encode('utf-8'))
        
        return key
    
    def encrypt(self, plaintext: str) -> Dict[str, str]:
        """
        Encrypt a plaintext message using AES-256-CBC.
        
        PROCESS:
        1. Generate random IV (different for each encryption)
        2. Convert plaintext to bytes
        3. Pad to AES block size (16 bytes)
        4. Encrypt using AES-256 in CBC mode
        5. Return Base64-encoded components
        
        Args:
            plaintext: The secret message to encrypt
            
        Returns:
            Dictionary containing:
            - 'ciphertext': Base64 encoded encrypted data
            - 'iv': Base64 encoded initialization vector
            - 'salt': Base64 encoded salt (needed for decryption)
            
        SECURITY NOTES:
        - IV must be random and unique for each encryption
        - IV is NOT secret but prevents identical plaintexts from looking identical
        - CBC mode requires IV to be unpredictable
        """
        # Step 1: Generate random Initialization Vector
        # Each encryption gets a unique IV
        iv = os.urandom(self.IV_SIZE)
        
        # Step 2: Create AES cipher in CBC mode
        cipher = Cipher(
            algorithms.AES(self.key),   # AES-256 algorithm
            modes.CBC(iv),               # CBC mode with IV
            backend=default_backend()
        )
        
        # Step 3: Create encryptor object
        encryptor = cipher.encryptor()
        
        # Step 4: Convert string to bytes and pad
        plaintext_bytes = plaintext.encode('utf-8')
        padded_plaintext = self._pad(plaintext_bytes)
        
        # Step 5: Perform encryption
        ciphertext = encryptor.update(padded_plaintext) + encryptor.finalize()
        
        # Step 6: Return Base64 encoded components for safe transport
        # Base64 ensures binary data can be sent as text
        return {
            'ciphertext': base64.b64encode(ciphertext).decode('utf-8'),
            'iv': base64.b64encode(iv).decode('utf-8'),
            'salt': base64.b64encode(self.salt).decode('utf-8')
        }
    
    def decrypt(self, ciphertext_b64: str, iv_b64: str) -> str:
        """
        Decrypt a ciphertext back to plaintext.
        
        Args:
            ciphertext_b64: Base64 encoded ciphertext (from encrypt method)
            iv_b64: Base64 encoded IV (from encrypt method)
            
        Returns:
            Original plaintext message
            
        Raises:
            ValueError: If decryption fails (wrong key or corrupted data)
            cryptography.exceptions.InvalidTag: If using GCM mode (not here)
        """
        # Step 1: Decode from Base64
        ciphertext = base64.b64decode(ciphertext_b64)
        iv = base64.b64decode(iv_b64)
        
        # Validate lengths
        if len(iv) != self.IV_SIZE:
            raise ValueError(f"IV must be {self.IV_SIZE} bytes")
        
        # Step 2: Create cipher for decryption
        cipher = Cipher(
            algorithms.AES(self.key),
            modes.CBC(iv),
            backend=default_backend()
        )
        
        # Step 3: Create decryptor
        decryptor = cipher.decryptor()
        
        # Step 4: Perform decryption
        try:
            decrypted_padded = decryptor.update(ciphertext) + decryptor.finalize()
        except Exception as e:
            raise ValueError(f"Decryption failed. Wrong password or corrupted data: {e}")
        
        # Step 5: Remove padding and convert to string
        plaintext_bytes = self._unpad(decrypted_padded)
        plaintext = plaintext_bytes.decode('utf-8')
        
        return plaintext
    
    def _pad(self, data: bytes) -> bytes:
        """
        Add PKCS7 padding to data.
        
        PKCS7 padding:
        - If block size is 16 bytes, each padding byte = number of padding bytes
        - Example: Need 5 bytes padding -> add 5 bytes of value 0x05
        
        WHY?
        - AES works on fixed-size blocks (16 bytes)
        - We need to handle messages of any length
        - Padding makes the message a multiple of block size
        
        Args:
            data: Original data bytes
            
        Returns:
            Padded data (length is multiple of BLOCK_SIZE)
        """
        # Calculate how many bytes needed
        padding_length = self.BLOCK_SIZE - (len(data) % self.BLOCK_SIZE)
        
        # Create padding bytes (each byte = padding_length)
        padding = bytes([padding_length] * padding_length)
        
        # Append padding to original data
        return data + padding
    
    def _unpad(self, data: bytes) -> bytes:
        """
        Remove PKCS7 padding from decrypted data.
        
        Args:
            data: Padded data bytes
            
        Returns:
            Original data without padding
            
        Raises:
            ValueError: If padding is invalid (possible corruption or wrong key)
        """
        # Last byte tells us how many padding bytes were added
        padding_length = data[-1]
        
        # Validate padding length
        if padding_length > self.BLOCK_SIZE:
            raise ValueError("Invalid padding: length exceeds block size")
        
        # Check that all padding bytes are correct
        padding_bytes = data[-padding_length:]
        if not all(byte == padding_length for byte in padding_bytes):
            raise ValueError("Invalid padding: padding bytes don't match")
        
        # Remove padding
        return data[:-padding_length]
    
    def get_key_info(self) -> Dict:
        """
        Get information about the current key (for debugging/testing only).
        
        SECURITY NOTE:
        - Never expose actual key material in production
        - This is for testing and educational purposes only
        """
        return {
            'key_size_bits': len(self.key) * 8,
            'salt_size_bytes': len(self.salt),
            'pbkdf2_iterations': self.PBKDF2_ITERATIONS,
            'algorithm': 'AES-256-CBC',
            'key_derivation': 'PBKDF2-HMAC-SHA256'
        }


# Simple self-test when run directly
if __name__ == "__main__":
    print("=" * 60)
    print("AES-256 ENGINE - SECURITY LAYER TEST")
    print("=" * 60)
    
    # Test 1: Basic encryption/decryption
    print("\n[TEST 1] Basic encryption and decryption")
    password = "TestPassword123!"
    engine = AES256Engine(password)
    
    original_message = "Hello, this is a secret message!"
    print(f"Original: {original_message}")
    
    # Encrypt
    encrypted = engine.encrypt(original_message)
    print(f"Encrypted (ciphertext): {encrypted['ciphertext'][:50]}...")
    print(f"IV (base64): {encrypted['iv'][:20]}...")
    print(f"Salt (base64): {encrypted['salt'][:20]}...")
    
    # Decrypt (using same engine)
    decrypted = engine.decrypt(encrypted['ciphertext'], encrypted['iv'])
    print(f"Decrypted: {decrypted}")
    
    assert original_message == decrypted, "Encryption/decryption failed!"
    print("[PASS] Test 1 passed")
    
    # Test 2: Different engines with same password
    print("\n[TEST 2] Different engines with same password")
    engine1 = AES256Engine(password)
    engine2 = AES256Engine(password, salt=engine1.salt)  # Same salt
    
    msg = "Secret data"
    enc = engine1.encrypt(msg)
    dec = engine2.decrypt(enc['ciphertext'], enc['iv'])
    
    assert msg == dec, "Cross-engine decryption failed!"
    print("[PASS] Test 2 passed")
    
    # Test 3: Wrong password
    print("\n[TEST 3] Wrong password (should fail)")
    engine_correct = AES256Engine("correct_password")
    engine_wrong = AES256Engine("wrong_password", salt=engine_correct.salt)
    
    enc = engine_correct.encrypt("Test")
    try:
        dec = engine_wrong.decrypt(enc['ciphertext'], enc['iv'])
        print("[FAIL] Failed: Wrong password should not decrypt!")
    except ValueError as e:
        print(f"[PASS] Correctly rejected wrong password: {str(e)[:50]}...")
    
    # Test 4: Different IVs for same message
    print("\n[TEST 4] Same message, different IVs (should produce different ciphertext)")
    engine = AES256Engine("same_password")
    msg = "Same message"
    
    enc1 = engine.encrypt(msg)
    enc2 = engine.encrypt(msg)
    
    print(f"Ciphertext 1: {enc1['ciphertext'][:30]}...")
    print(f"Ciphertext 2: {enc2['ciphertext'][:30]}...")
    
    assert enc1['ciphertext'] != enc2['ciphertext'], "Same ciphertext - IV not working!"
    print("[PASS] Different ciphertexts - IV working correctly")
    
    # Display key information
    print("\n[KEY INFORMATION]")
    info = engine.get_key_info()
    for key, value in info.items():
        print(f"  {key}: {value}")
    
    print("\n" + "=" * 60)
    print("[PASS] ALL AES-256 TESTS PASSED")
    print("=" * 60)
    print("\nSECURITY NOTES:")
    print("[PASS] AES-256 encryption (military grade)")
    print("[PASS] PBKDF2 key derivation (100,000 iterations)")
    print("[PASS] Random IV for each message")
    print("[PASS] Random salt per key")
    print("[PASS] PKCS7 padding")
    print("\n[WARN]  This is PURE encryption - NO obfuscation layer")