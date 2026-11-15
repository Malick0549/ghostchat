# GhostChat

Private messaging in the browser. Messages, documents, photos, voice notes and video are encrypted **on your device**
before they are sent, so the server stores only scrambled data it cannot read. One-to-one chats and groups.

| | |
|---|---|
| Backend | Python 3.11, Flask, Flask-SocketIO (eventlet), SQLAlchemy |
| Database | PostgreSQL in production (Neon), SQLite for local development |
| Frontend | Plain HTML, CSS and JavaScript, no build step (`frontend/`) |
| Encryption | ECDH P-256 + HKDF + AES-256-GCM, in the browser (Web Crypto) |
| Hosting | Render (single worker), see `Dockerfile` |

## Run it locally

```bash
python -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
export FLASK_SECRET="$(python -c 'import secrets;print(secrets.token_hex(32))')"
python -c "import flask_app as f; f.socketio.run(f.app, port=5000, allow_unsafe_werkzeug=True)"   # http://127.0.0.1:5000
```
Without `DATABASE_URL` it uses a local SQLite file. Without an email provider configured, sign-up emails cannot be
sent; for local development set `GC_LOG_SECRETS=1` to print codes in the console (never in production).

## Run the tests

```bash
pip install requests "python-socketio[client]" pillow
python tests/run_all.py
```
Each suite gets a fresh temporary database and a real local server. Exit code 0 means every check passed
(139 checks: security, moderation, groups, password reset, data retention).

## Documentation

- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) how the pieces fit together
- [docs/SECURITY.md](docs/SECURITY.md) the encryption design, threat model and honest limits
- [docs/OPERATIONS.md](docs/OPERATIONS.md) configuration, deployment, admin, backups, incident response
- [docs/API.md](docs/API.md) every HTTP route

## Legal pages

`frontend/terms.html`, `privacy.html`, `security.html`, `status.html`. These are templates. Have a lawyer review them
before launch, and check whether you must register with your country's data protection authority
(for Ghana: the Data Protection Commission under the Data Protection Act, 2012). Your contact email is set in
`frontend/js/legal-config.js`.
