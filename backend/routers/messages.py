"""
routers/messages.py
Chat messages: conversations list, send, edit, delete with real-time WebSocket push.

New in v2:
  - reply_to_id: reply to a specific message (like Telegram)
  - delete for self vs delete for all
  - deleted_for_sender / deleted_for_receiver filtering
"""

from datetime import datetime, timezone
from typing import Optional

import aiosqlite
from database import DB_PATH
from dependencies import get_current_user
from fastapi import APIRouter, Depends, HTTPException, Query, status
from pydantic import BaseModel

from routers.ws import manager

router = APIRouter(prefix="/api/messages", tags=["messages"])


# ---------------------------------------------------------------------------
# Pydantic schemas
# ---------------------------------------------------------------------------


class SendMessage(BaseModel):
    content: Optional[str] = None
    media_id: Optional[int] = None
    reply_to_id: Optional[int] = None  # NEW: reply to a message


class EditMessage(BaseModel):
    content: str


# ---------------------------------------------------------------------------
# Internal helpers
# ---------------------------------------------------------------------------


def _now_utc() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M:%S")


async def _format_reply(reply_id: int, db: aiosqlite.Connection) -> Optional[dict]:
    """Fetch minimal info about the message being replied to."""
    if reply_id is None:
        return None
    async with db.execute(
        """
        SELECT m.id, m.from_user_id, m.content, m.media_id, m.is_deleted,
               u.username
        FROM messages m
        JOIN users u ON u.id = m.from_user_id
        WHERE m.id = ?
        """,
        (reply_id,),
    ) as cur:
        row = await cur.fetchone()
    if row is None:
        return None
    # Short preview
    if row["is_deleted"]:
        preview = "Сообщение удалено"
    elif row["content"]:
        preview = row["content"][:80]
    elif row["media_id"]:
        preview = "📎 Медиафайл"
    else:
        preview = ""
    return {
        "id": row["id"],
        "from_user_id": row["from_user_id"],
        "username": row["username"],
        "preview": preview,
    }


async def _format_message(row: aiosqlite.Row, db: aiosqlite.Connection) -> dict:
    """Convert a messages row into the canonical API dict."""
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

    reply_to = None
    reply_to_id = row["reply_to_id"] if "reply_to_id" in row.keys() else None
    if reply_to_id:
        reply_to = await _format_reply(reply_to_id, db)

    return {
        "id": row["id"],
        "from_user_id": row["from_user_id"],
        "to_user_id": row["to_user_id"],
        "content": row["content"],
        "media": media,
        "reply_to": reply_to,
        "is_read": bool(row["is_read"]),
        "is_deleted": bool(row["is_deleted"]),
        "edited_at": row["edited_at"],
        "created_at": row["created_at"],
    }


async def _get_message_or_403(
    db: aiosqlite.Connection,
    message_id: int,
    user_id: int,
) -> aiosqlite.Row:
    """Fetch a message where user is sender OR receiver. 403 if neither."""
    async with db.execute("SELECT * FROM messages WHERE id = ?", (message_id,)) as cur:
        msg = await cur.fetchone()
    if msg is None:
        raise HTTPException(status_code=404, detail="Сообщение не найдено")
    if msg["from_user_id"] != user_id and msg["to_user_id"] != user_id:
        raise HTTPException(status_code=403, detail="Нет доступа к этому сообщению")
    return msg


# ---------------------------------------------------------------------------
# GET /conversations
# ---------------------------------------------------------------------------


@router.get("/conversations", summary="Список диалогов")
async def get_conversations(current_user: dict = Depends(get_current_user)) -> list:
    me: int = current_user["id"]

    async with aiosqlite.connect(DB_PATH) as db:
        db.row_factory = aiosqlite.Row

        # Find all unique conversation partners
        async with db.execute(
            """
            SELECT DISTINCT
                CASE WHEN from_user_id = :me THEN to_user_id
                     ELSE from_user_id END AS partner_id
            FROM messages
            WHERE (from_user_id = :me OR to_user_id = :me)
              AND is_deleted = 0
              AND NOT (deleted_for_sender = 1 AND from_user_id = :me)
              AND NOT (deleted_for_receiver = 1 AND to_user_id = :me)
            """,
            {"me": me},
        ) as cur:
            partner_rows = await cur.fetchall()

        result = []
        for pr in partner_rows:
            partner_id = pr["partner_id"]

            # Partner profile
            async with db.execute(
                "SELECT id, username, tag, bio, avatar, last_seen FROM users WHERE id = ?",
                (partner_id,),
            ) as cur:
                partner = await cur.fetchone()
            if partner is None:
                continue

            # Last message (visible to me)
            async with db.execute(
                """
                SELECT * FROM messages
                WHERE ((from_user_id = :me AND to_user_id = :them)
                    OR (from_user_id = :them AND to_user_id = :me))
                  AND is_deleted = 0
                  AND NOT (deleted_for_sender = 1 AND from_user_id = :me)
                  AND NOT (deleted_for_receiver = 1 AND to_user_id = :me)
                ORDER BY created_at DESC
                LIMIT 1
                """,
                {"me": me, "them": partner_id},
            ) as cur:
                last_row = await cur.fetchone()

            last_message = await _format_message(last_row, db) if last_row else None

            # Unread count
            async with db.execute(
                """
                SELECT COUNT(*) as cnt FROM messages
                WHERE from_user_id = :them AND to_user_id = :me
                  AND is_read = 0 AND is_deleted = 0
                  AND NOT (deleted_for_receiver = 1 AND to_user_id = :me)
                """,
                {"me": me, "them": partner_id},
            ) as cur:
                unread_row = await cur.fetchone()

            result.append(
                {
                    "user": {
                        "id": partner["id"],
                        "username": partner["username"],
                        "tag": partner["tag"],
                        "bio": partner["bio"],
                        "avatar": partner["avatar"],
                        "last_seen": partner["last_seen"],
                    },
                    "last_message": last_message,
                    "unread_count": unread_row["cnt"] if unread_row else 0,
                }
            )

        # Sort by last message time
        result.sort(
            key=lambda x: x["last_message"]["created_at"] if x["last_message"] else "",
            reverse=True,
        )

    return result


# ---------------------------------------------------------------------------
# GET /{user_id}
# ---------------------------------------------------------------------------


@router.get("/{user_id}", summary="Получить сообщения с пользователем")
async def get_messages(
    user_id: int,
    before_id: Optional[int] = Query(None),
    limit: int = Query(50, ge=1, le=100),
    current_user: dict = Depends(get_current_user),
) -> list:
    me: int = current_user["id"]

    async with aiosqlite.connect(DB_PATH) as db:
        db.row_factory = aiosqlite.Row

        before_clause = "AND id < :before_id" if before_id else ""

        async with db.execute(
            f"""
            SELECT * FROM messages
            WHERE ((from_user_id = :me AND to_user_id = :them)
                OR (from_user_id = :them AND to_user_id = :me))
              AND is_deleted = 0
              AND NOT (deleted_for_sender   = 1 AND from_user_id = :me)
              AND NOT (deleted_for_receiver = 1 AND to_user_id   = :me)
              {before_clause}
            ORDER BY created_at DESC
            LIMIT :limit
            """,
            {"me": me, "them": user_id, "before_id": before_id, "limit": limit},
        ) as cur:
            rows = await cur.fetchall()

        # Reverse so oldest is first (natural chat order)
        rows = list(reversed(rows))

        # Mark messages to me as read
        await db.execute(
            """
            UPDATE messages SET is_read = 1
            WHERE from_user_id = :them AND to_user_id = :me AND is_read = 0
            """,
            {"me": me, "them": user_id},
        )
        await db.commit()

        result = []
        for row in rows:
            result.append(await _format_message(row, db))

    return result


# ---------------------------------------------------------------------------
# POST /{user_id}
# ---------------------------------------------------------------------------


@router.post(
    "/{user_id}", status_code=status.HTTP_201_CREATED, summary="Отправить сообщение"
)
async def send_message(
    user_id: int,
    body: SendMessage,
    current_user: dict = Depends(get_current_user),
) -> dict:
    me: int = current_user["id"]

    content = (body.content or "").strip() or None
    media_id = body.media_id
    reply_to_id = body.reply_to_id

    if not content and not media_id:
        raise HTTPException(
            status_code=422,
            detail="Необходимо указать текст или прикрепить файл",
        )
    if me == user_id:
        raise HTTPException(status_code=400, detail="Нельзя написать самому себе")

    async with aiosqlite.connect(DB_PATH) as db:
        db.row_factory = aiosqlite.Row

        # Verify recipient
        async with db.execute(
            "SELECT id, is_banned, is_verified FROM users WHERE id = ?", (user_id,)
        ) as cur:
            recipient = await cur.fetchone()

        if recipient is None or not recipient["is_verified"]:
            raise HTTPException(status_code=404, detail="Получатель не найден")
        if recipient["is_banned"]:
            raise HTTPException(status_code=403, detail="Пользователь заблокирован")

        # Verify media ownership
        if media_id is not None:
            async with db.execute(
                "SELECT id FROM media WHERE id = ? AND uploader_id = ?", (media_id, me)
            ) as cur:
                if await cur.fetchone() is None:
                    raise HTTPException(status_code=400, detail="Медиафайл не найден")

        # Validate reply_to
        if reply_to_id is not None:
            async with db.execute(
                """SELECT id FROM messages
                   WHERE id = ?
                     AND ((from_user_id = ? AND to_user_id = ?)
                       OR (from_user_id = ? AND to_user_id = ?))""",
                (reply_to_id, me, user_id, user_id, me),
            ) as cur:
                if await cur.fetchone() is None:
                    reply_to_id = None  # silently ignore invalid reply

        # Insert
        async with db.execute(
            """INSERT INTO messages (from_user_id, to_user_id, content, media_id, reply_to_id)
               VALUES (?, ?, ?, ?, ?)""",
            (me, user_id, content, media_id, reply_to_id),
        ) as cur:
            new_id: int = cur.lastrowid  # type: ignore

        await db.commit()

        async with db.execute("SELECT * FROM messages WHERE id = ?", (new_id,)) as cur:
            new_row = await cur.fetchone()

        formatted = await _format_message(new_row, db)

    await manager.send_to_user(user_id, {"type": "new_message", "message": formatted})
    return formatted


# ---------------------------------------------------------------------------
# PUT /{message_id}
# ---------------------------------------------------------------------------


@router.put("/{message_id}", summary="Редактировать сообщение")
async def edit_message(
    message_id: int,
    body: EditMessage,
    current_user: dict = Depends(get_current_user),
) -> dict:
    me: int = current_user["id"]
    new_content = body.content.strip()

    if not new_content:
        raise HTTPException(status_code=422, detail="Текст не может быть пустым")

    async with aiosqlite.connect(DB_PATH) as db:
        db.row_factory = aiosqlite.Row

        async with db.execute(
            "SELECT * FROM messages WHERE id = ?", (message_id,)
        ) as cur:
            msg = await cur.fetchone()

        if msg is None:
            raise HTTPException(status_code=404, detail="Сообщение не найдено")
        if msg["from_user_id"] != me:
            raise HTTPException(
                status_code=403, detail="Нельзя редактировать чужое сообщение"
            )
        if msg["is_deleted"]:
            raise HTTPException(
                status_code=400, detail="Нельзя редактировать удалённое сообщение"
            )

        now = _now_utc()
        await db.execute(
            "UPDATE messages SET content = ?, edited_at = ? WHERE id = ?",
            (new_content, now, message_id),
        )
        await db.commit()

        async with db.execute(
            "SELECT * FROM messages WHERE id = ?", (message_id,)
        ) as cur:
            updated_row = await cur.fetchone()

        formatted = await _format_message(updated_row, db)

    await manager.send_to_user(
        msg["to_user_id"], {"type": "message_edited", "message": formatted}
    )
    return formatted


# ---------------------------------------------------------------------------
# DELETE /{message_id}
# ---------------------------------------------------------------------------


@router.delete("/{message_id}", summary="Удалить сообщение")
async def delete_message(
    message_id: int,
    for_all: bool = Query(
        False, description="True — удалить у всех; False — только у себя"
    ),
    current_user: dict = Depends(get_current_user),
) -> dict:
    """
    Delete a message.

    - ``for_all=false`` (default): soft-delete only for the requesting user.
      - Sender:   deleted_for_sender   = 1
      - Receiver: deleted_for_receiver = 1
    - ``for_all=true``: full soft-delete (is_deleted = 1).
      Only the original sender can delete for all.
    """
    me: int = current_user["id"]

    async with aiosqlite.connect(DB_PATH) as db:
        db.row_factory = aiosqlite.Row

        msg = await _get_message_or_403(db, message_id, me)

        if for_all:
            # Only sender can delete for everyone
            if msg["from_user_id"] != me:
                raise HTTPException(
                    status_code=403,
                    detail="Только отправитель может удалить сообщение у всех",
                )
            await db.execute(
                "UPDATE messages SET is_deleted = 1 WHERE id = ?", (message_id,)
            )
        else:
            # Delete only for the current user
            if msg["from_user_id"] == me:
                await db.execute(
                    "UPDATE messages SET deleted_for_sender = 1 WHERE id = ?",
                    (message_id,),
                )
            else:
                await db.execute(
                    "UPDATE messages SET deleted_for_receiver = 1 WHERE id = ?",
                    (message_id,),
                )

        await db.commit()

    # Notify via WebSocket
    other_id = msg["to_user_id"] if msg["from_user_id"] == me else msg["from_user_id"]
    if for_all:
        await manager.send_to_user(
            other_id,
            {"type": "message_deleted", "message_id": message_id, "for_all": True},
        )

    return {"message": "Удалено", "for_all": for_all}


@router.delete("/dialogs/{user_id}", summary="Удалить диалог целиком")
async def delete_conversation(
    user_id: int,
    current_user: dict = Depends(get_current_user),
) -> dict:
    """
    Hide the entire direct conversation for the current user.
    Messages are not removed globally; they are marked deleted for requester.
    """
    me = current_user["id"]
    if me == user_id:
        raise HTTPException(status_code=400, detail="Нельзя удалить чат с самим собой")

    async with aiosqlite.connect(DB_PATH) as db:
        # Mark messages where requester is sender
        cur1 = await db.execute(
            """
            UPDATE messages
            SET deleted_for_sender = 1
            WHERE from_user_id = ? AND to_user_id = ?
            """,
            (me, user_id),
        )
        # Mark messages where requester is receiver
        cur2 = await db.execute(
            """
            UPDATE messages
            SET deleted_for_receiver = 1
            WHERE from_user_id = ? AND to_user_id = ?
            """,
            (user_id, me),
        )
        await db.commit()
        updated = (cur1.rowcount or 0) + (cur2.rowcount or 0)

    return {"message": "Диалог удалён для вас", "affected_messages": updated}
