# Operations

## Configuration (environment variables)
| Variable | Meaning |
|---|---|
| `FLASK_SECRET` | **Required.** Long random string for signing sessions |
| `DATABASE_URL` | PostgreSQL URL (Neon). Unset = local SQLite (not for production) |
| `ADMIN_EMAILS` | Comma-separated emails that are admins |
| `TRUSTED_PROXY_HOPS` | Number of proxies in front of the app (Render: usually 1). Wrong value = wrong IPs in logs and rate limits. Check the admin Security tab |
| `SENDGRID_API_KEY` / `RESEND_API_KEY` / `SMTP_*` | Email provider. `MAIL_FROM` must be a verified sender |
| `RESET_URL_BASE` | Public base URL used in reset and verification links |
| `REDIS_URL` / `RATE_LIMIT_STORAGE_URL` | Rate-limit storage (default in memory, resets on restart) |
| `LOG_RETENTION_DAYS` | Activity-log retention (default 180) |
| `EXTRA_ALLOWED_ORIGINS` | Comma-separated `https://` origins allowed to call the API (your own custom domain). Leave empty if the site is served from one address. |
| `COOKIE_SAMESITE` | Default `Lax`. Set `None` only if you ever host the frontend on a different site from the API. |
| `ADMIN_2FA_REQUIRED` | Default on: admins need an emailed code. `0` = break-glass only |
| `GC_LOG_SECRETS` | `1` prints codes and links in logs. **Development only** |
| `BRUTE_FORCE_THRESHOLD`, `AUDIT_ALERTS` | Failed-login alert settings |

## Deploy (Render)
Docker deploy from `Dockerfile`, one worker (eventlet). New tables are created automatically on start.
Free plan: the service sleeps when idle, so the first request after a pause is slow; `/health` is used by the status notice.
Set every variable above in the Render dashboard, never in the repository.

## Admin console
`/admin`: overview, users (suspend, unsuspend, verify, delete, email), reports, security and diagnostics,
audit log with filters, CSV export and purge. Every sensitive action is logged with IP, location and device.

## Backups and recovery
Back up the Neon database (point-in-time restore on paid plans, or scheduled `pg_dump`). Backups hold only ciphertext
for end-to-end chats. A restored database does not restore anyone's private keys: users recover them with their
recovery passphrase.

## Incident response (short form)
1. Contain: rotate `FLASK_SECRET` (signs everyone out), suspend affected accounts, rotate email and database credentials.
2. Investigate with the audit log (IP, device, location) and the diagnostics page.
3. Tell affected users and, where the law requires, the data protection authority, within the legal deadline.
4. Fix, then record what happened and what changed.
Credentials that were ever pasted in chat, email or a commit must be treated as leaked and replaced.

## Routine checks
Run `python tests/run_all.py` before every deploy. Keep dependencies updated (`pip list --outdated`). Review the
audit log's failed-login and admin-denied events weekly.
