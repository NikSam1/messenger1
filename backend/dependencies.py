"""
dependencies.py
Reusable FastAPI dependency functions for authentication and authorization.
"""

import aiosqlite
import jwt
from database import DB_PATH
from fastapi import Depends, HTTPException, Request, status
from services.jwt_service import decode_token

# ---------------------------------------------------------------------------
# Primary auth dependency
# ---------------------------------------------------------------------------


async def get_current_user(request: Request) -> dict:
    """
    Extract and validate the JWT from the ``Authorization: Bearer <token>``
    header.  Returns the full user record from the DB as a plain dict.

    Raises:
        401 – token missing, malformed, expired, or user not found / unverified.
        403 – user account is banned.
    """
    auth_header = request.headers.get("Authorization", "")
    if not auth_header.startswith("Bearer "):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Требуется авторизация",
        )

    token = auth_header.split(" ", 1)[1]

    try:
        payload = decode_token(token)
        user_id = int(payload["sub"])
    except (jwt.PyJWTError, KeyError, ValueError):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Недействительный токен",
        )

    async with aiosqlite.connect(DB_PATH) as db:
        db.row_factory = aiosqlite.Row
        async with db.execute(
            "SELECT * FROM users WHERE id = ? AND is_verified = 1",
            (user_id,),
        ) as cur:
            user = await cur.fetchone()

    if not user:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Пользователь не найден",
        )

    if user["is_banned"]:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Аккаунт заблокирован",
        )

    return dict(user)


# ---------------------------------------------------------------------------
# Admin guard dependency
# ---------------------------------------------------------------------------


async def get_admin_user(
    current_user: dict = Depends(get_current_user),
) -> dict:
    """
    Wraps ``get_current_user`` and additionally enforces admin privileges.

    Raises:
        403 – authenticated user does not have ``is_admin`` set.
    """
    if not current_user.get("is_admin"):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Доступ только для администраторов",
        )
    return current_user
