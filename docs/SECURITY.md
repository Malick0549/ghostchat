# Security model

## What is protected
For end-to-end chats, the server (and anyone who breaks into it, or into the database) sees only ciphertext.

## Cryptography
- **Pair key:** each user has an ECDH P-256 key pair made in the browser. The private key is stored as a
  non-extractable key in the browser's IndexedDB. Two users derive a shared secret with ECDH, then HKDF
  gives an AES-256-GCM key. Associated data binds the message to the two users.
- **Packets:** ciphertext is shown as emoji (one emoji per byte from a fixed 256-emoji alphabet). The prefix says how
  it was made: `E2E1` automatic, `E2E2` manual key, `E2E3` password tool, `GRP1` group.
- **Files, photos, voice notes, video:** a fresh random AES-256-GCM key per file. The file is encrypted in the
  browser; the name, type, size and key go in a small note that is encrypted with the chat key.
  Receivers only display allowlisted image/audio/video types; everything else is saved as an opaque download.
- **Groups:** an admin's browser makes a random group key per version and wraps it for each member with the
  pairwise key. Adding, removing or leaving triggers a new version. New members only receive history from when they joined.
- **Recovery vault:** the private key is encrypted with a passphrase (PBKDF2-SHA256, 600,000 rounds, AES-GCM) and stored
  on the server. Without the passphrase it is useless; without it the server cannot restore your keys.
- **Manual keys:** optional per-contact keys, backed up in an encrypted vault with the same passphrase.

## Keys on one device at a time
The server records only a random device id. Signing in on a new device with the recovery passphrase, or using
Settings > Move my keys, makes that device the holder; the old device is told over Socket.IO (or at its next
start) and erases its keys. Moving first backs up and verifies a vault, then erases the old device.

## Auto-lock
After 15 minutes without use (configurable, off by choice), keys leave memory and the recovery passphrase is needed again.
Reloading or opening another tab does not skip the lock. Accounts without a recovery passphrase are never locked.

## Account and server protections
Password hashing (bcrypt), email verification, optional 2FA by email, CSRF double-submit tokens on every write,
rate limits, session idle and absolute timeouts, session revocation on password reset, reset tokens stored only as
SHA-256 hashes (15-minute expiry, one use), security headers and a strict Content-Security-Policy, upload validation,
suspension and reporting tools, and an audit log with IP, location and device.
Verification codes, 2FA codes and reset links are never written to logs in production.

## Honest limits
- A compromised **device or browser** (malware, a malicious extension, someone who has your unlocked computer) can read what you can read.
- A **new device or cleared browser** cannot read old messages without the recovery passphrase. A lost passphrase is not recoverable.
- The server can see **metadata**: who talks to whom, when, message sizes, IP addresses.
- **Voice typing** uses your browser's speech service (Google/Microsoft in Chrome/Edge); spoken words are not protected until typed.
- There is **no forward secrecy** yet: someone who gets a private key can read past messages encrypted to it.
- **Safety numbers** are shown in the chat encryption screen so two people can compare them in person or on a call, but checking is optional and not enforced.
- **Shared-password messages** (the password tool) are encrypted in the browser with AES-256-GCM and PBKDF2 (600,000 rounds). Their strength is the password's strength: a weak shared password can be guessed offline. The old server-side encryption (AES-256-CBC) was retired: `/api/encrypt` returns 410. `/api/decrypt` remains only so that messages made in the old format can still be opened; doing so sends the password to the server, and the app says so.
- Files cannot be virus-scanned by the server because it cannot read them. Dangerous file types are blocked.
- Group rekeying waits until an admin is online.

## Reporting a vulnerability
Email the address in `frontend/js/legal-config.js`. Please give us reasonable time to fix before disclosure.
