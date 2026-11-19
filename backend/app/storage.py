"""Uploaded files (receipt photos, photos of places): in an S3-compatible bucket when one is set
(S3_BUCKET - a Lightsail or S3 bucket, its access keys in the usual AWS_ACCESS_KEY_ID /
AWS_SECRET_ACCESS_KEY), else on disk under `settings.upload_dir` (local development, tests).
A container's own disk is wiped on every deploy, so a server keeps its files in the bucket.

Keys are generated here ("<workspace>/<uuid>.<ext>"), never taken from a request, so a key can't
point outside the folder (or the bucket's prefix).
"""
import re
import uuid
from functools import lru_cache
from pathlib import Path

from .config import settings

MAX_IMAGE = 6 * 1024 * 1024
_KEY = re.compile(r"^[0-9a-f-]{36}/[0-9a-f]{32}\.(jpg|png|webp)$")
_TYPES = {"jpg": "image/jpeg", "png": "image/png", "webp": "image/webp"}
PREFIX = "uploads/"


def image_kind(data: bytes) -> str | None:
    """jpg | png | webp from the file's first bytes (not its name or the browser's word)."""
    if data[:3] == b"\xff\xd8\xff":
        return "jpg"
    if data[:8] == b"\x89PNG\r\n\x1a\n":
        return "png"
    if data[:4] == b"RIFF" and data[8:12] == b"WEBP":
        return "webp"
    return None


@lru_cache(maxsize=1)
def _bucket():
    """The bucket's client, or None (files on disk)."""
    if not settings.s3_bucket:
        return None
    import boto3                     # only where a bucket is used
    return boto3.client("s3", region_name=settings.s3_region or None, endpoint_url=settings.s3_endpoint or None)


def save_image(workspace_id: str, data: bytes) -> str:
    kind = image_kind(data)
    if kind is None or len(data) > MAX_IMAGE:
        raise ValueError("A photo (JPEG, PNG or WebP) of at most 6 MB")
    key = f"{workspace_id}/{uuid.uuid4().hex}.{kind}"
    if (b := _bucket()) is not None:
        b.put_object(Bucket=settings.s3_bucket, Key=PREFIX + key, Body=data, ContentType=_TYPES[kind])
    else:
        path = Path(settings.upload_dir) / key
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(data)
    return key


def read_image(key: str) -> tuple[bytes, str] | None:
    """The file and its type, or None (no such file)."""
    if not _KEY.match(key or ""):
        return None
    media = _TYPES[key.rsplit(".", 1)[1]]
    if (b := _bucket()) is not None:
        try:
            return b.get_object(Bucket=settings.s3_bucket, Key=PREFIX + key)["Body"].read(), media
        except b.exceptions.NoSuchKey:
            return None
    path = Path(settings.upload_dir) / key
    return (path.read_bytes(), media) if path.is_file() else None


def delete(key: str | None) -> None:
    if not (key and _KEY.match(key)):
        return
    if (b := _bucket()) is not None:
        b.delete_object(Bucket=settings.s3_bucket, Key=PREFIX + key)
    else:
        (Path(settings.upload_dir) / key).unlink(missing_ok=True)
