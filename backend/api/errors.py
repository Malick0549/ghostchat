"""
GhostChat :: api/errors.py
Centralised JSON error handlers for all HTTP error codes.

Without these, Flask returns HTML error pages — useless for an API client.
Every error, including unexpected 500s, returns a consistent JSON envelope:

    {
        "error":   "<short label>",
        "message": "<human-readable description>",
        "code":    <http status int>
    }

Register all handlers at once with:
    from api.errors import register_error_handlers
    register_error_handlers(app)
"""

import logging
from flask import Flask, jsonify

log = logging.getLogger("ghostchat.api.errors")


def register_error_handlers(app: Flask) -> None:
    """Attach all JSON error handlers to the Flask app instance."""

    @app.errorhandler(400)
    def bad_request(e):
        return jsonify({
            "error":   "Bad Request",
            "message": str(e),
            "code":    400,
        }), 400

    @app.errorhandler(404)
    def not_found(e):
        return jsonify({
            "error":   "Not Found",
            "message": "The requested endpoint does not exist.",
            "code":    404,
        }), 404

    @app.errorhandler(405)
    def method_not_allowed(e):
        return jsonify({
            "error":   "Method Not Allowed",
            "message": str(e),
            "code":    405,
        }), 405

    @app.errorhandler(415)
    def unsupported_media(e):
        return jsonify({
            "error":   "Unsupported Media Type",
            "message": "Content-Type must be application/json.",
            "code":    415,
        }), 415

    @app.errorhandler(500)
    def internal_error(e):
        # Log the full traceback server-side; never expose it to the client.
        log.exception("Unhandled server error")
        return jsonify({
            "error":   "Internal Server Error",
            "message": "An unexpected error occurred. Check server logs.",
            "code":    500,
        }), 500