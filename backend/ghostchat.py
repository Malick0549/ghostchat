# ghostchat.py
"""
GhostChat - Complete Secure Messaging Pipeline
Combines AES-256 encryption with emoji obfuscation

ARCHITECTURE:
- Crypto Layer:      AES-256 encryption (REAL security)
- Obfuscation Layer: Emoji conversion  (visual camouflage only)
- This file:         Pipeline orchestration

FLOW:
  Send:    Plaintext → AES-256 Encrypt → Base64 → Emoji string
  Receive: Emoji string → Base64 → AES-256 Decrypt → Plaintext
"""

import os
import json
import base64
from typing import Dict, Optional

# ── Crypto / obfuscation layers ───────────────────────────────────────────────
# NOTE: imports use local package names because flask_app.py runs from inside
# backend/ — so crypto/, obfuscation/, ai/, utils/ are direct siblings.
from crypto.aes_engine              import AES256Engine
from crypto.session_key_manager     import SessionKeyManager
from crypto.authenticated_encryption import AuthenticatedEncryption
from obfuscation.emoji_mapper       import EmojiMapper

# ── Logging helpers ───────────────────────────────────────────────────────────
try:
    from utils.secure_logger import (
        log_encryption, log_decryption, log_authentication
    )
except ImportError:
    # Graceful fallback if logger not configured yet
    def log_encryption(length, success, error=None, user_id=None): pass
    def log_decryption(success, error=None, user_id=None): pass
    def log_authentication(success, reason=None, user_id=None): pass

# ── Configuration ─────────────────────────────────────────────────────────────
try:
    from config import get_config
    _cfg = get_config()
    _SESSION_DURATION = _cfg.session.duration_seconds
except Exception:
    _SESSION_DURATION = 3600  # 1 hour fallback


class GhostChat:
    """
    Complete messaging pipeline: encryption + emoji obfuscation.

    This class does NOT implement crypto or emoji logic — it only
    orchestrates the two independent layers.

    SEPARATION OF CONCERNS:
      • Encryption/Decryption  → AES256Engine
      • Emoji conversion       → EmojiMapper
      • Session management     → SessionKeyManager
      • This class             → Pipeline only
    """

    def __init__(self, password: str):
        """
        Initialise GhostChat with a password.

        Args:
            password: Shared secret used for AES-256 key derivation.

        Raises:
            ValueError: If the password is empty or not a string.
        """
        if not password or not isinstance(password, str):
            raise ValueError("Password must be a non-empty string")
        if not password.strip():
            raise ValueError("Password cannot be empty or whitespace only")

        self.password = password.strip()

        # Session key management
        self.key_manager = SessionKeyManager(session_duration=_SESSION_DURATION)
        self.auth_enc    = AuthenticatedEncryption(self.key_manager)

        # Generate the initial session key from the password
        self.session_key = self.key_manager.generate_session_key(self.password)

    # ── Public API ────────────────────────────────────────────────────────────

    def send(self, plaintext_message: str, deterministic: bool = False) -> Dict:
        """
        Encrypt a plaintext message and obfuscate it as emojis.

        Steps:
          1. Rotate session key if threshold reached.
          2. AES-256-CBC encrypt + HMAC sign (AuthenticatedEncryption).
          3. Base64 ciphertext → emoji string (EmojiMapper).

        Args:
            plaintext_message: The secret message to send.
            deterministic:     Use deterministic emoji mapping (for tests).

        Returns:
            {
              'emoji_message': str,    # share this
              'metadata': {
                  'iv':        str,   # base64
                  'signature': str,   # hex HMAC
                  'key_id':    str,
                  'salt':      str,   # base64
              }
            }

        Raises:
            ValueError:   Bad input or encryption failure.
            RuntimeError: Unexpected internal error.
        """
        if plaintext_message is None:
            raise ValueError("Message cannot be None")
        if not isinstance(plaintext_message, str):
            raise ValueError("Message must be a string")

        plaintext_message = plaintext_message.strip()
        if not plaintext_message:
            raise ValueError("Message cannot be empty")

        # Rotate session key if needed (forward secrecy)
        try:
            rotated = self.key_manager.rotate_if_needed(
                self.session_key.key_id, self.password
            )
            if rotated:
                self.session_key = rotated
        except Exception:
            pass  # Non-fatal — continue with existing key

        try:
            # Step 1: Authenticated AES-256 encryption
            encrypted = self.auth_enc.encrypt(
                self.session_key.key_id, plaintext_message
            )

            ciphertext_b64 = encrypted['ciphertext']
            iv_b64         = encrypted['iv']
            signature      = encrypted['signature']
            key_id         = encrypted['key_id']
            salt_b64       = base64.b64encode(self.session_key.salt).decode('utf-8')

            # Step 2: Emoji obfuscation (camouflage layer — NOT security)
            emoji_message = EmojiMapper.text_to_emojis(
                ciphertext_b64, deterministic=deterministic
            )

            log_encryption(len(plaintext_message), True)

            return {
                'emoji_message': emoji_message,
                'metadata': {
                    'iv':        iv_b64,
                    'signature': signature,
                    'key_id':    key_id,
                    'salt':      salt_b64,
                },
            }

        except ValueError:
            log_encryption(len(plaintext_message), False, error="ValueError")
            raise
        except Exception as exc:
            log_encryption(len(plaintext_message), False, error=str(exc))
            raise RuntimeError(f"Unexpected error during message sending: {exc}") from exc

    # Alias used by routes.py  (/api/encrypt calls ghost.send_message())
    def send_message(self, plaintext_message: str,
                     use_decoy_emojis: bool = False) -> str:
        """
        Alias for send() that returns only the emoji string.
        Used by the Flask route /api/encrypt.

        Args:
            plaintext_message: The secret message.
            use_decoy_emojis:  Ignored — kept for API compatibility.

        Returns:
            Emoji-obfuscated encrypted message string.
        """
        result = self.send(plaintext_message, deterministic=False)
        return result['emoji_message']

    def receive(self, emoji_message: str, metadata: Dict) -> str:
        """
        Decode emojis, verify signature, and decrypt to plaintext.

        Steps:
          1. Emoji string → Base64 ciphertext (EmojiMapper).
          2. Recover session key from shared salt.
          3. Verify HMAC + AES-256 decrypt (AuthenticatedEncryption).

        Args:
            emoji_message: The emoji string received.
            metadata:      Dict with 'iv', 'signature', 'key_id', 'salt'.

        Returns:
            Original plaintext message.

        Raises:
            ValueError:   Invalid input, bad signature, or wrong password.
            RuntimeError: Unexpected internal error.
        """
        if not emoji_message or not isinstance(emoji_message, str):
            raise ValueError("Emoji message must be a non-empty string")
        if not metadata or not isinstance(metadata, dict):
            raise ValueError("Metadata must be a non-empty dictionary")

        required = ('iv', 'signature', 'key_id', 'salt')
        missing  = [k for k in required if k not in metadata or not metadata[k]]
        if missing:
            raise ValueError(f"Metadata missing or empty fields: {missing}")

        iv_b64    = metadata['iv']
        signature = metadata['signature']
        key_id    = metadata['key_id']
        salt_b64  = metadata['salt']

        try:
            # Step 1: Reverse emoji obfuscation
            ciphertext_b64 = EmojiMapper.emojis_to_text(emoji_message)

            # Step 2: Recover session key from shared salt
            try:
                salt_bytes = base64.b64decode(salt_b64)
            except Exception:
                raise ValueError("Invalid salt — not valid base64")

            self.key_manager.recover_session_key(key_id, self.password, salt_bytes)

            # Step 3: Verify + decrypt
            encrypted_package = {
                'ciphertext': ciphertext_b64,
                'iv':         iv_b64,
                'signature':  signature,
                'key_id':     key_id,
            }
            try:
                plaintext = self.auth_enc.decrypt(encrypted_package)
            except Exception as exc:
                msg = str(exc).lower()
                if 'signature' in msg or 'authentication' in msg or 'hmac' in msg:
                    raise ValueError(
                        "Message authentication failed — message may have been tampered with"
                    )
                raise ValueError(f"AES decryption error: {exc}")

            log_decryption(True)
            return plaintext

        except ValueError:
            log_decryption(False, error="ValueError")
            raise
        except Exception as exc:
            log_decryption(False, error=str(exc))
            raise RuntimeError(f"Unexpected error during message reception: {exc}") from exc

    # Alias used by routes.py  (/api/decrypt calls ghost.receive_message())
    def receive_message(self, emoji_message: str,
                        metadata: Optional[Dict] = None) -> str:
        """
        Alias for receive() used by Flask route /api/decrypt.

        When called without metadata (e.g. from the simple API), attempts
        to decode assuming the emoji string carries embedded metadata via
        send_package format.

        Args:
            emoji_message: Emoji-obfuscated message OR JSON package string.
            metadata:      Optional dict with iv / signature / key_id / salt.

        Returns:
            Original plaintext message, or an error string prefixed with
            'Decryption failed:' so the route can detect failure.
        """
        try:
            if metadata:
                return self.receive(emoji_message, metadata)

            # Try to parse as JSON package (from send_package)
            try:
                pkg = json.loads(emoji_message)
                if isinstance(pkg, dict) and 'emojis' in pkg:
                    return self.receive(pkg['emojis'], {
                        'iv':        pkg.get('iv', ''),
                        'signature': pkg.get('signature', ''),
                        'key_id':    pkg.get('key_id', ''),
                        'salt':      pkg.get('salt', ''),
                    })
            except (json.JSONDecodeError, TypeError):
                pass

            # Fallback: treat as raw emoji string with current session
            return self.receive(emoji_message, {
                'iv':        '',
                'signature': '',
                'key_id':    self.session_key.key_id,
                'salt':      base64.b64encode(self.session_key.salt).decode(),
            })

        except (ValueError, RuntimeError) as exc:
            return f"Decryption failed: {exc}"
        except Exception as exc:
            return f"Decryption failed: Unexpected error — {exc}"

    # ── JSON package helpers ──────────────────────────────────────────────────

    def send_package(self, message: str, deterministic: bool = False) -> str:
        """Encrypt and return a self-contained JSON string."""
        result  = self.send(message, deterministic)
        package = {
            'emojis':    result['emoji_message'],
            'iv':        result['metadata']['iv'],
            'signature': result['metadata']['signature'],
            'key_id':    result['metadata']['key_id'],
            'salt':      result['metadata']['salt'],
        }
        return json.dumps(package, ensure_ascii=False)

    def receive_package(self, package_json: str) -> str:
        """Decrypt a JSON package produced by send_package()."""
        if not package_json or not isinstance(package_json, str):
            raise ValueError("Package JSON must be a non-empty string")
        try:
            pkg = json.loads(package_json)
        except json.JSONDecodeError as exc:
            raise ValueError(f"Invalid JSON package: {exc}") from exc
        if not isinstance(pkg, dict):
            raise ValueError("Package must be a JSON object")
        missing = [k for k in ('emojis', 'iv', 'signature', 'key_id', 'salt') if k not in pkg]
        if missing:
            raise ValueError(f"Package missing keys: {missing}")
        return self.receive(pkg['emojis'], {
            'iv':        pkg['iv'],
            'signature': pkg['signature'],
            'key_id':    pkg['key_id'],
            'salt':      pkg['salt'],
        })

    # ── Session helpers ───────────────────────────────────────────────────────

    def rotate_session(self) -> bool:
        """Manually rotate the session key for forward secrecy."""
        try:
            new_key = self.key_manager.rotate_key(
                self.session_key.key_id, self.password
            )
            self.session_key = new_key
            return True
        except Exception:
            return False

    def get_session_info(self) -> Dict:
        """Return public metadata about the current session (no keys)."""
        return self.key_manager.get_key_info(self.session_key.key_id)