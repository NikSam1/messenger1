"""
routers/auth.py
FastAPI authentication router.

Endpoints:
  POST /api/auth/register      — create a new unverified account
  POST /api/auth/verify-email  — confirm email with a 6-digit code
  POST /api/auth/resend-code   — request a fresh verification code
  POST /api/auth/login         — authenticate and receive a JWT
"""

import random
import string
from datetime import datetime, timedelta, timezone

import aiosqlite
import bcrypt as _bcrypt
from database import DB_PATH
from fastapi import APIRouter, HTTPException, Request, status
from models import (
    MessageResponse,
    RegisterRequest,
    ResendCodeRequest,
    VerifyEmailRequest,
)
from pydantic import BaseModel, EmailStr, field_validator
from services.email_service import send_verification_email
from services.jwt_service import create_access_token
from slowapi import Limiter
from slowapi.util import get_remote_address

# ---------------------------------------------------------------------------
# Setup
# ---------------------------------------------------------------------------

router = APIRouter()

# Rate limiter (shares the instance from main.py via app.state)
limiter = Limiter(key_func=get_remote_address)

# How long a verification code stays valid (minutes)
CODE_TTL_MINUTES = 10

# Minimum seconds a user must wait before requesting a new code
RESEND_COOLDOWN_SECONDS = 60


# ---------------------------------------------------------------------------
# Inline request schema for login (keeps models.py unchanged)
# ---------------------------------------------------------------------------


class LoginRequest(BaseModel):
    """Payload for POST /api/auth/login"""

    email: EmailStr
    password: str

    @field_validator("email")
    @classmethod
    def normalise_email(cls, v: str) -> str:
        return v.strip().lower()

    @field_validator("password")
    @classmethod
    def password_not_empty(cls, v: str) -> str:
        if not v:
            raise ValueError("Пароль не может быть пустым")
        return v


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _generate_code(length: int = 6) -> str:
    """Return a zero-padded random numeric code of *length* digits."""
    return "".join(random.choices(string.digits, k=length))


def _expires_at() -> str:
    """Return an ISO-8601 UTC string for CODE_TTL_MINUTES from now."""
    return (datetime.now(timezone.utc) + timedelta(minutes=CODE_TTL_MINUTES)).strftime(
        "%Y-%m-%d %H:%M:%S"
    )


def _now_utc() -> str:
    """Return the current UTC time as an ISO-8601 string."""
    return datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M:%S")


def _pydantic_errors_to_str(exc) -> str:
    """Flatten Pydantic v2 validation errors into a single readable message."""
    messages = []
    for err in exc.errors():
        messages.append(err.get("msg", str(err)))
    return "; ".join(messages)


# ---------------------------------------------------------------------------
# POST /register
# ---------------------------------------------------------------------------


@router.post(
    "/register",
    response_model=MessageResponse,
    status_code=status.HTTP_201_CREATED,
    summary="Зарегистрировать нового пользователя",
)
@limiter.limit("10/minute")
async def register(request: Request, body: RegisterRequest):
    """
    Create a new user account.

    - Validates username, email format, and password strength.
    - If the email/username already exists but is **unverified**, the stale
      record is deleted and registration proceeds (lets the user retry).
    - Hashes the password with bcrypt.
    - Generates a 6-digit code, stores it, and emails it to the user.
    - Sets tag = username on insert so the user is immediately searchable.
    """
    username = body.username
    email = body.email
    password = body.password

    async with aiosqlite.connect(DB_PATH) as db:
        db.row_factory = aiosqlite.Row

        # ── Check for existing username ────────────────────────────────────
        async with db.execute(
            "SELECT id, is_verified FROM users WHERE username = ?", (username,)
        ) as cur:
            existing_by_username = await cur.fetchone()

        if existing_by_username:
            if existing_by_username["is_verified"]:
                raise HTTPException(
                    status_code=status.HTTP_409_CONFLICT,
                    detail="Этот никнейм уже занят",
                )
            # Unverified — clean up so the new registration can proceed
            await db.execute(
                "DELETE FROM verification_codes WHERE email = "
                "(SELECT email FROM users WHERE id = ?)",
                (existing_by_username["id"],),
            )
            await db.execute(
                "DELETE FROM users WHERE id = ?", (existing_by_username["id"],)
            )
            await db.commit()

        # ── Check for existing email ───────────────────────────────────────
        async with db.execute(
            "SELECT id, is_verified FROM users WHERE email = ?", (email,)
        ) as cur:
            existing_by_email = await cur.fetchone()

        if existing_by_email:
            if existing_by_email["is_verified"]:
                raise HTTPException(
                    status_code=status.HTTP_409_CONFLICT,
                    detail="Аккаунт с таким адресом почты уже существует",
                )
            # Unverified — allow re-registration
            await db.execute("DELETE FROM verification_codes WHERE email = ?", (email,))
            await db.execute(
                "DELETE FROM users WHERE id = ?", (existing_by_email["id"],)
            )
            await db.commit()

        # ── Create the user ────────────────────────────────────────────────
        password_hash = _bcrypt.hashpw(
            password.encode("utf-8"), _bcrypt.gensalt(rounds=10)
        ).decode("utf-8")

        # tag is set to username on creation so the user is immediately
        # searchable; they can change it later via PUT /api/users/me.
        await db.execute(
            "INSERT INTO users (username, tag, email, password_hash) VALUES (?, ?, ?, ?)",
            (username, username, email, password_hash),
        )
        await db.commit()

        # ── Generate and store verification code ───────────────────────────
        code = _generate_code()
        expires = _expires_at()

        await db.execute(
            "INSERT INTO verification_codes (email, code, expires_at) VALUES (?, ?, ?)",
            (email, code, expires),
        )
        await db.commit()

    # ── Send verification email (outside the DB context) ──────────────────
    try:
        await send_verification_email(email, code)
    except Exception as exc:
        # Log the error but don't expose SMTP details to the client
        print(f"[register] Ошибка отправки письма на {email}: {exc}")
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Не удалось отправить письмо с кодом подтверждения. "
            "Проверьте настройки SMTP.",
        )

    return MessageResponse(message="Код подтверждения отправлен на вашу почту")


# ---------------------------------------------------------------------------
# POST /verify-email
# ---------------------------------------------------------------------------


@router.post(
    "/verify-email",
    response_model=MessageResponse,
    status_code=status.HTTP_200_OK,
    summary="Подтвердить адрес электронной почты",
)
@limiter.limit("10/minute")
async def verify_email(request: Request, body: VerifyEmailRequest):
    """
    Confirm an email address using the 6-digit code that was sent to it.

    - Looks up the latest **non-expired** code for the email.
    - Compares it to the submitted code.
    - On success: marks the user as verified and deletes all stored codes.
    """
    email = str(body.email)
    code = body.code

    async with aiosqlite.connect(DB_PATH) as db:
        db.row_factory = aiosqlite.Row

        # Fetch the latest non-expired code for this email
        async with db.execute(
            """
            SELECT id, code
              FROM verification_codes
             WHERE email = ?
               AND datetime(expires_at) > datetime('now')
             ORDER BY created_at DESC
             LIMIT 1
            """,
            (email,),
        ) as cur:
            record = await cur.fetchone()

        if record is None:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="Код недействителен или истёк срок его действия",
            )

        if record["code"] != code:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="Неверный код",
            )

        # ── Mark the user as verified ──────────────────────────────────────
        await db.execute("UPDATE users SET is_verified = 1 WHERE email = ?", (email,))

        # ── Remove all verification codes for this email ───────────────────
        await db.execute("DELETE FROM verification_codes WHERE email = ?", (email,))

        await db.commit()

    return MessageResponse(message="Почта подтверждена! Теперь вы можете войти.")


# ---------------------------------------------------------------------------
# POST /resend-code
# ---------------------------------------------------------------------------


@router.post(
    "/resend-code",
    response_model=MessageResponse,
    status_code=status.HTTP_200_OK,
    summary="Повторно отправить код подтверждения",
)
@limiter.limit("5/minute")
async def resend_code(request: Request, body: ResendCodeRequest):
    """
    Issue a new 6-digit verification code and email it to the user.

    - Checks the user exists and is not already verified.
    - Enforces a 60-second cooldown to prevent abuse.
    - Deletes any previous codes before inserting the new one.
    """
    email = str(body.email)

    async with aiosqlite.connect(DB_PATH) as db:
        db.row_factory = aiosqlite.Row

        # ── Ensure the user exists and isn't already verified ──────────────
        async with db.execute(
            "SELECT id, is_verified FROM users WHERE email = ?", (email,)
        ) as cur:
            user = await cur.fetchone()

        if user is None:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail="Аккаунт с таким адресом почты не найден",
            )

        if user["is_verified"]:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="Этот адрес почты уже подтверждён",
            )

        # ── Cooldown check ─────────────────────────────────────────────────
        async with db.execute(
            """
            SELECT created_at
              FROM verification_codes
             WHERE email = ?
             ORDER BY created_at DESC
             LIMIT 1
            """,
            (email,),
        ) as cur:
            last_code = await cur.fetchone()

        if last_code is not None:
            # Parse the stored UTC timestamp
            created_at = datetime.strptime(
                last_code["created_at"], "%Y-%m-%d %H:%M:%S"
            ).replace(tzinfo=timezone.utc)
            elapsed = (datetime.now(timezone.utc) - created_at).total_seconds()

            if elapsed < RESEND_COOLDOWN_SECONDS:
                remaining = int(RESEND_COOLDOWN_SECONDS - elapsed)
                raise HTTPException(
                    status_code=status.HTTP_429_TOO_MANY_REQUESTS,
                    detail=f"Подождите ещё {remaining} сек. перед повторным запросом",
                )

        # ── Delete old codes and issue a fresh one ─────────────────────────
        await db.execute("DELETE FROM verification_codes WHERE email = ?", (email,))

        code = _generate_code()
        expires = _expires_at()

        await db.execute(
            "INSERT INTO verification_codes (email, code, expires_at) VALUES (?, ?, ?)",
            (email, code, expires),
        )
        await db.commit()

    # ── Send the new code ──────────────────────────────────────────────────
    try:
        await send_verification_email(email, code)
    except Exception as exc:
        print(f"[resend-code] Ошибка отправки письма на {email}: {exc}")
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Не удалось отправить письмо. Проверьте настройки SMTP.",
        )

    return MessageResponse(message="Новый код отправлен на вашу почту")


# ---------------------------------------------------------------------------
# POST /login
# ---------------------------------------------------------------------------


@router.post(
    "/login",
    status_code=status.HTTP_200_OK,
    summary="Войти в аккаунт и получить JWT",
)
@limiter.limit("20/minute")
async def login(request: Request, body: LoginRequest):
    """
    Authenticate a user with email + password.

    - Looks up the user by email.
    - Ensures the account is verified and not banned.
    - Verifies the password against the stored bcrypt hash.
    - Updates ``last_seen`` to the current UTC time.
    - If the user somehow has no tag, back-fills it with their username.
    - Issues a 30-day JWT and returns it together with basic profile data.
    """
    email = body.email
    password = body.password

    async with aiosqlite.connect(DB_PATH) as db:
        db.row_factory = aiosqlite.Row

        # ── Fetch user by email ────────────────────────────────────────────
        async with db.execute("SELECT * FROM users WHERE email = ?", (email,)) as cur:
            user = await cur.fetchone()

        if user is None:
            # Use a generic message to avoid leaking whether the email exists.
            raise HTTPException(
                status_code=status.HTTP_401_UNAUTHORIZED,
                detail="Неверный email или пароль",
            )

        # ── Verified check ─────────────────────────────────────────────────
        if not user["is_verified"]:
            raise HTTPException(
                status_code=status.HTTP_401_UNAUTHORIZED,
                detail="Сначала подтвердите email",
            )

        # ── Banned check ───────────────────────────────────────────────────
        if user["is_banned"]:
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail="Аккаунт заблокирован",
            )

        # ── Password verification ──────────────────────────────────────────
        password_matches = _bcrypt.checkpw(
            password.encode("utf-8"),
            user["password_hash"].encode("utf-8"),
        )
        if not password_matches:
            raise HTTPException(
                status_code=status.HTTP_401_UNAUTHORIZED,
                detail="Неверный email или пароль",
            )

        # ── Update last_seen & back-fill tag if needed ─────────────────────
        now = _now_utc()
        tag = user["tag"] or user["username"]

        await db.execute(
            "UPDATE users SET last_seen = ?, tag = ? WHERE id = ?",
            (now, tag, user["id"]),
        )
        await db.commit()

    # ── Issue JWT ──────────────────────────────────────────────────────────
    access_token = create_access_token(
        user_id=user["id"],
        username=user["username"],
        tag=tag,
        is_admin=bool(user["is_admin"]),
    )

    return {
        "access_token": access_token,
        "token_type": "bearer",
        "user": {
            "id": user["id"],
            "username": user["username"],
            "tag": tag,
            "bio": user["bio"],
            "avatar": user["avatar"],
            "is_admin": bool(user["is_admin"]),
        },
    }
