"""
routers/media.py
File upload endpoint for messages (images, videos, documents).
"""

import os
import uuid

import aiofiles
import aiosqlite
from database import DB_PATH
from dependencies import get_current_user
from fastapi import APIRouter, Depends, File, HTTPException, UploadFile, status

router = APIRouter(prefix="/api/media", tags=["media"])

# ---------------------------------------------------------------------------
# File-system paths
# ---------------------------------------------------------------------------

# Resolve: routers/ → backend/ → uploads/
UPLOADS_DIR = os.path.join(os.path.dirname(os.path.dirname(__file__)), "uploads")

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

ALLOWED_MIME_TYPES: set[str] = {
    # Images
    "image/jpeg",
    "image/png",
    "image/gif",
    "image/webp",
    # Videos
    "video/mp4",
    "video/webm",
    # Audio (voice messages)
    "audio/webm",
    "audio/ogg",
    "audio/mpeg",
    "audio/wav",
    "audio/x-wav",
    "audio/mp4",
    "audio/aac",
    # Documents
    "application/pdf",
    "text/plain",
    "application/zip",
    "application/msword",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
}

# Extension map: MIME type → canonical extension
_MIME_TO_EXT: dict[str, str] = {
    "image/jpeg": ".jpg",
    "image/png": ".png",
    "image/gif": ".gif",
    "image/webp": ".webp",
    "video/mp4": ".mp4",
    "video/webm": ".webm",
    "audio/webm": ".webm",
    "audio/ogg": ".ogg",
    "audio/mpeg": ".mp3",
    "audio/wav": ".wav",
    "audio/x-wav": ".wav",
    "audio/mp4": ".m4a",
    "audio/aac": ".aac",
    "application/pdf": ".pdf",
    "text/plain": ".txt",
    "application/zip": ".zip",
    "application/msword": ".doc",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document": ".docx",
}

MAX_SIZE: int = 50 * 1024 * 1024  # 50 MB


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _get_extension(filename: str | None, mime_type: str) -> str:
    """
    Determine the file extension to use for the stored file.

    Preference order:
    1. Extension inferred from the client-supplied original filename
       (only if it is a known safe extension).
    2. Canonical extension from the MIME-type map.
    3. Empty string as a last resort.
    """
    _safe_exts = {
        ".jpg",
        ".jpeg",
        ".png",
        ".gif",
        ".webp",
        ".mp4",
        ".webm",
        ".ogg",
        ".mp3",
        ".wav",
        ".m4a",
        ".aac",
        ".pdf",
        ".txt",
        ".zip",
        ".doc",
        ".docx",
    }

    if filename:
        _, ext = os.path.splitext(filename)
        ext = ext.lower()
        if ext in _safe_exts:
            # Normalise .jpeg → .jpg
            return ".jpg" if ext == ".jpeg" else ext

    return _MIME_TO_EXT.get(mime_type, "")


# ---------------------------------------------------------------------------
# POST /upload
# ---------------------------------------------------------------------------


@router.post(
    "/upload",
    status_code=status.HTTP_201_CREATED,
    summary="Загрузить медиафайл",
)
async def upload_media(
    file: UploadFile = File(...),
    current_user: dict = Depends(get_current_user),
) -> dict:
    """
    Upload a file to be attached to a chat message.

    Validation:
    - ``content_type`` must be in the ALLOWED_MIME_TYPES set → 400
    - File body must not exceed 50 MB                        → 413

    On success the file is saved under ``uploads/<uuid><ext>`` and a row is
    inserted in the ``media`` table.  Returns:

    ```json
    {
      "id":   1,
      "url":  "/uploads/abc123.jpg",
      "type": "image/jpeg",
      "name": "photo.jpg",
      "size": 12345
    }
    ```
    """
    # ── MIME-type check ────────────────────────────────────────────────────
    content_type: str = (file.content_type or "").lower().split(";")[0].strip()

    if content_type not in ALLOWED_MIME_TYPES:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=(
                f"Тип файла «{content_type}» не поддерживается. "
                "Разрешены: изображения (JPEG/PNG/GIF/WebP), "
                "видео (MP4/WebM), PDF, TXT, ZIP, DOC, DOCX."
            ),
        )

    # ── Read file into memory ──────────────────────────────────────────────
    contents: bytes = await file.read()

    # ── Size check ─────────────────────────────────────────────────────────
    if len(contents) > MAX_SIZE:
        raise HTTPException(
            status_code=status.HTTP_413_REQUEST_ENTITY_TOO_LARGE,
            detail="Файл превышает максимально допустимый размер 50 МБ",
        )

    if len(contents) == 0:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Загружен пустой файл",
        )

    # ── Generate unique stored filename ───────────────────────────────────
    original_name: str = file.filename or "file"
    ext: str = _get_extension(original_name, content_type)
    stored_filename: str = f"{uuid.uuid4().hex}{ext}"

    # ── Ensure uploads directory exists ───────────────────────────────────
    os.makedirs(UPLOADS_DIR, exist_ok=True)
    dest_path: str = os.path.join(UPLOADS_DIR, stored_filename)

    # ── Write to disk asynchronously ──────────────────────────────────────
    try:
        async with aiofiles.open(dest_path, "wb") as fh:
            await fh.write(contents)
    except OSError as exc:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Не удалось сохранить файл на сервере",
        ) from exc

    # ── Insert media record into DB ────────────────────────────────────────
    try:
        async with aiosqlite.connect(DB_PATH) as db:
            db.row_factory = aiosqlite.Row
            async with db.execute(
                """
                INSERT INTO media (uploader_id, filename, original_name, mime_type, size)
                VALUES (?, ?, ?, ?, ?)
                """,
                (
                    current_user["id"],
                    stored_filename,
                    original_name,
                    content_type,
                    len(contents),
                ),
            ) as cur:
                media_id: int = cur.lastrowid  # type: ignore[assignment]

            await db.commit()
    except Exception as exc:
        # Roll back the on-disk file so we don't leak orphaned files
        try:
            os.unlink(dest_path)
        except OSError:
            pass
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Не удалось сохранить информацию о файле",
        ) from exc

    return {
        "id": media_id,
        "url": f"/uploads/{stored_filename}",
        "type": content_type,
        "name": original_name,
        "size": len(contents),
    }
