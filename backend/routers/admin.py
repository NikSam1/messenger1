"""
routers/admin.py
Admin dashboard endpoints.

All routes require admin privileges (get_admin_user dependency).

Endpoints:
  GET    /api/admin/stats                 — aggregate platform statistics
  GET    /api/admin/users                 — paginated list of all users
  DELETE /api/admin/users/{user_id}       — delete a user and their files
  PUT    /api/admin/users/{user_id}/ban   — ban or unban a user
  PUT    /api/admin/users/{user_id}/admin — grant or revoke admin status
"""

import os
import pathlib
from datetime import datetime, timezone

import aiosqlite
from database import DB_PATH
from dependencies import get_admin_user
from fastapi import APIRouter, Depends, HTTPException, Query, status
from pydantic import BaseModel

# ---------------------------------------------------------------------------
# Setup
# ---------------------------------------------------------------------------

router = APIRouter(prefix="/api/admin", tags=["admin"])

# Resolve the uploads directory relative to this file's location:
# routers/ → backend/ → uploads/
_BASE_DIR: pathlib.Path = pathlib.Path(__file__).parent.parent
UPLOADS_DIR: pathlib.Path = _BASE_DIR / "uploads"
AVATARS_DIR: pathlib.Path = UPLOADS_DIR / "avatars"
MEDIA_DIR: pathlib.Path = UPLOADS_DIR / "media"


# ---------------------------------------------------------------------------
# Request schemas
# ---------------------------------------------------------------------------


class BanRequest(BaseModel):
    banned: bool


class AdminRequest(BaseModel):
    is_admin: bool


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _safe_unlink(path: pathlib.Path) -> None:
    """Delete a file silently — never raises even if the file is missing."""
    try:
        path.unlink(missing_ok=True)
    except Exception:
        pass


async def _fetch_user(db: aiosqlite.Connection, user_id: int) -> aiosqlite.Row:
    """Return a user row or raise 404."""
    async with db.execute("SELECT * FROM users WHERE id = ?", (user_id,)) as cur:
        user = await cur.fetchone()
    if not user:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Пользователь не найден",
        )
    return user


# ---------------------------------------------------------------------------
# GET /stats
# ---------------------------------------------------------------------------


@router.get(
    "/stats",
    summary="Статистика платформы",
)
async def get_stats(admin: dict = Depends(get_admin_user)):
    """
    Return aggregate statistics for the admin dashboard:
    - total / verified / banned user counts
    - users seen in the last 5 minutes (online)
    - total messages and media records
    - total media storage consumed (MB)
    """
    async with aiosqlite.connect(DB_PATH) as db:
        db.row_factory = aiosqlite.Row

        # ── User counts ────────────────────────────────────────────────────
        async with db.execute("SELECT COUNT(*) FROM users") as cur:
            row = await cur.fetchone()
            users_total: int = row[0]

        async with db.execute(
            "SELECT COUNT(*) FROM users WHERE is_verified = 1"
        ) as cur:
            row = await cur.fetchone()
            users_verified: int = row[0]

        async with db.execute("SELECT COUNT(*) FROM users WHERE is_banned = 1") as cur:
            row = await cur.fetchone()
            users_banned: int = row[0]

        # "Online" = last seen within the last 5 minutes
        async with db.execute(
            """
            SELECT COUNT(*) FROM users
             WHERE last_seen IS NOT NULL
               AND datetime(last_seen) >= datetime('now', '-5 minutes')
            """
        ) as cur:
            row = await cur.fetchone()
            users_online: int = row[0]

        # ── Messages ───────────────────────────────────────────────────────
        async with db.execute("SELECT COUNT(*) FROM messages") as cur:
            row = await cur.fetchone()
            messages_total: int = row[0]

        # ── Media ──────────────────────────────────────────────────────────
        async with db.execute(
            "SELECT COUNT(*), COALESCE(SUM(size), 0) FROM media"
        ) as cur:
            row = await cur.fetchone()
            media_total: int = row[0]
            media_bytes: int = row[1]

    media_size_mb = round(media_bytes / 1024 / 1024, 2)

    return {
        "users_total": users_total,
        "users_verified": users_verified,
        "users_banned": users_banned,
        "users_online": users_online,
        "messages_total": messages_total,
        "media_total": media_total,
        "media_size_mb": media_size_mb,
    }


# ---------------------------------------------------------------------------
# GET /users
# ---------------------------------------------------------------------------


@router.get(
    "/users",
    summary="Список всех пользователей (с пагинацией)",
)
async def list_users(
    page: int = Query(1, ge=1, description="Номер страницы"),
    limit: int = Query(50, ge=1, le=200, description="Пользователей на странице"),
    admin: dict = Depends(get_admin_user),
):
    """
    Return a paginated, id-DESC-ordered list of every user in the system
    together with total count and page metadata.
    """
    offset = (page - 1) * limit

    async with aiosqlite.connect(DB_PATH) as db:
        db.row_factory = aiosqlite.Row

        async with db.execute("SELECT COUNT(*) FROM users") as cur:
            row = await cur.fetchone()
            total: int = row[0]

        async with db.execute(
            """
            SELECT id, username, tag, email, bio, avatar,
                   is_verified, is_admin, is_banned, last_seen, created_at
              FROM users
             ORDER BY id DESC
             LIMIT ? OFFSET ?
            """,
            (limit, offset),
        ) as cur:
            rows = await cur.fetchall()

    users = [dict(r) for r in rows]
    pages = max(1, -(-total // limit))  # ceiling division

    return {
        "users": users,
        "total": total,
        "page": page,
        "pages": pages,
    }


# ---------------------------------------------------------------------------
# DELETE /users/{user_id}
# ---------------------------------------------------------------------------


@router.delete(
    "/users/{user_id}",
    summary="Удалить пользователя",
)
async def delete_user(
    user_id: int,
    admin: dict = Depends(get_admin_user),
):
    """
    Permanently delete a user account.

    - Cannot delete yourself.
    - Deletes the DB row (ON DELETE CASCADE removes messages & media records).
    - Also removes the user's avatar and all uploaded media files from disk.
    """
    if user_id == admin["id"]:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Нельзя удалить собственный аккаунт",
        )

    async with aiosqlite.connect(DB_PATH) as db:
        db.row_factory = aiosqlite.Row

        user = await _fetch_user(db, user_id)

        # Collect media filenames BEFORE the cascade wipes media records.
        async with db.execute(
            "SELECT filename FROM media WHERE uploader_id = ?", (user_id,)
        ) as cur:
            media_rows = await cur.fetchall()

        # Delete the user — cascade handles messages and media table rows.
        await db.execute("DELETE FROM users WHERE id = ?", (user_id,))
        await db.commit()

    # ── Disk clean-up (best-effort, outside DB transaction) ───────────────
    # Avatar
    avatar_filename: str = user["avatar"] or ""
    if avatar_filename:
        _safe_unlink(AVATARS_DIR / avatar_filename)

    # Uploaded media files
    for row in media_rows:
        _safe_unlink(MEDIA_DIR / row["filename"])
        # Also check the root uploads directory as a fallback.
        _safe_unlink(UPLOADS_DIR / row["filename"])

    return {"message": "Пользователь удалён"}


# ---------------------------------------------------------------------------
# PUT /users/{user_id}/ban
# ---------------------------------------------------------------------------


@router.put(
    "/users/{user_id}/ban",
    summary="Заблокировать / разблокировать пользователя",
)
async def ban_user(
    user_id: int,
    body: BanRequest,
    admin: dict = Depends(get_admin_user),
):
    """
    Set ``is_banned`` for the target user.

    Restrictions:
    - Cannot ban yourself.
    - Cannot ban another admin (demote them first).
    """
    if user_id == admin["id"]:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Нельзя заблокировать собственный аккаунт",
        )

    async with aiosqlite.connect(DB_PATH) as db:
        db.row_factory = aiosqlite.Row

        target = await _fetch_user(db, user_id)

        if target["is_admin"] and body.banned:
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail="Нельзя заблокировать администратора. "
                "Сначала снимите с него права администратора.",
            )

        await db.execute(
            "UPDATE users SET is_banned = ? WHERE id = ?",
            (int(body.banned), user_id),
        )
        await db.commit()

        async with db.execute("SELECT * FROM users WHERE id = ?", (user_id,)) as cur:
            updated = await cur.fetchone()

    return dict(updated)


# ---------------------------------------------------------------------------
# PUT /users/{user_id}/admin
# ---------------------------------------------------------------------------


@router.put(
    "/users/{user_id}/admin",
    summary="Выдать / забрать права администратора",
)
async def set_admin(
    user_id: int,
    body: AdminRequest,
    admin: dict = Depends(get_admin_user),
):
    """
    Grant or revoke admin privileges for the target user.

    Restrictions:
    - Cannot change your own admin status.
    """
    if user_id == admin["id"]:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Нельзя изменить собственные права администратора",
        )

    async with aiosqlite.connect(DB_PATH) as db:
        db.row_factory = aiosqlite.Row

        # Ensure the target user exists before updating.
        await _fetch_user(db, user_id)

        await db.execute(
            "UPDATE users SET is_admin = ? WHERE id = ?",
            (int(body.is_admin), user_id),
        )
        await db.commit()

        async with db.execute("SELECT * FROM users WHERE id = ?", (user_id,)) as cur:
            updated = await cur.fetchone()

    return dict(updated)
