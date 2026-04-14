"""
jwt_service.py
JWT token creation and validation using PyJWT.
"""

import os
from datetime import datetime, timedelta, timezone

import jwt

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------

SECRET_KEY: str = os.getenv("JWT_SECRET", "change_me_super_secret_key_123")
ALGORITHM: str = "HS256"
ACCESS_TOKEN_EXPIRE_DAYS: int = 30


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------


def create_access_token(
    user_id: int,
    username: str,
    tag: str,
    is_admin: bool,
) -> str:
    """
    Create a signed JWT access token.

    Args:
        user_id:   The user's numeric primary key.
        username:  The user's display name.
        tag:       The user's unique @handle (falls back to username if empty).
        is_admin:  Whether the user holds admin privileges.

    Returns:
        A compact, URL-safe JWT string.
    """
    payload: dict = {
        "sub": str(user_id),
        "username": username,
        "tag": tag or username,
        "is_admin": is_admin,
        "exp": datetime.now(timezone.utc) + timedelta(days=ACCESS_TOKEN_EXPIRE_DAYS),
    }
    return jwt.encode(payload, SECRET_KEY, algorithm=ALGORITHM)


def decode_token(token: str) -> dict:
    """
    Decode and validate a JWT token.

    Args:
        token: The raw JWT string to validate.

    Returns:
        The decoded payload as a plain dict.

    Raises:
        jwt.PyJWTError: If the token is malformed, expired, or the signature
                        does not match.
    """
    return jwt.decode(token, SECRET_KEY, algorithms=[ALGORITHM])
