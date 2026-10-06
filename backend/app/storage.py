"""Uploaded files (receipt photos). On disk under `settings.upload_dir` for now.

Railway's disk is wiped on every deploy, so before launch this must move to object storage
(S3 / R2): keep the same three functions and only their bodies change.

Keys are generated here ("<workspace>/<uuid>.<ext>"), never taken from a request, so a key can't
point outside the folder.
"""
import re
import uuid
from pathlib import Path

from .config import settings

MAX_IMAGE = 6 * 1024 * 1024
_KEY = re.compile(r"^[0-9a-f-]{36}/[0-9a-f]{32}\.(jpg|png|webp)$")
_TYPES = {"jpg": "image/jpeg", "png": "image/png", "webp": "image/webp"}


def image_kind(data: bytes) -> str | None:
    """jpg | png | webp from the file's first bytes (not its name or the browser's word)."""
    if data[:3] == b"\xff\xd8\xff":
        return "jpg"
    if data[:8] == b"\x89PNG\r\n\x1a\n":
        return "png"
    if data[:4] == b"RIFF" and data[8:12] == b"WEBP":
        return "webp"
    return None


def save_image(workspace_id: str, data: bytes) -> str:
    kind = image_kind(data)
    if kind is None or len(data) > MAX_IMAGE:
        raise ValueError("A photo (JPEG, PNG or WebP) of at most 6 MB")
    key = f"{workspace_id}/{uuid.uuid4().hex}.{kind}"
    path = Path(settings.upload_dir) / key
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(data)
    return key


def open_image(key: str) -> tuple[Path, str] | None:
    if not _KEY.match(key or ""):
        return None
    path = Path(settings.upload_dir) / key
    return (path, _TYPES[key.rsplit(".", 1)[1]]) if path.is_file() else None


def delete(key: str | None) -> None:
    if key and _KEY.match(key):
        (Path(settings.upload_dir) / key).unlink(missing_ok=True)
