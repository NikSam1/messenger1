"""
database.py
Async SQLite database module using aiosqlite.

Responsibilities:
  - Expose DB_PATH: the resolved path to database.db
  - init_db(): idempotent startup coroutine that:
      1. Enables WAL journal mode
      2. Creates all required tables (IF NOT EXISTS)
      3. Runs ALTER TABLE migrations for new columns on existing users table
      4. Back-fills tag = username where tag IS NULL
      5. Creates all required indexes
"""

import os

import aiosqlite

# ---------------------------------------------------------------------------
# DB_PATH — always next to this file, regardless of the working directory
# ---------------------------------------------------------------------------

DB_PATH: str = os.path.join(os.path.dirname(os.path.abspath(__file__)), "database.db")


# ---------------------------------------------------------------------------
# init_db
# ---------------------------------------------------------------------------


async def init_db() -> None:
    """
    Initialise the SQLite database.

    Safe to call multiple times — every DDL statement is guarded with
    IF NOT EXISTS (or a try/except for ALTER TABLE which SQLite doesn't
    support conditional column adds for).
    """
    async with aiosqlite.connect(DB_PATH) as db:
        # ── Pragmas ────────────────────────────────────────────────────────
        # WAL mode: allows concurrent readers while a writer is active.
        await db.execute("PRAGMA journal_mode=WAL")
        # Enforce FK constraints (off by default in SQLite).
        await db.execute("PRAGMA foreign_keys=ON")

        # ── users ──────────────────────────────────────────────────────────
        #
        #  id            – auto PK
        #  username      – display name (not necessarily unique in new schema,
        #                  uniqueness is enforced through `tag` instead)
        #  tag           – searchable @handle; UNIQUE, e.g. "ivan_99"
        #  email         – unique contact address
        #  password_hash – bcrypt hash
        #  bio           – short user biography (max 200 chars by convention)
        #  avatar        – filename inside uploads/avatars/
        #  is_verified   – 0 = email not confirmed, 1 = confirmed
        #  is_admin      – 0 = regular user, 1 = admin
        #  is_banned     – 0 = active, 1 = banned
        #  last_seen     – UTC timestamp string, updated on login / activity
        #  created_at    – UTC timestamp, set automatically on INSERT
        await db.execute(
            """
            CREATE TABLE IF NOT EXISTS users (
                id            INTEGER PRIMARY KEY AUTOINCREMENT,
                username      TEXT    NOT NULL,
                tag           TEXT    UNIQUE,
                email         TEXT    UNIQUE NOT NULL,
                password_hash TEXT    NOT NULL,
                bio           TEXT    NOT NULL DEFAULT '',
                avatar        TEXT    NOT NULL DEFAULT '',
                is_verified   INTEGER NOT NULL DEFAULT 0,
                is_admin      INTEGER NOT NULL DEFAULT 0,
                is_banned     INTEGER NOT NULL DEFAULT 0,
                last_seen     TEXT,
                created_at    TEXT    NOT NULL DEFAULT (datetime('now'))
            )
            """
        )

        # ── verification_codes ─────────────────────────────────────────────
        #
        #  email      – the address the code was sent to
        #  code       – 6-digit numeric string
        #  expires_at – UTC timestamp; code is invalid after this moment
        #  created_at – used for resend-cooldown calculations
        await db.execute(
            """
            CREATE TABLE IF NOT EXISTS verification_codes (
                id         INTEGER PRIMARY KEY AUTOINCREMENT,
                email      TEXT NOT NULL,
                code       TEXT NOT NULL,
                expires_at TEXT NOT NULL,
                created_at TEXT NOT NULL DEFAULT (datetime('now'))
            )
            """
        )

        # ── media ──────────────────────────────────────────────────────────
        # Must be declared BEFORE messages because messages has a FK → media.
        #
        #  uploader_id   – who uploaded the file (cascade-deleted with user)
        #  filename      – UUID-based stored filename (server-side)
        #  original_name – original filename from the client
        #  mime_type     – e.g. "image/jpeg", "video/mp4"
        #  size          – file size in bytes
        await db.execute(
            """
            CREATE TABLE IF NOT EXISTS media (
                id            INTEGER PRIMARY KEY AUTOINCREMENT,
                uploader_id   INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                filename      TEXT    NOT NULL,
                original_name TEXT    NOT NULL,
                mime_type     TEXT    NOT NULL,
                size          INTEGER NOT NULL,
                created_at    TEXT    NOT NULL DEFAULT (datetime('now'))
            )
            """
        )

        # ── messages ───────────────────────────────────────────────────────
        #
        #  from_user_id – sender   (cascade-deleted with user)
        #  to_user_id   – receiver (cascade-deleted with user)
        #  content      – text body (may be NULL if message is media-only)
        #  media_id     – optional attached file (SET NULL on media delete)
        #  is_read      – 0 = unread, 1 = read
        #  is_deleted   – soft-delete flag
        #  edited_at    – UTC timestamp of last edit, NULL if never edited
        await db.execute(
            """
            CREATE TABLE IF NOT EXISTS messages (
                id           INTEGER PRIMARY KEY AUTOINCREMENT,
                from_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                to_user_id   INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                content      TEXT,
                media_id     INTEGER REFERENCES media(id) ON DELETE SET NULL,
                is_read      INTEGER NOT NULL DEFAULT 0,
                is_deleted   INTEGER NOT NULL DEFAULT 0,
                edited_at    TEXT,
                created_at   TEXT NOT NULL DEFAULT (datetime('now'))
            )
            """
        )

        await db.commit()

        # ── group_chats / group_members / group_messages ──────────────────
        await db.execute(
            """
            CREATE TABLE IF NOT EXISTS group_chats (
                id          INTEGER PRIMARY KEY AUTOINCREMENT,
                title       TEXT    NOT NULL,
                avatar      TEXT    NOT NULL DEFAULT '',
                owner_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                created_at  TEXT    NOT NULL DEFAULT (datetime('now'))
            )
            """
        )
        await db.execute(
            """
            CREATE TABLE IF NOT EXISTS group_members (
                id          INTEGER PRIMARY KEY AUTOINCREMENT,
                group_id    INTEGER NOT NULL REFERENCES group_chats(id) ON DELETE CASCADE,
                user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                role        TEXT    NOT NULL DEFAULT 'member',
                joined_at   TEXT    NOT NULL DEFAULT (datetime('now')),
                UNIQUE(group_id, user_id)
            )
            """
        )
        await db.execute(
            """
            CREATE TABLE IF NOT EXISTS group_messages (
                id           INTEGER PRIMARY KEY AUTOINCREMENT,
                group_id     INTEGER NOT NULL REFERENCES group_chats(id) ON DELETE CASCADE,
                from_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                content      TEXT,
                media_id     INTEGER REFERENCES media(id) ON DELETE SET NULL,
                is_deleted   INTEGER NOT NULL DEFAULT 0,
                edited_at    TEXT,
                created_at   TEXT NOT NULL DEFAULT (datetime('now'))
            )
            """
        )
        await db.execute(
            """
            CREATE TABLE IF NOT EXISTS group_invite_links (
                id         INTEGER PRIMARY KEY AUTOINCREMENT,
                group_id   INTEGER NOT NULL REFERENCES group_chats(id) ON DELETE CASCADE,
                code       TEXT    NOT NULL UNIQUE,
                created_by INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                expires_at TEXT,
                max_uses   INTEGER,
                used_count INTEGER NOT NULL DEFAULT 0,
                is_active  INTEGER NOT NULL DEFAULT 1,
                created_at TEXT    NOT NULL DEFAULT (datetime('now'))
            )
            """
        )
        await db.commit()

        # ── ALTER TABLE migrations ─────────────────────────────────────────
        # SQLite does not support  ALTER TABLE … ADD COLUMN IF NOT EXISTS.
        # We attempt each statement individually and silently ignore the
        # "duplicate column name" OperationalError that fires when the
        # column already exists (i.e. when running against an up-to-date DB).
        _column_migrations = [
            "ALTER TABLE users ADD COLUMN tag      TEXT",
            "ALTER TABLE users ADD COLUMN bio      TEXT    NOT NULL DEFAULT ''",
            "ALTER TABLE users ADD COLUMN avatar   TEXT    NOT NULL DEFAULT ''",
            "ALTER TABLE users ADD COLUMN is_admin  INTEGER NOT NULL DEFAULT 0",
            "ALTER TABLE users ADD COLUMN is_banned INTEGER NOT NULL DEFAULT 0",
            "ALTER TABLE users ADD COLUMN last_seen TEXT",
            "ALTER TABLE users ADD COLUMN share_token TEXT",
            "ALTER TABLE group_invite_links ADD COLUMN max_uses   INTEGER",
            "ALTER TABLE group_invite_links ADD COLUMN used_count INTEGER NOT NULL DEFAULT 0",
        ]
        for stmt in _column_migrations:
            try:
                await db.execute(stmt)
                await db.commit()
            except Exception:
                # Column already present — nothing to do.
                pass

        # New message columns
        for col_sql in [
            "ALTER TABLE messages ADD COLUMN reply_to_id INTEGER",
            "ALTER TABLE messages ADD COLUMN deleted_for_sender INTEGER NOT NULL DEFAULT 0",
            "ALTER TABLE messages ADD COLUMN deleted_for_receiver INTEGER NOT NULL DEFAULT 0",
        ]:
            try:
                await db.execute(col_sql)
                await db.commit()
            except Exception:
                pass

        # ── Back-fill: set tag = username where tag is still NULL ──────────
        # This covers existing rows that predate the tag column.
        await db.execute("UPDATE users SET tag = username WHERE tag IS NULL")
        await db.commit()

        # ── Indexes ────────────────────────────────────────────────────────

        # Unique index on tag (the searchable @handle).
        await db.execute(
            "CREATE UNIQUE INDEX IF NOT EXISTS idx_users_tag ON users(tag)"
        )

        # Performance indexes for the messages table.
        await db.execute(
            "CREATE INDEX IF NOT EXISTS idx_messages_from ON messages(from_user_id)"
        )
        await db.execute(
            "CREATE INDEX IF NOT EXISTS idx_messages_to ON messages(to_user_id)"
        )
        await db.execute(
            "CREATE INDEX IF NOT EXISTS idx_messages_created ON messages(created_at)"
        )
        await db.execute(
            "CREATE INDEX IF NOT EXISTS idx_group_members_group ON group_members(group_id)"
        )
        await db.execute(
            "CREATE INDEX IF NOT EXISTS idx_group_members_user ON group_members(user_id)"
        )
        await db.execute(
            "CREATE INDEX IF NOT EXISTS idx_group_messages_group ON group_messages(group_id)"
        )
        await db.execute(
            "CREATE INDEX IF NOT EXISTS idx_group_messages_created ON group_messages(created_at)"
        )

        await db.commit()
