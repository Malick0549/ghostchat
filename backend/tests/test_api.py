"""
GhostChat :: tests/test_api.py
Integration tests for the Flask API layer.

Joins your existing:
    tests/test_crypto.py
    tests/test_emoji.py
    tests/test_ghostchat_session.py

These tests verify the HTTP surface only — the underlying crypto correctness
is already covered by your existing test files.

Run:
    python -m pytest tests/test_api.py -v
    # or run everything:
    python -m pytest tests/ -v
"""

import json
import sys
import os

# Make sure project root is on the path when running from tests/ directly
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

import pytest
from backend.flask_app import create_app


# ── Fixtures ──────────────────────────────────────────────────────────────────

@pytest.fixture(scope="module")
def client():
    """Create a test Flask client for the whole module."""
    app = create_app({"TESTING": True})
    with app.test_client() as c:
        yield c


def post(client, path: str, body: dict):
    """Helper: POST JSON and return (status_code, json_body)."""
    r = client.post(
        path,
        data=json.dumps(body),
        content_type="application/json",
    )
    return r.status_code, r.get_json()


# ── Health / Root ─────────────────────────────────────────────────────────────

class TestHealthEndpoints:
    def test_health_returns_ok(self, client):
        r = client.get("/health")
        assert r.status_code == 200
        assert r.get_json()["status"] == "ok"

    def test_root_lists_endpoints(self, client):
        r = client.get("/")
        assert r.status_code == 200
        data = r.get_json()
        assert "endpoints" in data

    def test_unknown_route_returns_404_json(self, client):
        r = client.get("/nonexistent")
        assert r.status_code == 404
        assert r.get_json()["error"] == "Not Found"


# ── Security Headers ──────────────────────────────────────────────────────────

class TestSecurityHeaders:
    def test_headers_present_on_health(self, client):
        r = client.get("/health")
        assert r.headers.get("X-Content-Type-Options") == "nosniff"
        assert r.headers.get("X-Frame-Options")        == "DENY"
        assert r.headers.get("Cache-Control")          == "no-store"

    def test_server_header_removed(self, client):
        r = client.get("/health")
        assert "Server" not in r.headers or r.headers.get("Server") == ""


# ── Middleware ────────────────────────────────────────────────────────────────

class TestMiddleware:
    def test_non_json_content_type_returns_415(self, client):
        r = client.post("/encrypt", data="text", content_type="text/plain")
        assert r.status_code == 415
        assert r.get_json()["code"] == 415

    def test_invalid_json_body_returns_400(self, client):
        r = client.post(
            "/encrypt",
            data="not json {{{{",
            content_type="application/json",
        )
        assert r.status_code == 400

    def test_missing_required_field_returns_400(self, client):
        # /encrypt requires session_id AND plaintext
        s, d = post(client, "/encrypt", {"session_id": "only-sid"})
        assert s == 400
        assert "plaintext" in str(d["message"])

    def test_unknown_session_returns_404(self, client):
        s, d = post(client, "/session-info", {"session_id": "ghost-id"})
        assert s == 404
        assert d["error"] == "Not Found"


# ── Session Lifecycle ─────────────────────────────────────────────────────────

class TestSessionEndpoints:
    def test_create_session_returns_201(self, client):
        r = client.post("/new-session")
        assert r.status_code == 201
        data = r.get_json()
        assert "session_id" in data

    def test_session_id_is_unique(self, client):
        sid1 = client.post("/new-session").get_json()["session_id"]
        sid2 = client.post("/new-session").get_json()["session_id"]
        assert sid1 != sid2

    def test_session_info_returns_metadata(self, client):
        sid = client.post("/new-session").get_json()["session_id"]
        s, d = post(client, "/session-info", {"session_id": sid})
        assert s == 200
        assert d["session_id"] == sid

    def test_session_info_does_not_return_keys(self, client):
        sid  = client.post("/new-session").get_json()["session_id"]
        _, d = post(client, "/session-info", {"session_id": sid})
        assert "aes_key"  not in d
        assert "hmac_key" not in d
        assert "key"      not in d

    def test_rotate_session_increments_count(self, client):
        sid = client.post("/new-session").get_json()["session_id"]
        s, d = post(client, "/rotate-session", {"session_id": sid})
        assert s == 200
        assert d["rotated"] is True

    def test_end_session_terminates(self, client):
        sid = client.post("/new-session").get_json()["session_id"]
        s, d = post(client, "/end-session", {"session_id": sid})
        assert s == 200
        assert d["terminated"] is True

    def test_session_unusable_after_end(self, client):
        sid = client.post("/new-session").get_json()["session_id"]
        post(client, "/end-session", {"session_id": sid})
        s, _ = post(client, "/session-info", {"session_id": sid})
        assert s == 404

    def test_rotate_nonexistent_session_returns_404(self, client):
        s, d = post(client, "/rotate-session", {"session_id": "no-such-id"})
        assert s == 404


# ── Encrypt / Decrypt ─────────────────────────────────────────────────────────

class TestEncryptDecrypt:
    """
    These tests verify the HTTP contract of /encrypt and /decrypt.
    The correctness of AES-256-GCM itself is tested in test_crypto.py.
    """

    def _sid(self, client) -> str:
        return client.post("/new-session").get_json()["session_id"]

    def test_basic_encrypt_returns_200(self, client):
        sid = self._sid(client)
        s, d = post(client, "/encrypt", {
            "session_id": sid,
            "plaintext":  "Hello GhostChat",
        })
        assert s == 200
        assert "iv" in d
        assert "ciphertext" in d
        assert "AES-256-GCM" in d["layers"]

    def test_basic_decrypt_recovers_plaintext(self, client):
        sid = self._sid(client)
        _, enc = post(client, "/encrypt", {
            "session_id": sid,
            "plaintext":  "Hello GhostChat",
        })
        _, dec = post(client, "/decrypt", {
            "session_id": sid,
            "iv":         enc["iv"],
            "ciphertext": enc["ciphertext"],
        })
        assert dec["plaintext"] == "Hello GhostChat"

    def test_encrypt_with_emoji_layer(self, client):
        sid = self._sid(client)
        _, enc = post(client, "/encrypt", {
            "session_id": sid,
            "plaintext":  "emoji test",
            "use_emoji":  True,
        })
        assert "emoji-obfuscation" in enc["layers"]

        _, dec = post(client, "/decrypt", {
            "session_id": sid,
            "iv":         enc["iv"],
            "ciphertext": enc["ciphertext"],
            "use_emoji":  True,
        })
        assert dec["plaintext"] == "emoji test"

    def test_encrypt_with_ai_layer(self, client):
        sid = self._sid(client)
        _, enc = post(client, "/encrypt", {
            "session_id": sid,
            "plaintext":  "stealth test",
            "use_ai":     True,
        })
        assert "ai-camouflage" in enc["layers"]

        _, dec = post(client, "/decrypt", {
            "session_id": sid,
            "iv":         enc["iv"],
            "ciphertext": enc["ciphertext"],
            "use_ai":     True,
        })
        assert dec["plaintext"] == "stealth test"

    def test_all_layers_roundtrip(self, client):
        sid = self._sid(client)
        _, enc = post(client, "/encrypt", {
            "session_id": sid,
            "plaintext":  "full pipeline test",
            "use_emoji":  True,
            "use_ai":     True,
        })
        assert len(enc["layers"]) == 3

        _, dec = post(client, "/decrypt", {
            "session_id": sid,
            "iv":         enc["iv"],
            "ciphertext": enc["ciphertext"],
            "use_emoji":  True,
            "use_ai":     True,
        })
        assert dec["plaintext"] == "full pipeline test"

    def test_tampered_ciphertext_returns_403(self, client):
        sid = self._sid(client)
        _, enc = post(client, "/encrypt", {
            "session_id": sid,
            "plaintext":  "tamper me",
        })
        bad_ct = enc["ciphertext"][:-4] + "XXXX"
        s, d = post(client, "/decrypt", {
            "session_id": sid,
            "iv":         enc["iv"],
            "ciphertext": bad_ct,
        })
        assert s == 403
        assert d["error"] == "Authentication Failed"

    def test_wrong_session_key_returns_403(self, client):
        sid1 = self._sid(client)
        sid2 = self._sid(client)
        _, enc = post(client, "/encrypt", {
            "session_id": sid1,
            "plaintext":  "cross-session attack",
        })
        s, _ = post(client, "/decrypt", {
            "session_id": sid2,   # wrong session
            "iv":         enc["iv"],
            "ciphertext": enc["ciphertext"],
        })
        assert s == 403

    def test_missing_iv_returns_400(self, client):
        sid = self._sid(client)
        s, _ = post(client, "/decrypt", {
            "session_id": sid,
            "ciphertext": "abc",
            # iv missing
        })
        assert s == 400

    def test_method_not_allowed_returns_405(self, client):
        r = client.get("/encrypt")
        assert r.status_code == 405