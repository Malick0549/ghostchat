"""
GhostChat :: api/rate_limit.py
Centralised rate limiting — brute-force and abuse protection.

WHY THIS EXISTS:
  Before this module, NOTHING in GhostChat rate-limited requests. That meant:
    - /api/auth/login had no attempt cap — a script could try millions of
      password guesses per hour against any account.
    - /api/auth/verify-email's 6-digit code (1,000,000 possibilities) could
      be brute-forced in minutes with no cap on attempts.
    - /api/decrypt could be hammered to brute-force encryption passwords
      offline-speed-adjacent, since the server would happily try forever.
    - /api/auth/forgot-password could be used to spam arbitrary inboxes.

  flask-limiter is used here rather than a hand-rolled counter because it
  correctly handles concurrent workers (via a shared storage backend),
  sliding windows, and per-route override syntax — a hand-rolled in-memory
  counter would not survive gunicorn's multi-worker model on Railway (each
  worker would keep its own counter, silently multiplying the effective
  limit by worker count).

STORAGE BACKEND:
  Defaults to in-memory, which is fine for a single-instance deployment but
  resets on every restart/redeploy and does not share state across gunicorn
  workers. If REDIS_URL is set (recommended for production), it is used
  instead so limits are enforced correctly across all workers and survive
  restarts. This is a real correctness issue, not just a nice-to-have: with
  multiple workers and in-memory storage, an attacker gets effectively
  (limit × worker_count) attempts instead of (limit).
"""

import os
import logging
from flask_limiter import Limiter
from flask_limiter.util import get_remote_address

log = logging.getLogger("ghostchat.api.rate_limit")


def _storage_uri() -> str:
    redis_url = os.environ.get("REDIS_URL") or os.environ.get("RATE_LIMIT_STORAGE_URL")
    if redis_url:
        log.info("Rate limiter using Redis storage backend")
        return redis_url
    log.warning(
        "Rate limiter using in-memory storage — limits will NOT be shared "
        "across gunicorn workers or survive restarts. Set REDIS_URL for "
        "correct multi-worker enforcement in production."
    )
    return "memory://"


def _key_func() -> str:
    """
    Rate-limit key: client IP, honoring X-Forwarded-For behind Railway's proxy.
    Falls back to flask-limiter's default remote-address logic.
    """
    from flask import request
    fwd = request.headers.get("X-Forwarded-For")
    if fwd:
        return fwd.split(",")[0].strip()
    return get_remote_address()


limiter = Limiter(
    key_func=_key_func,
    storage_uri=_storage_uri(),
    strategy="fixed-window",
    default_limits=["200 per hour"],   # generous global backstop
    headers_enabled=True,              # sends X-RateLimit-* headers to client
    swallow_errors=True,               # storage hiccup must never break the app
)


# ── Named limit strings — reused per-route so all tuning lives in one place ──
LOGIN_LIMIT             = "8 per minute; 30 per hour"
REGISTER_LIMIT          = "5 per hour"
VERIFY_EMAIL_LIMIT      = "6 per 15 minutes"
RESEND_VERIFY_LIMIT     = "3 per 5 minutes"
FORGOT_PASSWORD_LIMIT   = "3 per 15 minutes"
RESET_PASSWORD_LIMIT    = "8 per hour"
DECRYPT_LIMIT           = "20 per minute"
ENCRYPT_LIMIT           = "30 per minute"
TWO_FA_VERIFY_LIMIT     = "8 per 10 minutes"
ADMIN_MUTATION_LIMIT    = "20 per minute"