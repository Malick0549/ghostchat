"""
GhostChat :: api/routes_session.py
Flask Blueprint: cryptographic session lifecycle endpoints.

POST /new-session     — create a new session (random internal key)
POST /session-info    — query session metadata (no keys ever returned)
POST /rotate-session  — derive new keys for a live session
POST /end-session     — terminate and erase a session

All key management is delegated to:
    crypto/session_key_manager.py → SessionKeyManager / default_session_manager
"""

from flask import Blueprint, jsonify, g
from .middleware import require_json
from ..crypto.session_key_manager import (
    default_session_manager as _session_mgr,
    KeyNotFoundError,
    KeyExpiredError,
)

bp = Blueprint("session_routes", __name__)


# ── /new-session ───────────────────────────────────────────────────────────────

@bp.route("/new-session", methods=["POST"])
def new_session():
    """
    Create a new cryptographic session.
    No request body required — keys are generated server-side.

    Response JSON 201 (public metadata only — NO keys):
        {
            "session_id":     str,
            "created_at":     str,   — ISO-8601
            "expires_in":     float, — seconds until expiry
            "rotation_count": int
        }
    """
    try:
        sess = _session_mgr.create_session()
    except Exception as exc:
        return jsonify({
            "error":   "Session Creation Failed",
            "message": str(exc),
            "code":    500,
        }), 500

    return jsonify(sess.to_public_dict()), 201


# ── /session-info ──────────────────────────────────────────────────────────────

@bp.route("/session-info", methods=["POST"])
@require_json
def session_info():
    """
    Return public metadata for an active session.  Keys are never included.

    Request JSON:   { "session_id": str }
    Response 200:   session metadata dict
    Response 404:   unknown session_id
    Response 401:   session expired
    """
    session_id = g.json_body["session_id"]

    try:
        sess = _session_mgr.get_session(session_id)   # raises KeyError | ValueError
    except KeyError:
        return jsonify({
            "error":   "Not Found",
            "message": f"Session '{session_id}' does not exist.",
            "code":    404,
        }), 404
    except ValueError as exc:
        return jsonify({
            "error":   "Unauthorized",
            "message": str(exc),
            "code":    401,
        }), 401

    return jsonify(sess.to_public_dict()), 200


# ── /rotate-session ────────────────────────────────────────────────────────────

@bp.route("/rotate-session", methods=["POST"])
@require_json
def rotate_session():
    """
    Rotate the cryptographic keys for a live session (forward secrecy).
    Old keys are discarded immediately.

    Request JSON:   { "session_id": str }
    Response 200:   new session metadata + rotated: true
    """
    session_id = g.json_body["session_id"]

    try:
        new_sess = _session_mgr.rotate_session(session_id)  # raises KeyError | ValueError
    except KeyError:
        return jsonify({
            "error":   "Not Found",
            "message": f"Session '{session_id}' does not exist.",
            "code":    404,
        }), 404
    except ValueError as exc:
        return jsonify({
            "error":   "Unauthorized",
            "message": str(exc),
            "code":    401,
        }), 401

    data = new_sess.to_public_dict()
    data["rotated"] = True
    data["message"] = (
        f"Session keys rotated. "
        f"New session ID: {new_sess.session_id[:16]}…"
    )
    return jsonify(data), 200


# ── /end-session ───────────────────────────────────────────────────────────────

@bp.route("/end-session", methods=["POST"])
@require_json
def end_session():
    """
    Terminate and permanently erase a session.
    Idempotent — deleting a nonexistent session is not an error.

    Request JSON:   { "session_id": str }
    Response 200:   { session_id, terminated: true, message }
    """
    session_id = g.json_body["session_id"]

    _session_mgr.delete_session(session_id)   # no-op if already gone

    return jsonify({
        "session_id": session_id,
        "terminated": True,
        "message":    "Session terminated and keys erased.",
    }), 200