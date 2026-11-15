# Architecture

```
Browser (HTML/JS, Web Crypto)  ──HTTPS / Socket.IO──►  Flask app (flask_app.py)  ──►  PostgreSQL
   keys live here only                                    auth, CSRF, rate limits,        ciphertext,
   encrypt / decrypt here                                 audit log, moderation          accounts, logs
```

## Backend (`flask_app.py`, `backend/`)
| File | Job |
|---|---|
| `flask_app.py` | App factory, routes for auth, contacts, chat, keys, media, admin console, legal pages, `/health` |
| `backend/models.py` | Database tables (users, contacts, messages, sessions, key vaults, `KeyDevice`, reports, suspensions, activity log) |
| `backend/groups.py` | Group chats: membership, per-version group keys (wrapped per member), messages, files |
| `backend/moderation.py` | Suspend / verify / delete users, reports, account deletion cleanup |
| `backend/audit.py` | Central activity log: a route table turns requests into audit events with IP, location and device |
| `backend/hardening.py` | Abuse guards, session sweeper, automatic data-retention job |
| `backend/api/middleware.py` | Security headers and Content-Security-Policy |
| `backend/api/two_factor.py` | Email 2FA codes |

Real-time messaging uses Flask-SocketIO. Rooms are held in process memory, so **run one worker**
(see the note in `Dockerfile`). Scaling out needs a Redis message queue for Socket.IO first.

## Frontend (`frontend/`)
| File | Job |
|---|---|
| `js/e2e.js` | All key handling: key pairs, ECDH, AES-GCM, recovery vault, manual keys, one-device rule, auto-lock |
| `js/e2e-ui.js` | Encryption screens: settings, key move, restore, lock screen |
| `js/groups.js` | Group chat client: group keys, rekeying, history |
| `js/docs.js` | Encrypted files, photos, voice notes, video (per-file key) |
| `js/chat-socket.js` | The chat page: contacts, messages, sockets, rendering |
| `js/voice.js` | Voice typing (browser speech recognition) |
| `js/network-status.js` | Offline / server-down notice |
| `js/legal.js`, `legal-config.js` | Legal pages and the contact details they show |

## Data the server holds
Accounts (username, email, password hash), contact links, **ciphertext** of messages and files, public keys,
the encrypted recovery vault (opened only with the user's passphrase), which device holds the keys (a random id),
group membership, reports, and the activity log (IP, approximate location, device, action).
It does **not** hold private keys, message plaintext, file contents, file names or file types for end-to-end chats.

## Data retention
`backend/hardening.py` runs daily: activity logs 180 days, expired sessions 30 days, closed reports 1 year.
Messages are kept until the users delete them.
