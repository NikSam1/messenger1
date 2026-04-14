"""
main.py
Messenger API entry point.

Responsibilities:
  - Load environment variables
  - Create uploads directories
  - Initialise the database via lifespan
  - Configure CORS, rate-limiting, and a global error handler
  - Mount static files for uploaded media
  - Register all routers
  - Expose a health-check endpoint
"""

import os
import traceback
from contextlib import asynccontextmanager

import aiosqlite
import uvicorn
from database import DB_PATH, init_db
from dotenv import load_dotenv
from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from fastapi.staticfiles import StaticFiles
from routers import admin as admin_router
from routers import auth, groups, media, messages, users, ws
from slowapi import Limiter, _rate_limit_exceeded_handler
from slowapi.errors import RateLimitExceeded
from slowapi.util import get_remote_address

# ---------------------------------------------------------------------------
# Environment
# ---------------------------------------------------------------------------

load_dotenv()

PORT: int = int(os.getenv("PORT", "8000"))
FRONTEND_URL: str = os.getenv("FRONTEND_URL", "*")

# Resolved once at import time so every part of the app uses the same path
UPLOADS_DIR: str = os.path.join(os.path.dirname(os.path.abspath(__file__)), "uploads")
AVATARS_DIR: str = os.path.join(UPLOADS_DIR, "avatars")


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _build_origins(url: str) -> list[str]:
    """
    Expand a single FRONTEND_URL into both localhost and 127.0.0.1 variants
    so that developers can open the app through either address without hitting
    CORS errors.
    """
    if url == "*":
        return ["*"]
    origins: set[str] = {url}
    if "localhost" in url:
        origins.add(url.replace("localhost", "127.0.0.1"))
    elif "127.0.0.1" in url:
        origins.add(url.replace("127.0.0.1", "localhost"))
    return list(origins)


# ---------------------------------------------------------------------------
# Rate limiter
# ---------------------------------------------------------------------------

limiter = Limiter(key_func=get_remote_address, default_limits=["300/minute"])


# ---------------------------------------------------------------------------
# Lifespan
# ---------------------------------------------------------------------------


@asynccontextmanager
async def lifespan(app: FastAPI):
    """
    Async context manager executed once on startup (before ``yield``) and
    once on shutdown (after ``yield``).

    Startup tasks:
      1. Create uploads directories.
      2. Initialise all database tables and run migrations.
      3. Promote the ADMIN_EMAIL user to admin if the env var is set.
    """
    # ── Directories ────────────────────────────────────────────────────────
    os.makedirs(UPLOADS_DIR, exist_ok=True)
    os.makedirs(AVATARS_DIR, exist_ok=True)

    # ── Database ───────────────────────────────────────────────────────────
    await init_db()

    # ── Optional: promote a hard-coded admin by email ─────────────────────
    admin_email: str | None = os.getenv("ADMIN_EMAIL")
    if admin_email:
        async with aiosqlite.connect(DB_PATH) as db:
            await db.execute(
                "UPDATE users SET is_admin = 1 WHERE email = ?",
                (admin_email,),
            )
            await db.commit()

    print(f"✅  Messenger API на http://localhost:{PORT}")
    print(f"   Docs  : http://localhost:{PORT}/api/docs")
    print(f"   CORS  : {FRONTEND_URL}")

    yield  # ── Application runs here ──────────────────────────────────────

    # Shutdown — nothing to tear down for SQLite / in-process state


# ---------------------------------------------------------------------------
# Application
# ---------------------------------------------------------------------------

app = FastAPI(
    title="Messenger API",
    version="2.0.0",
    docs_url="/api/docs",
    redoc_url="/api/redoc",
    openapi_url="/api/openapi.json",
    lifespan=lifespan,
)

# ── Rate limiter ───────────────────────────────────────────────────────────
app.state.limiter = limiter
app.add_exception_handler(RateLimitExceeded, _rate_limit_exceeded_handler)

# ── CORS ───────────────────────────────────────────────────────────────────
app.add_middleware(
    CORSMiddleware,
    allow_origins=_build_origins(FRONTEND_URL),
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


# ---------------------------------------------------------------------------
# Global exception handler
# ---------------------------------------------------------------------------


@app.exception_handler(Exception)
async def global_exception_handler(request: Request, exc: Exception) -> JSONResponse:
    """
    Catch-all handler that prevents raw Python tracebacks from leaking to
    clients.  The full traceback is still printed to stdout for server logs.
    """
    traceback.print_exc()
    return JSONResponse(
        status_code=500,
        content={"error": "Внутренняя ошибка сервера"},
    )


# ---------------------------------------------------------------------------
# Static files  (mount BEFORE the health-check so /uploads/* is served)
# ---------------------------------------------------------------------------

# The directory is guaranteed to exist by the time the app starts (lifespan),
# but we also call makedirs here so the mount doesn't fail if somehow the
# lifespan hasn't run yet (e.g. during testing with TestClient).
os.makedirs(UPLOADS_DIR, exist_ok=True)
app.mount("/uploads", StaticFiles(directory=UPLOADS_DIR), name="uploads")


# ---------------------------------------------------------------------------
# Routers
# ---------------------------------------------------------------------------

# Auth — prefix applied here so the router itself stays prefix-free
app.include_router(auth.router, prefix="/api/auth", tags=["auth"])

# The remaining routers declare their own prefix internally
app.include_router(users.router, tags=["users"])
app.include_router(messages.router, tags=["messages"])
app.include_router(groups.router, tags=["groups"])
app.include_router(media.router, tags=["media"])
app.include_router(admin_router.router, tags=["admin"])

# WebSocket — no HTTP prefix needed; it registers /ws directly
app.include_router(ws.router, tags=["ws"])


# ---------------------------------------------------------------------------
# Health-check
# ---------------------------------------------------------------------------


@app.get("/", tags=["health"], summary="Проверка работоспособности")
async def health_check() -> dict:
    """Returns a minimal status payload to confirm the API is reachable."""
    return {"status": "ok", "app": "Messenger API v2"}


# ---------------------------------------------------------------------------
# Dev entry-point
# ---------------------------------------------------------------------------

if __name__ == "__main__":
    uvicorn.run(
        "main:app",
        host="0.0.0.0",
        port=PORT,
        reload=True,
        log_level="info",
    )
