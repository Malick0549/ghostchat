"""
GhostChat :: api/routes_crypto.py
Flask Blueprint: session-key-based encryption and decryption endpoints.

POST /encrypt  — encrypt a plaintext message with an active session key
POST /decrypt  — decrypt a ciphertext produced by /encrypt

All cryptographic work is delegated to the existing modules:
    crypto/aes_engine.py              → AES256Engine
    crypto/session_key_manager.py     → default_session_manager
    obfuscation/emoji_mapper.py       → EmojiMapper
    ai/camouflage_generator.py        → CamouflageLayer (optional)
"""

from flask import Blueprint, jsonify, g
from cryptography.exceptions import InvalidTag

from ..crypto.session_key_manager      import default_session_manager as _session_mgr
from ..crypto.aes_engine               import AES256Engine as AESEngine
from ..obfuscation.emoji_mapper        import EmojiMapper
from .middleware                       import require_json

# ── AI camouflage (optional — import gracefully) ──────────────────────────────
try:
    from ..ai.camouflage_generator import CamouflageLayer as _CamouflageLayer
    _AI_AVAILABLE = True
except ImportError:
    _AI_AVAILABLE = False
    _CamouflageLayer = None

bp = Blueprint("crypto_routes", __name__)

# Singletons
_emoji = EmojiMapper()


# ── /encrypt ──────────────────────────────────────────────────────────────────

@bp.route("/encrypt", methods=["POST"])
@require_json
def encrypt():
    """
    Encrypt a plaintext message using an active session key.

    Request JSON:
        session_id  (str)  : Active session identifier.
        plaintext   (str)  : Message to encrypt.
        use_emoji   (bool) : Apply emoji obfuscation layer.  [default: true]
        use_ai      (bool) : Apply AI camouflage layer.      [default: false]

    Response JSON 200:
        {
            "session_id": str,
            "iv":         str,        — base64 nonce
            "ciphertext": str,        — base64 ciphertext (possibly obfuscated)
            "layers":     list[str]   — transform pipeline applied
        }
    """
    body       = g.json_body
    session_id = body["session_id"]
    plaintext  = body["plaintext"]
    use_emoji  = bool(body.get("use_emoji", True))
    use_ai     = bool(body.get("use_ai",    False))

    # 1. Resolve session → get AES key
    try:
        sess = _session_mgr.get_session(session_id)
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

    # 2. AES-256 encrypt
    try:
        aes        = AESEngine(sess.aes_key)
        result     = aes.encrypt(plaintext)
        iv         = result["iv"]
        ciphertext = result["ciphertext"]
        layers     = ["AES-256-CBC"]
    except Exception as exc:
        return jsonify({
            "error":   "Encryption Failed",
            "message": str(exc),
            "code":    500,
        }), 500

    # 3. Optional emoji obfuscation
    if use_emoji:
        try:
            ciphertext = _emoji.encode(ciphertext)
            layers.append("emoji-obfuscation")
        except Exception as exc:
            return jsonify({
                "error":   "Emoji Encoding Failed",
                "message": str(exc),
                "code":    500,
            }), 500

    # 4. Optional AI camouflage
    if use_ai and _AI_AVAILABLE and _CamouflageLayer:
        try:
            ciphertext = _CamouflageLayer.hide(ciphertext, strategy="mixed")
            layers.append("ai-camouflage")
        except Exception as exc:
            return jsonify({
                "error":   "AI Camouflage Failed",
                "message": str(exc),
                "code":    500,
            }), 500

    return jsonify({
        "session_id": session_id,
        "iv":         iv,
        "ciphertext": ciphertext,
        "layers":     layers,
    }), 200


# ── /decrypt ──────────────────────────────────────────────────────────────────

@bp.route("/decrypt", methods=["POST"])
@require_json
def decrypt():
    """
    Decrypt a ciphertext produced by /encrypt.

    Request JSON:
        session_id  (str)  : Active session identifier.
        iv          (str)  : base64 nonce from the /encrypt response.
        ciphertext  (str)  : Ciphertext in whatever layer form it was returned.
        use_emoji   (bool) : Undo emoji layer before decrypt.  [default: true]
        use_ai      (bool) : Strip AI camouflage first.        [default: false]

    Flags must mirror what was used at /encrypt time.

    Response JSON 200:
        {
            "session_id": str,
            "plaintext":  str,
            "layers":     list[str]
        }

    Response JSON 403:
        GCM/CBC authentication mismatch — ciphertext was tampered.
    """
    body       = g.json_body
    session_id = body["session_id"]
    iv         = body["iv"]
    ciphertext = body["ciphertext"]
    use_emoji  = bool(body.get("use_emoji", True))
    use_ai     = bool(body.get("use_ai",    False))

    # 1. Resolve session
    try:
        sess = _session_mgr.get_session(session_id)
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

    layers_stripped = []

    # 2. Strip AI camouflage first (reverse of encrypt order)
    if use_ai and _AI_AVAILABLE and _CamouflageLayer:
        try:
            ciphertext = _CamouflageLayer.extract(ciphertext)
            layers_stripped.append("ai-camouflage")
        except Exception as exc:
            return jsonify({
                "error":   "AI Camouflage Strip Failed",
                "message": str(exc),
                "code":    400,
            }), 400

    # 3. Strip emoji obfuscation
    if use_emoji:
        try:
            ciphertext = _emoji.decode(ciphertext)
            layers_stripped.append("emoji-obfuscation")
        except Exception as exc:
            return jsonify({
                "error":   "Emoji Decode Failed",
                "message": str(exc),
                "code":    400,
            }), 400

    # 4. AES-256 decrypt
    try:
        aes       = AESEngine(sess.aes_key)
        plaintext = aes.decrypt(ciphertext, iv)
        layers_stripped.append("AES-256-CBC")
    except (InvalidTag, ValueError):
        return jsonify({
            "error":   "Authentication Failed",
            "message": "Ciphertext is corrupted, tampered, or the wrong session key was used.",
            "code":    403,
        }), 403
    except Exception as exc:
        return jsonify({
            "error":   "Decryption Failed",
            "message": str(exc),
            "code":    400,
        }), 400

    return jsonify({
        "session_id": session_id,
        "plaintext":  plaintext,
        "layers":     layers_stripped,
    }), 200