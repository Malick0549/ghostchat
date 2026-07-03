"""
GhostChat :: backend/api/middleware.py
Request validation and response hardening.
"""

import functools
from flask import request, jsonify, g


# ── Required JSON fields per route path ──────────────────────────────────────
_REQUIRED_FIELDS: dict[str, list[str]] = {
    "/encrypt":        ["session_id", "plaintext"],
    "/decrypt":        ["session_id", "iv", "ciphertext"],
    "/session-info":   ["session_id"],
    "/rotate-session": ["session_id"],
    "/end-session":    ["session_id"],
}


def require_json(f):
    """
    Route decorator — enforces Content-Type, valid JSON, and required fields.
    Parsed body is stored on g.json_body.
    """
    @functools.wraps(f)
    def wrapper(*args, **kwargs):
        if not request.is_json:
            return jsonify({
                "error":   "Unsupported Media Type",
                "message": "Content-Type must be application/json.",
                "code":    415,
            }), 415

        data = request.get_json(silent=True)
        if data is None:
            return jsonify({
                "error":   "Bad Request",
                "message": "Request body is not valid JSON.",
                "code":    400,
            }), 400

        required = _REQUIRED_FIELDS.get(request.path, [])
        missing  = [field for field in required if field not in data]
        if missing:
            return jsonify({
                "error":   "Missing Fields",
                "message": f"Required field(s) not provided: {missing}",
                "code":    400,
            }), 400

        g.json_body = data
        return f(*args, **kwargs)

    return wrapper


def add_security_headers(response):
    """
    Flask after_request hook.
    Attaches security-hardening HTTP headers to every response.

    CSP is permissive enough to allow:
      - Font Awesome, Google Fonts, Socket.IO from CDN
      - WebSocket connections (wss:) for real-time chat
      - Inline styles/scripts used by the frontend
    Without these, mobile browsers (Chrome/Safari) show "Dangerous site" warnings.
    """
    response.headers["X-Content-Type-Options"] = "nosniff"
    response.headers["X-Frame-Options"]        = "SAMEORIGIN"
    response.headers["X-XSS-Protection"]       = "1; mode=block"
    response.headers["Referrer-Policy"]        = "strict-origin-when-cross-origin"
    response.headers["Cache-Control"]          = "no-store"

    # ── Content Security Policy ───────────────────────────────────────────────
    # Must allow all CDNs used in HTML files and WebSocket for SocketIO
    response.headers["Content-Security-Policy"] = (
        "default-src 'self'; "

        # Scripts: self + CDNs used in HTML files
        "script-src 'self' 'unsafe-inline' 'unsafe-eval' "
            "https://cdnjs.cloudflare.com "
            "https://cdn.socket.io "
            "https://cdn.jsdelivr.net; "

        # Styles: self + Font Awesome + Google Fonts + jsDelivr
        "style-src 'self' 'unsafe-inline' "
            "https://cdnjs.cloudflare.com "
            "https://cdn.jsdelivr.net "
            "https://fonts.googleapis.com; "

        # Fonts: Google Fonts + Font Awesome
        "font-src 'self' "
            "https://fonts.googleapis.com "
            "https://fonts.gstatic.com "
            "https://cdnjs.cloudflare.com; "

        # Images: self + data URIs (avatars) + any HTTPS
        "img-src 'self' data: blob: https:; "

        # Connections: self + WebSockets for SocketIO (wss: and ws:)
        "connect-src 'self' wss: ws: https:; "

        # No workers, iframes, objects
        "worker-src 'none'; "
        "frame-src 'none'; "
        "object-src 'none'"
    )

    # HSTS — only set on HTTPS responses to avoid breaking HTTP local dev
    if request.is_secure or request.headers.get("X-Forwarded-Proto") == "https":
        response.headers["Strict-Transport-Security"] = (
            "max-age=63072000; includeSubDomains; preload"
        )

    response.headers["X-GhostChat-API"] = "v3"
    response.headers.pop("Server", None)
    return response