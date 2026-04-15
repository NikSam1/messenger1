"""
routers/groups.py
Group chats: create, list, read messages, send messages, delete group.
"""

import json
import logging
from datetime import datetime, timedelta, timezone
from typing import Optional
from uuid import uuid4

import aiosqlite
from database import DB_PATH
from dependencies import get_current_user
from fastapi import APIRouter, Depends, HTTPException, Query, Request, status
from pydantic import BaseModel, field_validator
from routers.ws import manager

router = APIRouter(prefix="/api/groups", tags=["groups"])

# ── Structured Logging ──────────────────────────────────────────────────────────
logger = logging.getLogger("groups")


class JsonFormatter(logging.Formatter):
    def format(self, record):
        log_record = {
            "timestamp": datetime.now(timezone.utc).isoformat(),
            "level": record.levelname,
            "message": record.getMessage(),
            "module": record.module,
        }
        if hasattr(record, "extra"):
            log_record.update(record.extra)
        return json.dumps(log_record)


handler = logging.StreamHandler()
handler.setFormatter(JsonFormatter())
logger.addHandler(handler)
logger.setLevel(logging.DEBUG)


def _now_utc() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M:%S")


class CreateGroupBody(BaseModel):
    title: str
    member_tags: list[str] = []

    @field_validator("title")
    @classmethod
    def validate_title(cls, v: str) -> str:
        title = v.strip()
        if not (2 <= len(title) <= 64):
            raise ValueError("Название группы должно быть от 2 до 64 символов")
        return title


class SendGroupMessageBody(BaseModel):
    content: Optional[str] = None
    media_id: Optional[int] = None


async def _require_member(db: aiosqlite.Connection, group_id: int, user_id: int) -> None:
    async with db.execute(
        "SELECT 1 FROM group_members WHERE group_id = ? AND user_id = ?",
        (group_id, user_id),
    ) as cur:
        row = await cur.fetchone()
    if not row:
        raise HTTPException(status_code=403, detail="Вы не состоите в этой группе")


async def _fetch_group_message(
    db: aiosqlite.Connection, row: aiosqlite.Row
) -> dict:
    media = None
    if row["media_id"] is not None:
        async with db.execute(
            "SELECT id, filename, mime_type, original_name, size FROM media WHERE id = ?",
            (row["media_id"],),
        ) as cur:
            m = await cur.fetchone()
        if m:
            media = {
                "id": m["id"],
                "url": f"/uploads/{m['filename']}",
                "type": m["mime_type"],
                "name": m["original_name"],
                "size": m["size"],
            }

    return {
        "id": row["id"],
        "group_id": row["group_id"],
        "from_user_id": row["from_user_id"],
        "from_username": row["from_username"],
        "content": row["content"],
        "media": media,
        "edited_at": row["edited_at"],
        "created_at": row["created_at"],
    }


@router.post("", status_code=status.HTTP_201_CREATED, summary="Создать группу")
async def create_group(
    body: CreateGroupBody,
    current_user: dict = Depends(get_current_user),
) -> dict:
    me = current_user["id"]
    member_tags = sorted({t.strip().lstrip("@") for t in body.member_tags if t.strip()})

    async with aiosqlite.connect(DB_PATH) as db:
        db.row_factory = aiosqlite.Row
        member_ids = []
        if member_tags:
            placeholders = ",".join("?" for _ in member_tags)
            async with db.execute(
                f"""
                SELECT id FROM users
                WHERE tag IN ({placeholders}) AND is_verified = 1 AND is_banned = 0
                """,
                tuple(member_tags),
            ) as cur:
                rows = await cur.fetchall()
                member_ids = [row["id"] for row in rows if row["id"] != me]

        async with db.execute(
            "INSERT INTO group_chats (title, owner_id) VALUES (?, ?)",
            (body.title, me),
        ) as cur:
            group_id = cur.lastrowid

        # Add owner
        await db.execute(
            "INSERT INTO group_members (group_id, user_id, role) VALUES (?, ?, 'owner')",
            (group_id, me),
        )

        # Add members
        for uid in member_ids:
            await db.execute(
                "INSERT INTO group_members (group_id, user_id, role) VALUES (?, ?, 'member')",
                (group_id, uid),
            )

        await db.commit()

        # Notify via WS
        for uid in [me] + member_ids:
            if manager.is_online(uid):
                await manager.send_to_user(
                    uid,
                    {
                        "type": "group_created",
                        "group_id": group_id,
                        "title": body.title,
                    },
                )

    return {"id": group_id, "title": body.title, "members_added": len(member_ids)}


@router.get("", summary="Мои группы")
async def list_my_groups(current_user: dict = Depends(get_current_user)) -> list[dict]:
    me = current_user["id"]
    async with aiosqlite.connect(DB_PATH) as db:
        db.row_factory = aiosqlite.Row
        async with db.execute(
            """
            SELECT g.id, g.title, g.avatar, g.owner_id, g.created_at
            FROM group_chats g
            JOIN group_members gm ON gm.group_id = g.id
            WHERE gm.user_id = ?
            ORDER BY g.created_at DESC
            """,
            (me,),
        ) as cur:
            groups = await cur.fetchall()

        result: list[dict] = []
        for g in groups:
            async with db.execute(
                "SELECT COUNT(*) AS cnt FROM group_members WHERE group_id = ?",
                (g["id"],),
            ) as cur:
                members_count = (await cur.fetchone())["cnt"]

            async with db.execute(
                """
                SELECT gm.id, gm.group_id, gm.from_user_id, gm.content, gm.media_id,
                       gm.edited_at, gm.created_at, u.username AS from_username
                FROM group_messages gm
                JOIN users u ON u.id = gm.from_user_id
                WHERE gm.group_id = ? AND gm.is_deleted = 0
                ORDER BY gm.created_at DESC
                LIMIT 1
                """,
                (g["id"],),
            ) as cur:
                last = await cur.fetchone()

            result.append(
                {
                    "id": g["id"],
                    "title": g["title"],
                    "avatar": g["avatar"],
                    "owner_id": g["owner_id"],
                    "members_count": members_count,
                    "created_at": g["created_at"],
                    "last_message": await _fetch_group_message(db, last) if last else None,
                }
            )

    return result


@router.get("/{group_id}", summary="Профиль группы")
async def get_group(group_id: int, current_user: dict = Depends(get_current_user)) -> dict:
    me = current_user["id"]
    async with aiosqlite.connect(DB_PATH) as db:
        db.row_factory = aiosqlite.Row
        await _require_member(db, group_id, me)

        async with db.execute(
            "SELECT id, title, avatar, owner_id, created_at FROM group_chats WHERE id = ?",
            (group_id,),
        ) as cur:
            group = await cur.fetchone()
        if not group:
            raise HTTPException(status_code=404, detail="Группа не найдена")

        async with db.execute(
            """
            SELECT u.id, u.username, u.tag, u.avatar, gm.role
            FROM group_members gm
            JOIN users u ON u.id = gm.user_id
            WHERE gm.group_id = ?
            ORDER BY CASE gm.role WHEN 'owner' THEN 0 ELSE 1 END, u.username
            """,
            (group_id,),
        ) as cur:
            members = await cur.fetchall()

    return {
        "id": group["id"],
        "title": group["title"],
        "avatar": group["avatar"],
        "owner_id": group["owner_id"],
        "created_at": group["created_at"],
        "members": [
            {
                "id": m["id"],
                "username": m["username"],
                "tag": m["tag"],
                "avatar": m["avatar"],
                "role": m["role"],
            }
            for m in members
        ],
    }


@router.get("/{group_id}/messages", summary="Сообщения группы")
async def get_group_messages(
    group_id: int,
    before_id: Optional[int] = Query(None),
    limit: int = Query(50, ge=1, le=100),
    current_user: dict = Depends(get_current_user),
) -> list[dict]:
    me = current_user["id"]
    async with aiosqlite.connect(DB_PATH) as db:
        db.row_factory = aiosqlite.Row
        await _require_member(db, group_id, me)

        before_clause = "AND gm.id < :before_id" if before_id else ""
        async with db.execute(
            f"""
            SELECT gm.id, gm.group_id, gm.from_user_id, gm.content, gm.media_id,
                   gm.edited_at, gm.created_at, u.username AS from_username
            FROM group_messages gm
            JOIN users u ON u.id = gm.from_user_id
            WHERE gm.group_id = :group_id
              AND gm.is_deleted = 0
              {before_clause}
            ORDER BY gm.created_at DESC
            LIMIT :limit
            """,
            {"group_id": group_id, "before_id": before_id, "limit": limit},
        ) as cur:
            rows = await cur.fetchall()

        rows = list(reversed(rows))
        return [await _fetch_group_message(db, row) for row in rows]


@router.post(
    "/{group_id}/messages",
    status_code=status.HTTP_201_CREATED,
    summary="Отправить сообщение в группу",
)
async def send_group_message(
    group_id: int,
    body: SendGroupMessageBody,
    current_user: dict = Depends(get_current_user),
) -> dict:
    me = current_user["id"]
    content = (body.content or "").strip() or None
    media_id = body.media_id
    if not content and not media_id:
        raise HTTPException(status_code=422, detail="Нужно указать текст или медиа")

    async with aiosqlite.connect(DB_PATH) as db:
        db.row_factory = aiosqlite.Row
        await _require_member(db, group_id, me)

        if media_id is not None:
            async with db.execute(
                "SELECT id FROM media WHERE id = ? AND uploader_id = ?",
                (media_id, me),
            ) as cur:
                if await cur.fetchone() is None:
                    raise HTTPException(status_code=400, detail="Медиафайл не найден")

        async with db.execute(
            "INSERT INTO group_messages (group_id, from_user_id, content, media_id) VALUES (?, ?, ?, ?)",
            (group_id, me, content, media_id),
        ) as cur:
            msg_id = cur.lastrowid
        await db.commit()

        async with db.execute(
            """
            SELECT gm.id, gm.group_id, gm.from_user_id, gm.content, gm.media_id,
                   gm.edited_at, gm.created_at, u.username AS from_username
            FROM group_messages gm
            JOIN users u ON u.id = gm.from_user_id
            WHERE gm.id = ?
            """,
            (msg_id,),
        ) as cur:
            row = await cur.fetchone()
        message = await _fetch_group_message(db, row)

        async with db.execute(
            "SELECT user_id FROM group_members WHERE group_id = ?",
            (group_id,),
        ) as cur:
            member_ids = [r["user_id"] for r in await cur.fetchall() if r["user_id"] != me]

    for uid in member_ids:
        await manager.send_to_user(
            uid,
            {"type": "group_message", "group_id": group_id, "message": message},
        )
    return message


@router.delete("/{group_id}", summary="Удалить группу целиком")
async def delete_group(group_id: int, current_user: dict = Depends(get_current_user)) -> dict:
    me = current_user["id"]
    async with aiosqlite.connect(DB_PATH) as db:
        db.row_factory = aiosqlite.Row
        async with db.execute(
            "SELECT id, owner_id FROM group_chats WHERE id = ?",
            (group_id,),
        ) as cur:
            group = await cur.fetchone()
        if not group:
            raise HTTPException(status_code=404, detail="Группа не найдена")
        if group["owner_id"] != me:
            raise HTTPException(
                status_code=403,
                detail="Удалить группу может только владелец",
            )
        await db.execute("DELETE FROM group_chats WHERE id = ?", (group_id,))
        await db.commit()
    return {"message": "Группа удалена"}


# ---------------------------------------------------------------------------
# Invite links
# ---------------------------------------------------------------------------


@router.get("/{group_id}/invite", summary="Получить пригласительную ссылку группы")
async def get_group_invite(
    group_id: int,
    current_user: dict = Depends(get_current_user),
) -> dict:
    """Return the active invite link for a group (owner/admin only)."""
    me = current_user["id"]
    async with aiosqlite.connect(DB_PATH) as db:
        db.row_factory = aiosqlite.Row

        await _require_member(db, group_id, me)
        async with db.execute(
            "SELECT owner_id FROM group_chats WHERE id = ?",
            (group_id,),
        ) as cur:
            group = await cur.fetchone()
        if not group:
            raise HTTPException(status_code=404, detail="Группа не найдена")
        if group["owner_id"] != me:
            raise HTTPException(
                status_code=403,
                detail="Ссылку может видеть только владелец группы",
            )

        async with db.execute(
            "SELECT id, code, expires_at, is_active FROM group_invite_links "
            "WHERE group_id = ? AND is_active = 1 "
            "ORDER BY created_at DESC LIMIT 1",
            (group_id,),
        ) as cur:
            link = await cur.fetchone()

    if not link:
        raise HTTPException(status_code=404, detail="Пригласительная ссылка не создана")

    return {
        "id": link["id"],
        "code": link["code"],
        "url": f"invite/{link['code']}",
        "expires_at": link["expires_at"],
    }


@router.post("/{group_id}/invite", summary="Создать пригласительную ссылку")
async def create_group_invite(
    group_id: int,
    max_uses: Optional[int] = Query(None, description="Максимальное количество использований"),
    current_user: dict = Depends(get_current_user),
) -> dict:
    """Create (or regenerate) an invite link for the group (owner only)."""
    me = current_user["id"]
    async with aiosqlite.connect(DB_PATH) as db:
        db.row_factory = aiosqlite.Row

        await _require_member(db, group_id, me)
        async with db.execute(
            "SELECT owner_id FROM group_chats WHERE id = ?",
            (group_id,),
        ) as cur:
            group = await cur.fetchone()
        if not group:
            raise HTTPException(status_code=404, detail="Группа не найдена")
        if group["owner_id"] != me:
            raise HTTPException(
                status_code=403,
                detail="Ссылку может создать только владелец группы",
            )

        # token format: uuidv4 + unix-ms timestamp (traceable, sortable, unique)
        code = f"{uuid4()}-{int(datetime.now(timezone.utc).timestamp() * 1000)}"
        expires_at = (datetime.now(timezone.utc) + timedelta(days=7)).strftime("%Y-%m-%d %H:%M:%S")

        async with db.execute(
            "SELECT id FROM group_invite_links WHERE group_id = ? AND is_active = 1",
            (group_id,),
        ) as cur:
            existing = await cur.fetchone()

        if existing:
            await db.execute(
                "UPDATE group_invite_links SET is_active = 0 WHERE id = ?",
                (existing["id"],),
            )

        async with db.execute(
            "INSERT INTO group_invite_links (group_id, code, created_by, expires_at, max_uses) VALUES (?, ?, ?, ?, ?)",
            (group_id, code, me, expires_at, max_uses),
        ) as cur:
            link_id = cur.lastrowid
        await db.commit()

    return {
        "id": link_id,
        "code": code,
        "url": f"invite/{code}",
        "expires_at": expires_at,
    }


@router.delete("/{group_id}/invite", summary="Отключить пригласительную ссылку")
async def delete_group_invite(
    group_id: int,
    current_user: dict = Depends(get_current_user),
) -> dict:
    """Deactivate the current invite link (owner only)."""
    me = current_user["id"]
    async with aiosqlite.connect(DB_PATH) as db:
        db.row_factory = aiosqlite.Row

        await _require_member(db, group_id, me)
        async with db.execute(
            "SELECT owner_id FROM group_chats WHERE id = ?",
            (group_id,),
        ) as cur:
            group = await cur.fetchone()
        if not group:
            raise HTTPException(status_code=404, detail="Группа не найдена")
        if group["owner_id"] != me:
            raise HTTPException(
                status_code=403,
                detail="Ссылку может отключить только владелец",
            )

        await db.execute(
            "UPDATE group_invite_links SET is_active = 0 WHERE group_id = ? AND is_active = 1",
            (group_id,),
        )
        await db.commit()

    return {"message": "Пригласительная ссылка отключена"}


@router.get("/invite/{code}", summary="Присоединиться к группе по коду")
async def join_by_invite(
    code: str,
    request: Request,
    current_user: dict = Depends(get_current_user),
) -> dict:
    """Join a group using an invite link code."""
    me = current_user["id"]
    ip = request.client.host if request.client else "unknown"
    ua = request.headers.get("user-agent", "unknown")
    correlation_id = request.headers.get("x-correlation-id") or uuid4().hex

    log_extra = {
        "extra": {
            "correlation_id": correlation_id,
            "ip": ip,
            "user_agent": ua,
            "user_id": me,
            "code": code,
        }
    }

    async with aiosqlite.connect(DB_PATH) as db:
        db.row_factory = aiosqlite.Row

        async with db.execute(
            """
            SELECT gil.id, gil.group_id, gil.is_active, gil.expires_at, gil.max_uses, gil.used_count,
                   gc.title, gc.owner_id
              FROM group_invite_links gil
              JOIN group_chats gc ON gc.id = gil.group_id
             WHERE gil.code = ?
            """,
            (code,),
        ) as cur:
            link = await cur.fetchone()

        if not link:
            logger.warning("Invite code not found", extra=log_extra["extra"])
            raise HTTPException(status_code=404, detail="Пригласительная ссылка не найдена")
        if not link["is_active"]:
            logger.warning("Invite code inactive", extra=log_extra["extra"])
            raise HTTPException(status_code=410, detail="Пригласительная ссылка больше недействительна")

        if link["expires_at"]:
            expires_dt = datetime.strptime(link["expires_at"], "%Y-%m-%d %H:%M:%S").replace(tzinfo=timezone.utc)
            if datetime.now(timezone.utc) > expires_dt:
                await db.execute("UPDATE group_invite_links SET is_active = 0 WHERE id = ?", (link["id"],))
                await db.commit()
                logger.warning("Invite code expired", extra=log_extra["extra"])
                raise HTTPException(status_code=410, detail="Срок действия ссылки истек")

        if link["max_uses"] is not None and link["used_count"] >= link["max_uses"]:
            await db.execute("UPDATE group_invite_links SET is_active = 0 WHERE id = ?", (link["id"],))
            await db.commit()
            logger.warning("Invite code max uses reached", extra=log_extra["extra"])
            raise HTTPException(status_code=410, detail="Максимальное количество использований ссылки достигнуто")

        async with db.execute(
            "SELECT 1 FROM group_members WHERE group_id = ? AND user_id = ?",
            (link["group_id"], me),
        ) as cur:
            if await cur.fetchone():
                logger.info("User already member of group", extra=log_extra["extra"])
                raise HTTPException(status_code=409, detail="Вы уже состоите в этой группе")

        await db.execute(
            "INSERT INTO group_members (group_id, user_id, role) VALUES (?, ?, 'member')",
            (link["group_id"], me),
        )
        await db.execute(
            "UPDATE group_invite_links SET used_count = used_count + 1 WHERE id = ?",
            (link["id"],),
        )
        await db.commit()

        logger.info("User joined group via invite", extra=log_extra["extra"])

        for uid in manager.online_user_ids():
            if uid != me:
                await manager.send_to_user(
                    uid,
                    {
                        "type": "group_member_joined",
                        "group_id": link["group_id"],
                        "user_id": me,
                        "username": current_user.get("username", ""),
                    },
                )

    return {
        "group_id": link["group_id"],
        "title": link["title"],
        "message": "Вы присоединились к группе",
    }


@router.post("/invite/{code}", summary="Присоединиться к группе по коду (POST)")
async def join_by_invite_post(
    code: str,
    request: Request,
    current_user: dict = Depends(get_current_user),
) -> dict:
    """
    Frontend historically calls POST /api/groups/invite/{code}.
    Keep this alias to avoid breaking deep links and old clients.
    """
    return await join_by_invite(code=code, request=request, current_user=current_user)


# ---------------------------------------------------------------------------
# Leave group
# ---------------------------------------------------------------------------


@router.delete("/{group_id}/leave", summary="Покинуть группу")
async def leave_group(
    group_id: int,
    current_user: dict = Depends(get_current_user),
) -> dict:
    """Leave a group. Owner cannot leave — must delete or transfer ownership."""
    me = current_user["id"]

    async with aiosqlite.connect(DB_PATH) as db:
        db.row_factory = aiosqlite.Row

        async with db.execute(
            "SELECT id, owner_id FROM group_chats WHERE id = ?",
            (group_id,),
        ) as cur:
            group = await cur.fetchone()
        if not group:
            raise HTTPException(status_code=404, detail="Группа не найдена")

        if group["owner_id"] == me:
            raise HTTPException(
                status_code=403,
                detail="Владелец не может покинуть группу. Удалите или передайте группу.",
            )

        await _require_member(db, group_id, me)

        async with db.execute(
            "SELECT username FROM users WHERE id = ?",
            (me,),
        ) as cur:
            user_row = await cur.fetchone()
        username = user_row["username"] if user_row else str(me)

        await db.execute(
            "DELETE FROM group_members WHERE group_id = ? AND user_id = ?",
            (group_id, me),
        )
        await db.commit()

        for uid in manager.online_user_ids():
            await manager.send_to_user(
                uid,
                {
                    "type": "group_member_left",
                    "group_id": group_id,
                    "user_id": me,
                    "username": username,
                },
            )

    return {"message": "Вы покинули группу"}

