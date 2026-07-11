"""
GhostChat :: api/two_factor.py
Email-based two-factor authentication (OTP).

DESIGN RATIONALE (email OTP vs TOTP authenticator apps):
  Email OTP was chosen over TOTP (Google Authenticator-style) because it is
  effective, secure, and dramatically simpler to ship correctly:
    - No new dependency (no pyotp), no QR code generation, no secret-key
      backup/recovery flow, no "I lost my phone" support burden.
    - Reuses the exact email-delivery infrastructure already proven to work
      in flask_app.py's registration verification flow (_send_email, with
      SendGrid/Resend/SMTP fallback chain already implemented and tested).
    - The threat model for GhostChat (credential-stuffing, password reuse,
      not nation-state attackers targeting a specific high-value user) is
      well covered by "attacker needs your password AND access to your
      inbox," which is what email OTP provides.
  TOTP is marginally stronger against an attacker who has *already*
  compromised the user's email, but that is a smaller slice of the real
  threat model here, and the operational complexity is not worth it yet.

SECURITY PROPERTIES:
  - 6-digit code, cryptographically random (secrets.randbelow), not
    predictable from timestamp or user data.
  - 10-minute expiry — short enough to limit the brute-force window.
  - Attempt counter — code is invalidated after 5 wrong guesses, forcing a
    fresh code request rather than allowing unlimited local guessing even
    within the expiry window.
  - Rate-limited at the route level (see rate_limit.py) so remote brute-force
    against the 1,000,000 possible codes is infeasible even before the
    5-attempt local cap kicks in.
  - Codes are stored hashed-comparison is not needed here (unlike passwords)
    since they are short-lived, single-use, and rate-limited — but they are
    still never logged or exposed in any response.
"""

import secrets
import logging
from datetime import datetime, timedelta

log = logging.getLogger("ghostchat.api.two_factor")

OTP_LENGTH = 6
OTP_EXPIRY_MINUTES = 10
OTP_MAX_ATTEMPTS = 5


def generate_otp() -> str:
    """Cryptographically random 6-digit code, zero-padded."""
    return f"{secrets.randbelow(10 ** OTP_LENGTH):0{OTP_LENGTH}d}"


def issue_otp(user, db) -> str:
    """
    Generates a new OTP for the user, stores it (with expiry + reset attempt
    counter), and returns the plaintext code for the caller to email out.
    Does not commit — caller controls the transaction boundary.
    """
    code = generate_otp()
    user.two_factor_code = code
    user.two_factor_code_expires = datetime.utcnow() + timedelta(minutes=OTP_EXPIRY_MINUTES)
    user.two_factor_attempts = 0
    return code


def verify_otp(user, submitted_code: str) -> tuple[bool, str]:
    """
    Validates a submitted OTP against the stored one.
    Returns (success, error_message). On any failure path, the attempt
    counter is incremented; after OTP_MAX_ATTEMPTS the code is invalidated
    entirely and the user must request a new one — this bounds the total
    number of guesses per issued code regardless of expiry window length.

    Caller is responsible for db.session.commit().
    """
    if not user.two_factor_code or not user.two_factor_code_expires:
        return False, "No verification code is pending. Please request a new one."

    if datetime.utcnow() > user.two_factor_code_expires:
        user.two_factor_code = None
        user.two_factor_code_expires = None
        user.two_factor_attempts = 0
        return False, "Verification code has expired. Please request a new one."

    if (user.two_factor_attempts or 0) >= OTP_MAX_ATTEMPTS:
        user.two_factor_code = None
        user.two_factor_code_expires = None
        user.two_factor_attempts = 0
        return False, "Too many incorrect attempts. Please request a new code."

    if not submitted_code or not secrets.compare_digest(str(submitted_code).strip(), user.two_factor_code):
        user.two_factor_attempts = (user.two_factor_attempts or 0) + 1
        return False, "Incorrect verification code."

    # Success — clear the code so it cannot be reused
    user.two_factor_code = None
    user.two_factor_code_expires = None
    user.two_factor_attempts = 0
    return True, ""


def otp_email_body(username: str, code: str) -> tuple[str, str]:
    """Returns (html_body, text_body) for the OTP email."""
    html = f'''
        <p>Hi {username},</p>
        <p>Your GhostChat sign-in verification code is:</p>
        <h2 style="letter-spacing:4px;">{code}</h2>
        <p>This code expires in {OTP_EXPIRY_MINUTES} minutes. If you did not attempt to sign in,
        you can safely ignore this email — your account is still protected by your password.</p>
    '''
    text = (
        f"Your GhostChat sign-in verification code is: {code}\n"
        f"It expires in {OTP_EXPIRY_MINUTES} minutes.\n\n"
        f"If you did not attempt to sign in, you can safely ignore this email."
    )
    return html, text