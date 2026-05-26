"""
GhostChat :: api/middleware.py
Request validation and response hardening.

Two things live here:
  1. @require_json  — decorator that validates Content-Type and required fields
                      before the route handler runs.
  2. add_security_headers — after_request hook registered in flask_app.py.

Both are framework concerns only; no crypto logic belongs here.
"""

import functools
from flask import request, jsonify, g


# ── Required JSON fields per route path ──────────────────────────────────────
# Add an entry here whenever a new endpoint is created.
_REQUIRED_FIELDS: dict[str, list[str]] = {
    "/encrypt":        ["session_id", "plaintext"],
    "/decrypt":        ["session_id", "iv", "ciphertext"],
    "/session-info":   ["session_id"],
    "/rotate-session": ["session_id"],
    "/end-session":    ["session_id"],
}


def require_json(f):
    """
    Route decorator — enforces:
      • Content-Type: application/json
      • Body is valid JSON
      • All required fields for this endpoint are present

    Parsed body is stored on Flask's request-context object `g.json_body`
    so route handlers can read it without calling request.get_json() again.

    Usage:
        @bp.route("/encrypt", methods=["POST"])
        @require_json
        def encrypt():
            body = g.json_body
            ...
    """
    @functools.wraps(f)
    def wrapper(*args, **kwargs):
        # ── Content-Type check ───────────────────────────────────────────────
        if not request.is_json:
            return jsonify({
                "error":   "Unsupported Media Type",
                "message": "Content-Type must be application/json.",
                "code":    415,
            }), 415

        # ── JSON parse ───────────────────────────────────────────────────────
        data = request.get_json(silent=True)
        if data is None:
            return jsonify({
                "error":   "Bad Request",
                "message": "Request body is not valid JSON.",
                "code":    400,
            }), 400

        # ── Required field check ─────────────────────────────────────────────
        required = _REQUIRED_FIELDS.get(request.path, [])
        missing  = [field for field in required if field not in data]
        if missing:
            return jsonify({
                "error":   "Missing Fields",
                "message": f"Required field(s) not provided: {missing}",
                "code":    400,
            }), 400

        # ── Store parsed body on g for the handler ───────────────────────────
        g.json_body = data
        return f(*args, **kwargs)

    return wrapper


def add_security_headers(response):
    """
    Flask after_request hook.
    Attaches security-hardening HTTP headers to every response.

    Register with:
        app.after_request(add_security_headers)

    Headers applied:
        X-Content-Type-Options      — prevent MIME sniffing
        X-Frame-Options             — deny iframe embedding (clickjacking)
        X-XSS-Protection            — legacy XSS filter (belt + suspenders)
        Referrer-Policy             — no referrer leakage
        Cache-Control               — never cache API responses
        Content-Security-Policy     — minimal CSP (API-only, no assets)
        Strict-Transport-Security   — enforce HTTPS for 2 years
        X-GhostChat-API             — version tag, no implementation detail
    """
    response.headers["X-Content-Type-Options"]    = "nosniff"
    response.headers["X-Frame-Options"]           = "DENY"
    response.headers["X-XSS-Protection"]          = "1; mode=block"
    response.headers["Referrer-Policy"]           = "no-referrer"
    response.headers["Cache-Control"]             = "no-store"
    response.headers["Content-Security-Policy"]   = (
        "default-src 'self'; "
        "script-src 'self' 'unsafe-inline'; "
        "style-src 'self' 'unsafe-inline'; "
        "font-src 'self' https://fonts.googleapis.com https://fonts.gstatic.com; "
        "connect-src 'self'"
    )
    response.headers["Strict-Transport-Security"] = (
        "max-age=63072000; includeSubDomains; preload"
    )
    response.headers["X-GhostChat-API"] = "v1"
    response.headers.pop("Server", None)   # remove Flask/Werkzeug banner
    return response