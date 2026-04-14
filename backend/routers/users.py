"""
routers/users.py
User profile management, search, and avatar upload.

Endpoints:
  GET  /api/users/me            — return own profile
  PUT  /api/users/me            — update username / tag / bio
  POST /api/users/me/avatar     — upload a new avatar image
  GET  /api/users/search?q=...  — search users by tag or username
  GET  /api/users/{user_id}     — fetch another user's public profile
"""

import os
import pathlib
import re
from typing import Optional
from uuid import uuid4

import aiosqlite
from database import DB_PATH
from dependencies import get_current_user
from fastapi import APIRouter, Depends, File, HTTPException, Query, UploadFile, status
from pydantic import BaseModel

# ---------------------------------------------------------------------------
# File-system paths
# ---------------------------------------------------------------------------

_BASE_DIR = pathlib.Path(__file__).parent.parent  # …/backend/
_AVATARS_DIR = _BASE_DIR / "uploads" / "avatars"
_AVATARS_DIR.mkdir(parents=True, exist_ok=True)  # ensure dir exists

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

_ALLOWED_AVATAR_MIMES = {"image/jpeg", "image/png", "image/gif", "image/webp"}
_ALLOWED_AVATAR_EXTS = {
    "image/jpeg": ".jpg",
    "image/png": ".png",
    "image/gif": ".gif",
    "image/webp": ".webp",
}
_MAX_AVATAR_BYTES = 5 * 1024 * 1024  # 5 MB

_TAG_RE = re.compile(r"^[a-zA-Z0-9_]{3,20}$")

# ---------------------------------------------------------------------------
# Router
# ---------------------------------------------------------------------------

router = APIRouter(prefix="/api/users", tags=["users"])

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _now_utc() -> str:
    from datetime import datetime, timezone

    return datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M:%S")


async def _fetch_user_by_id(db: aiosqlite.Connection, user_id: int) -> Optional[dict]:
    """Return a user row as a dict, or None if not found."""
    db.row_factory = aiosqlite.Row
    async with db.execute("SELECT * FROM users WHERE id = ?", (user_id,)) as cur:
        row = await cur.fetchone()
    return dict(row) if row else None


# ---------------------------------------------------------------------------
# Request/response schemas
# ---------------------------------------------------------------------------


class UpdateProfileBody(BaseModel):
    username: Optional[str] = None
    tag: Optional[str] = None
    bio: Optional[str] = None


# ---------------------------------------------------------------------------
# GET /me
# ---------------------------------------------------------------------------


@router.get("/me", summary="Получить собственный профиль")
async def get_me(current_user: dict = Depends(get_current_user)) -> dict:
    """
    Return the authenticated user's full profile.

    Fields returned:
      id, username, tag, email, bio, avatar, is_admin, is_banned,
      last_seen, created_at
    """
    return {
        "id": current_user["id"],
        "username": current_user["username"],
        "tag": current_user["tag"],
        "email": current_user["email"],
        "bio": current_user.get("bio", ""),
        "avatar": current_user.get("avatar", ""),
        "is_admin": bool(current_user.get("is_admin", 0)),
        "is_banned": bool(current_user.get("is_banned", 0)),
        "last_seen": current_user.get("last_seen"),
        "created_at": current_user.get("created_at"),
    }


# ---------------------------------------------------------------------------
# PUT /me
# ---------------------------------------------------------------------------


@router.put("/me", summary="Обновить профиль")
async def update_me(
    body: UpdateProfileBody,
    current_user: dict = Depends(get_current_user),
) -> dict:
    """
    Partially update the authenticated user's profile.

    All fields are optional; only supplied non-None values are applied.

    Validation rules:
    - ``tag``:      3–20 chars, a-z A-Z 0-9 _; must be globally unique.
    - ``username``: 1–30 chars (trimmed).
    - ``bio``:      max 200 chars.
    """
    user_id = current_user["id"]
    now = _now_utc()

    # ── Field validation ──────────────────────────────────────────────────
    if body.tag is not None:
        tag = body.tag.strip()
        if not _TAG_RE.match(tag):
            raise HTTPException(
                status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                detail="Тег должен содержать 3–20 символов: буквы, цифры или _",
            )
        body = body.model_copy(update={"tag": tag})

    if body.username is not None:
        username = body.username.strip()
        if not (1 <= len(username) <= 30):
            raise HTTPException(
                status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                detail="Имя пользователя должно быть от 1 до 30 символов",
            )
        body = body.model_copy(update={"username": username})

    if body.bio is not None:
        if len(body.bio) > 200:
            raise HTTPException(
                status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                detail="Биография не может превышать 200 символов",
            )

    async with aiosqlite.connect(DB_PATH) as db:
        db.row_factory = aiosqlite.Row

        # ── Uniqueness check for tag ───────────────────────────────────────
        if body.tag is not None:
            async with db.execute(
                "SELECT id FROM users WHERE tag = ? AND id != ?",
                (body.tag, user_id),
            ) as cur:
                conflict = await cur.fetchone()
            if conflict:
                raise HTTPException(
                    status_code=status.HTTP_409_CONFLICT,
                    detail="Этот тег уже занят",
                )

        # ── Build dynamic SET clause ──────────────────────────────────────
        fields: dict = {"last_seen": now}
        if body.username is not None:
            fields["username"] = body.username
        if body.tag is not None:
            fields["tag"] = body.tag
        if body.bio is not None:
            fields["bio"] = body.bio

        set_clause = ", ".join(f"{col} = ?" for col in fields)
        params = list(fields.values()) + [user_id]

        await db.execute(
            f"UPDATE users SET {set_clause} WHERE id = ?",
            params,
        )
        await db.commit()

        # ── Return updated user ───────────────────────────────────────────
        updated = await _fetch_user_by_id(db, user_id)

    if not updated:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Пользователь не найден",
        )

    return {
        "id": updated["id"],
        "username": updated["username"],
        "tag": updated["tag"],
        "email": updated["email"],
        "bio": updated.get("bio", ""),
        "avatar": updated.get("avatar", ""),
        "is_admin": bool(updated.get("is_admin", 0)),
        "is_banned": bool(updated.get("is_banned", 0)),
        "last_seen": updated.get("last_seen"),
        "created_at": updated.get("created_at"),
    }


# ---------------------------------------------------------------------------
# POST /me/avatar
# ---------------------------------------------------------------------------


@router.post("/me/avatar", summary="Загрузить аватар")
async def upload_avatar(
    file: UploadFile = File(...),
    current_user: dict = Depends(get_current_user),
) -> dict:
    """
    Upload a new avatar image for the authenticated user.

    - Accepted MIME types: image/jpeg, image/png, image/gif, image/webp
    - Maximum file size: 5 MB
    - The old avatar file is deleted from disk if it differs from the new one.
    - Returns ``{"avatar": "<filename>", "avatar_url": "/uploads/avatars/<filename>"}``
    """
    # ── MIME-type check ───────────────────────────────────────────────────
    content_type = (file.content_type or "").lower()
    if content_type not in _ALLOWED_AVATAR_MIMES:
        raise HTTPException(
            status_code=status.HTTP_415_UNSUPPORTED_MEDIA_TYPE,
            detail="Разрешены только изображения: JPEG, PNG, GIF, WebP",
        )

    # ── Read file into memory ─────────────────────────────────────────────
    contents = await file.read()

    # ── Size check ────────────────────────────────────────────────────────
    if len(contents) > _MAX_AVATAR_BYTES:
        raise HTTPException(
            status_code=status.HTTP_413_REQUEST_ENTITY_TOO_LARGE,
            detail="Файл превышает максимально допустимый размер 5 МБ",
        )

    # ── Generate unique filename ──────────────────────────────────────────
    ext = _ALLOWED_AVATAR_EXTS.get(content_type, ".jpg")
    # Also try to infer extension from the original filename as a fallback.
    if file.filename:
        original_ext = pathlib.Path(file.filename).suffix.lower()
        if original_ext in {".jpg", ".jpeg", ".png", ".gif", ".webp"}:
            ext = original_ext if original_ext != ".jpeg" else ".jpg"

    new_filename = f"{uuid4().hex}{ext}"
    dest_path = _AVATARS_DIR / new_filename

    # ── Write to disk (binary) ────────────────────────────────────────────
    with open(dest_path, "wb") as fh:
        fh.write(contents)

    # ── Update DB and optionally remove old avatar ────────────────────────
    old_avatar = current_user.get("avatar", "")

    async with aiosqlite.connect(DB_PATH) as db:
        await db.execute(
            "UPDATE users SET avatar = ?, last_seen = ? WHERE id = ?",
            (new_filename, _now_utc(), current_user["id"]),
        )
        await db.commit()

    # Delete the previous avatar file if it's different
    if old_avatar and old_avatar != new_filename:
        old_path = _AVATARS_DIR / old_avatar
        try:
            old_path.unlink(missing_ok=True)
        except Exception:
            pass  # Non-critical; don't fail the request over a stale file

    return {
        "avatar": new_filename,
        "avatar_url": f"/uploads/avatars/{new_filename}",
    }


# ---------------------------------------------------------------------------
# GET /search
# ---------------------------------------------------------------------------


@router.get("/search", summary="Поиск пользователей")
async def search_users(
    q: str = Query(..., min_length=1, description="Поисковый запрос"),
    current_user: dict = Depends(get_current_user),
) -> list[dict]:
    """
    Search for users whose ``tag`` OR ``username`` contains the query string.

    - Case-insensitive LIKE search.
    - Excludes the authenticated user themselves.
    - Excludes banned users.
    - Returns at most 20 results.

    Each result: ``{id, username, tag, bio, avatar}``
    """
    pattern = f"%{q}%"

    async with aiosqlite.connect(DB_PATH) as db:
        db.row_factory = aiosqlite.Row
        async with db.execute(
            """
            SELECT id, username, tag, bio, avatar
              FROM users
             WHERE (tag LIKE ? OR username LIKE ?)
               AND id     != ?
               AND is_banned = 0
               AND is_verified = 1
             ORDER BY
                   -- Exact tag match first, then partial
                   CASE WHEN tag = ? THEN 0
                        WHEN username = ? THEN 1
                        ELSE 2 END,
                   username ASC
             LIMIT 20
            """,
            (pattern, pattern, current_user["id"], q, q),
        ) as cur:
            rows = await cur.fetchall()

    return [
        {
            "id": row["id"],
            "username": row["username"],
            "tag": row["tag"],
            "bio": row["bio"] or "",
            "avatar": row["avatar"] or "",
        }
        for row in rows
    ]


# ---------------------------------------------------------------------------
# GET /{user_id}
# ---------------------------------------------------------------------------


@router.get("/{user_id}", summary="Получить публичный профиль пользователя")
async def get_user(
    user_id: int,
    current_user: dict = Depends(get_current_user),
) -> dict:
    """
    Return a user's public profile by their numeric ID.

    Returns ``{id, username, tag, bio, avatar, last_seen, created_at}``.

    Raises 404 if the user does not exist, is not verified, or is banned.
    """
    async with aiosqlite.connect(DB_PATH) as db:
        db.row_factory = aiosqlite.Row
        async with db.execute(
            """
            SELECT id, username, tag, bio, avatar, last_seen, created_at
              FROM users
             WHERE id = ?
               AND is_verified = 1
               AND is_banned   = 0
            """,
            (user_id,),
        ) as cur:
            row = await cur.fetchone()

    if not row:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Пользователь не найден",
        )

    return {
        "id": row["id"],
        "username": row["username"],
        "tag": row["tag"],
        "bio": row["bio"] or "",
        "avatar": row["avatar"] or "",
        "last_seen": row["last_seen"],
        "created_at": row["created_at"],
    }


# ---------------------------------------------------------------------------
# GET /link/{token}  — resolve a share-link token (public)
# ---------------------------------------------------------------------------


@router.get("/link/{token}", summary="Разбор персональной ссылки")
async def resolve_share_link(token: str) -> dict:
    """
    Resolve a share-link token to a user profile.
    Public endpoint — no authentication required.
    Used by the frontend for deep-linking: ?invite=<token>
    """
    async with aiosqlite.connect(DB_PATH) as db:
        db.row_factory = aiosqlite.Row
        async with db.execute(
            """
            SELECT id, username, tag, bio, avatar, last_seen, is_banned, is_verified
              FROM users
             WHERE share_token = ?
            """,
            (token,),
        ) as cur:
            row = await cur.fetchone()

    if not row or row["is_banned"] or not row["is_verified"]:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Ссылка недействительна или пользователь не найден",
        )

    return {
        "id": row["id"],
        "username": row["username"],
        "tag": row["tag"],
        "bio": row["bio"] or "",
        "avatar": row["avatar"] or "",
    }


# ---------------------------------------------------------------------------
# GET  /me/share-link       — получить текущую ссылку
# POST /me/share-link       — создать / обновить ссылку
# DELETE /me/share-link     — удалить ссылку
# ---------------------------------------------------------------------------


class ShareLinkResponse(BaseModel):
    token: str
    url: str


@router.get("/me/share-link", summary="Моя персональная ссылка")
async def get_my_share_link(
    current_user: dict = Depends(get_current_user),
) -> dict:
    """Return the current share link for the authenticated user."""
    async with aiosqlite.connect(DB_PATH) as db:
        db.row_factory = aiosqlite.Row
        async with db.execute(
            "SELECT share_token FROM users WHERE id = ?",
            (current_user["id"],),
        ) as cur:
            row = await cur.fetchone()

    token = row["share_token"] if row else None
    if not token:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Персональная ссылка не создана",
        )

    return {"token": token, "url": f"?invite={token}"}


@router.post("/me/share-link", summary="Создать / обновить персональную ссылку")
async def create_share_link(
    current_user: dict = Depends(get_current_user),
) -> ShareLinkResponse:
    """Generate (or regenerate) a unique share link for the current user."""
    new_token = uuid4().hex[:16]

    async with aiosqlite.connect(DB_PATH) as db:
        await db.execute(
            "UPDATE users SET share_token = ? WHERE id = ?",
            (new_token, current_user["id"]),
        )
        await db.commit()

    return ShareLinkResponse(token=new_token, url=f"?invite={new_token}")


@router.delete("/me/share-link", summary="Удалить персональную ссылку")
async def delete_share_link(
    current_user: dict = Depends(get_current_user),
) -> dict:
    """Remove the share link for the current user."""
    async with aiosqlite.connect(DB_PATH) as db:
        await db.execute(
            "UPDATE users SET share_token = NULL WHERE id = ?",
            (current_user["id"],),
        )
        await db.commit()

    return {"message": "Ссылка удалена"}
