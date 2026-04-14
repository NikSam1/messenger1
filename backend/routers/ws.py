"""
routers/ws.py
WebSocket connection manager for real-time messaging.
"""

import asyncio
import json
from typing import Dict

import aiosqlite
import jwt
from database import DB_PATH
from fastapi import APIRouter, Query, WebSocket, WebSocketDisconnect
from services.jwt_service import decode_token

router = APIRouter()

_DISCONNECT_GRACE_PERIOD: float = 2.0


class ConnectionManager:
    """Manages active WebSocket connections keyed by user_id."""

    def __init__(self):
        self.active: Dict[int, WebSocket] = {}

    async def connect(self, user_id: int, websocket: WebSocket):
        await websocket.accept()
        self.active[user_id] = websocket

    def disconnect(self, user_id: int):
        self.active.pop(user_id, None)

    async def send_to_user(self, user_id: int, data: dict):
        ws = self.active.get(user_id)
        if ws:
            try:
                await ws.send_json(data)
            except Exception:
                self.disconnect(user_id)

    def is_online(self, user_id: int) -> bool:
        return user_id in self.active

    def online_user_ids(self) -> list[int]:
        return list(self.active.keys())


# Singleton used across the app
manager = ConnectionManager()


@router.websocket("/ws")
async def websocket_endpoint(
    websocket: WebSocket,
    token: str = Query(...),
) -> None:
    """
    WebSocket endpoint. Client connects with ?token=<jwt>

    Client → Server messages:
      {"type": "ping"}
      {"type": "typing", "to_user_id": int}
      {"type": "read", "message_id": int}

    Server → Client messages:
      {"type": "pong"}
      {"type": "new_message", "message": {...}}
      {"type": "message_edited", "message": {...}}
      {"type": "message_deleted", "message_id": int}
      {"type": "typing", "from_user_id": int}
      {"type": "read", "message_id": int}
      {"type": "user_online", "user_id": int}
      {"type": "user_offline", "user_id": int}
    """
    # ── Authenticate ───────────────────────────────────────────────────────
    user_id = None
    try:
        payload = decode_token(token)
        user_id = int(payload["sub"])
    except (jwt.PyJWTError, KeyError, ValueError, Exception):
        await websocket.close(code=4001, reason="Unauthorized")
        return

    await manager.connect(user_id, websocket)

    # Notify every currently online user that this user just came online
    for uid in manager.online_user_ids():
        if uid != user_id:
            await manager.send_to_user(uid, {"type": "user_online", "user_id": user_id})

    # Update last_seen immediately on connect
    async with aiosqlite.connect(DB_PATH) as db:
        from datetime import datetime, timezone

        now = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M:%S")
        await db.execute(
            "UPDATE users SET last_seen = ? WHERE id = ?",
            (now, user_id),
        )
        await db.commit()

    try:
        while True:
            # Wait up to 30 s for a client message; send a keepalive ping on
            # timeout so idle connections are maintained and last_seen is fresh.
            try:
                data = await asyncio.wait_for(websocket.receive_json(), timeout=30.0)
            except asyncio.TimeoutError:
                await websocket.send_json({"type": "ping"})
                async with aiosqlite.connect(DB_PATH) as db:
                    from datetime import datetime, timezone

                    now = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M:%S")
                    await db.execute(
                        "UPDATE users SET last_seen = ? WHERE id = ?",
                        (now, user_id),
                    )
                    await db.commit()
                continue

            msg_type = data.get("type")

            # ── ping ───────────────────────────────────────────────────────
            if msg_type == "ping":
                await websocket.send_json({"type": "pong"})

            # ── typing indicator ───────────────────────────────────────────
            elif msg_type == "typing":
                to_id = data.get("to_user_id")
                if isinstance(to_id, int):
                    await manager.send_to_user(
                        to_id,
                        {
                            "type": "typing",
                            "from_user_id": user_id,
                        },
                    )

            # ── read receipt ───────────────────────────────────────────────
            elif msg_type == "read":
                message_id = data.get("message_id")
                if isinstance(message_id, int):
                    async with aiosqlite.connect(DB_PATH) as db:
                        db.row_factory = aiosqlite.Row
                        # Only the intended recipient may mark the message read
                        async with db.execute(
                            "SELECT from_user_id FROM messages "
                            "WHERE id = ? AND to_user_id = ?",
                            (message_id, user_id),
                        ) as cur:
                            msg = await cur.fetchone()

                        if msg:
                            await db.execute(
                                "UPDATE messages SET is_read = 1 WHERE id = ?",
                                (message_id,),
                            )
                            await db.commit()
                            # Notify the original sender their message was read
                            await manager.send_to_user(
                                msg["from_user_id"],
                                {"type": "read", "message_id": message_id},
                            )

            # ── update last_seen on every incoming message ─────────────────
            async with aiosqlite.connect(DB_PATH) as db:
                from datetime import datetime, timezone

                now = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M:%S")
                await db.execute(
                    "UPDATE users SET last_seen = ? WHERE id = ?",
                    (now, user_id),
                )
                await db.commit()

    except WebSocketDisconnect:
        pass
    except Exception:
        pass
    finally:
        manager.disconnect(user_id)
        await asyncio.sleep(_DISCONNECT_GRACE_PERIOD)
        if not manager.is_online(user_id):
            for uid in manager.online_user_ids():
                await manager.send_to_user(
                    uid, {"type": "user_offline", "user_id": user_id}
                )
