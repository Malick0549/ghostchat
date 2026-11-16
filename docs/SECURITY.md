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

## Safety numbers
Each chat shows a safety number made from both people's public keys. Comparing it in person or on a call proves nobody
is intercepting. After you compare, "mark verified" stores that number on your device. If it ever changes, the mark turns
into a red warning and a prominent alert appears in the chat.

## Admin accounts
Admins must enter an emailed code at every sign-in and cannot turn this off in Settings. Break-glass: set
`ADMIN_2FA_REQUIRED=0` in the environment only if email delivery is broken and an admin is locked out, then set it back.

## Installable app (PWA)
GhostChat can be installed on phones and desktops. The service worker (`sw.js`) caches only the offline page and
icons, plus public static files as a fallback. It never caches `/api`, sockets, uploads, media or private responses,
and it always fetches from the network first so updates apply immediately.

## Network and cookie protections
- Login and CSRF cookies are `SameSite=Lax`, `HttpOnly` (session) and `Secure` in production, so other websites cannot make signed-in requests for you.
- Cross-origin access (CORS) is limited to this app's own address. Sandboxed pages (`null`) and old hostnames are refused.
- Uploaded files are served only to signed-in users, in a sandbox that blocks scripts.
- Broken JSON gets a 400 answer, never a server error. Dependencies are checked with `pip-audit` (clean at release).

## Known limits
- The content security policy still allows inline scripts, because pages use inline handlers. All user text is escaped before display, but moving to a strict script policy is the next hardening step.
- There is no forward secrecy yet (see above).

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
- There is **no forward secrecy** yet: someone who gets a private key can read past messages encrypted to it. Adding it means a ratchet protocol (Signal-style X3DH and Double Ratchet) with a prekey service. That is a separate project that needs expert review, so it is on the roadmap, not in this release. Auto-lock, key moves and one-device keys reduce the exposure meanwhile.
- **Safety-number checking is optional.** The app records a verification and warns on change, but it cannot force people to compare numbers.
- **Shared-password messages** (the password tool) are encrypted in the browser with AES-256-GCM and PBKDF2 (600,000 rounds). Their strength is the password's strength: a weak shared password can be guessed offline. The old server-side encryption (AES-256-CBC) was retired: `/api/encrypt` returns 410. `/api/decrypt` remains only so that messages made in the old format can still be opened; doing so sends the password to the server, and the app says so.
- Files cannot be virus-scanned by the server because it cannot read them. Dangerous file types are blocked.
- Group rekeying waits until an admin is online.

## Reporting a vulnerability
Email the address in `frontend/js/legal-config.js`. Please give us reasonable time to fix before disclosure.
