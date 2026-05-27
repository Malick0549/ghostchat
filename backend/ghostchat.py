# ghostchat.py
"""
GhostChat — Complete Secure Messaging Pipeline  v3.1

SEND FLOW:
  Plaintext → AES-256-CBC Encrypt → (ciphertext, iv, salt) →
  Emoji-obfuscate ciphertext → Bundle as "emojis GHOST iv_b64 GHOST salt_b64"

RECEIVE FLOW:
  Split on GHOST → emojis → ciphertext (Base64) →
  Rebuild AES engine from (password + salt) → AES-256 Decrypt → Plaintext

WHY A PACKET?
  The AES engine produces ciphertext + IV + salt separately.
  Without all three the receiver cannot decrypt. Bundling into one
  opaque string means the frontend stores and passes one value,
  and decryption always has everything it needs — across page reloads
  and between different users.
"""

import os
import base64
from typing import Optional

from crypto.aes_engine          import AES256Engine
from crypto.session_key_manager import SessionKeyManager
from obfuscation.emoji_mapper   import EmojiMapper

try:
    from utils.secure_logger import log_encryption, log_decryption
except ImportError:
    def log_encryption(length, success, error=None, user_id=None): pass
    def log_decryption(success, error=None, user_id=None): pass

try:
    from config import get_config
    _SESSION_DURATION = get_config().session.duration_seconds
except Exception:
    _SESSION_DURATION = 3600

# ── Packet separator ──────────────────────────────────────────────────────────
# Never appears in Base64 output or in emoji characters.
_SEP = "GHOST"


class GhostChatError(Exception):
    pass


class GhostChat:
    """
    Complete messaging pipeline.

        gc = GhostChat("shared_password")
        packet = gc.send_message("Hello secret world!")
        # packet is ONE string — share it anywhere

        gc2 = GhostChat("shared_password")
        plain = gc2.receive_message(packet)
        # plain == "Hello secret world!"
    """

    def __init__(self, password: str):
        if not password or not isinstance(password, str):
            raise ValueError("Password must be a non-empty string")
        if not password.strip():
            raise ValueError("Password cannot be empty or whitespace")
        self.password    = password.strip()
        self.key_manager = SessionKeyManager(session_duration=_SESSION_DURATION)

    # ── Public API ────────────────────────────────────────────────────────────

    def send_message(self, plaintext: str,
                     use_decoy_emojis: bool = False) -> str:
        """
        Encrypt and return a self-contained GHOST packet string.

        Returns:
            "emojisGHOSTiv_b64GHOSTsalt_b64"
        """
        if not plaintext or not isinstance(plaintext, str):
            raise GhostChatError("Message must be a non-empty string")
        plaintext = plaintext.strip()
        if not plaintext:
            raise GhostChatError("Message cannot be empty")

        try:
            engine = AES256Engine(self.password)
            result = engine.encrypt(plaintext)

            ciphertext_b64 = result['ciphertext']
            iv_b64         = result['iv']
            salt_b64       = result['salt']

            emojis = EmojiMapper.text_to_emojis(ciphertext_b64, deterministic=False)
            packet = _SEP.join([emojis, iv_b64, salt_b64])

            log_encryption(len(plaintext), True)
            return packet

        except GhostChatError:
            raise
        except Exception as exc:
            log_encryption(len(plaintext) if plaintext else 0, False, error=str(exc))
            raise GhostChatError(f"Encryption failed: {exc}") from exc

    def receive_message(self, packet: str) -> str:
        """
        Decrypt a GHOST packet. Never raises — returns error string on failure.
        """
        try:
            return self._decrypt(packet)
        except GhostChatError as exc:
            log_decryption(False, error=str(exc))
            return f"Decryption failed: {exc}"
        except Exception as exc:
            log_decryption(False, error=str(exc))
            return f"Decryption failed: Unexpected error — {exc}"

    # ── Internal ──────────────────────────────────────────────────────────────

    def _decrypt(self, packet: str) -> str:
        if not packet or not isinstance(packet, str):
            raise GhostChatError("Packet must be a non-empty string")

        packet = packet.strip()
        parts  = packet.split(_SEP)

        if len(parts) != 3:
            raise GhostChatError(
                f"Invalid packet — expected 3 parts separated by '{_SEP}', "
                f"got {len(parts)}. Paste the complete encrypted output."
            )

        emojis, iv_b64, salt_b64 = [p.strip() for p in parts]

        if not emojis:
            raise GhostChatError("Packet emoji section is empty")
        if not iv_b64:
            raise GhostChatError("Packet IV section is empty")
        if not salt_b64:
            raise GhostChatError("Packet salt section is empty")

        # Reverse emoji obfuscation
        try:
            ciphertext_b64 = EmojiMapper.emojis_to_text(emojis)
        except Exception as exc:
            raise GhostChatError(f"Emoji decode failed: {exc}") from exc

        if not ciphertext_b64:
            raise GhostChatError("Emoji decode produced empty result")

        # Decode salt and rebuild engine with same key
        try:
            salt_bytes = base64.b64decode(salt_b64)
        except Exception as exc:
            raise GhostChatError(f"Invalid salt encoding: {exc}") from exc

        try:
            engine = AES256Engine(self.password, salt=salt_bytes)
        except Exception as exc:
            raise GhostChatError(f"Key derivation failed: {exc}") from exc

        # AES-256-CBC decrypt
        try:
            plaintext = engine.decrypt(ciphertext_b64, iv_b64)
        except ValueError as exc:
            raise GhostChatError(
                "Wrong password or corrupted packet."
            ) from exc
        except Exception as exc:
            raise GhostChatError(f"AES error: {exc}") from exc

        log_decryption(True)
        return plaintext