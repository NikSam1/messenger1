"""
models.py
Pydantic schemas for request validation and response serialization.
"""

import re
from typing import Optional

from pydantic import BaseModel, EmailStr, field_validator, model_validator

# ---------------------------------------------------------------------------
# Validators (reusable)
# ---------------------------------------------------------------------------

USERNAME_RE = re.compile(r"^[a-zA-Z0-9_]{3,20}$")


# ---------------------------------------------------------------------------
# Auth — Request schemas
# ---------------------------------------------------------------------------


class RegisterRequest(BaseModel):
    """Payload for POST /api/auth/register"""

    username: str
    email: EmailStr
    password: str

    @field_validator("username")
    @classmethod
    def validate_username(cls, v: str) -> str:
        v = v.strip()
        if not USERNAME_RE.match(v):
            raise ValueError(
                "Никнейм должен содержать от 3 до 20 символов: "
                "буквы, цифры или знак подчёркивания"
            )
        return v

    @field_validator("email")
    @classmethod
    def validate_email_format(cls, v: str) -> str:
        return v.strip().lower()

    @field_validator("password")
    @classmethod
    def validate_password(cls, v: str) -> str:
        if len(v) < 6:
            raise ValueError("Пароль должен содержать не менее 6 символов")
        return v


class VerifyEmailRequest(BaseModel):
    """Payload for POST /api/auth/verify-email"""

    email: EmailStr
    code: str

    @field_validator("code")
    @classmethod
    def validate_code(cls, v: str) -> str:
        v = v.strip()
        if not v.isdigit() or len(v) != 6:
            raise ValueError("Код должен состоять из 6 цифр")
        return v


class ResendCodeRequest(BaseModel):
    """Payload for POST /api/auth/resend-code"""

    email: EmailStr


# ---------------------------------------------------------------------------
# Auth — Response schemas
# ---------------------------------------------------------------------------


class MessageResponse(BaseModel):
    """Generic success message response"""

    message: str


class ErrorResponse(BaseModel):
    """Generic error response"""

    error: str


class DetailResponse(BaseModel):
    """FastAPI-compatible detail error (used for HTTP exceptions)"""

    detail: str
