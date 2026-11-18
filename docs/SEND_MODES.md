# Encrypt / Decrypt tool: how to send

**Encrypt → "How do you want to send it?"**

1. **To a GhostChat user** (default). Search for the person and pick them. The browser makes a fresh random 256-bit content key, encrypts the message with AES-256-GCM, then locks that key to the receiver's public key (one-time ECDH P-256 key pair + HKDF-SHA-256 + AES-GCM key wrap). Nothing is shared in advance. Only the receiver's private key, which never leaves his device, can unwrap it. The sender cannot reopen the packet (it stays in History).
   Packet: `🔐E2E4:` + base64(version, one-time public key 65 B, count, [key tag 8 B, IV 12 B, wrapped key 48 B] per receiver, IV 12 B, ciphertext+tag), written as emoji. The receiver must have opened secure chat once so a public key exists.
2. **With a key** (anyone). "Make a strong key for me" generates 20 characters (about 99 bits) from an alphabet without look-alikes, new for every message, shown separately so it is sent by another route. "I'll type my own key" needs 8+ characters. This is the existing password mode (`🔐E2E3:`, PBKDF2 + AES-256-GCM).

**Decrypt** detects what was pasted: a message locked to your account opens at once (unlocking with your recovery passphrase if auto-lock is on); a key message shows the key box (Enter to open; lower case or missing dashes are accepted for generated keys); older and in-chat messages are told apart too.

**Emoji picker** (😀 button): beside the Encrypt message box and the chat input; category tabs, search, recently used. Works the same on every device.

Tests: `tests/send_modes_ui.py` (needs a running server, see the header of the file).
