"""Uploaded files go to the bucket when one is set (a server), else to disk (local, tests)."""
import io

import pytest

from app import storage
from app.config import settings

JPEG = b"\xff\xd8\xff\xe0" + b"\x00" * 100


class FakeBucket:
    """The three calls storage makes, kept in a dict."""
    class exceptions:
        class NoSuchKey(Exception):
            pass

    def __init__(self):
        self.files: dict[str, tuple[bytes, str]] = {}

    def put_object(self, Bucket, Key, Body, ContentType):
        self.files[f"{Bucket}/{Key}"] = (Body, ContentType)

    def get_object(self, Bucket, Key):
        if f"{Bucket}/{Key}" not in self.files:
            raise self.exceptions.NoSuchKey()
        return {"Body": io.BytesIO(self.files[f"{Bucket}/{Key}"][0])}

    def delete_object(self, Bucket, Key):
        self.files.pop(f"{Bucket}/{Key}", None)


@pytest.fixture
def bucket(monkeypatch):
    fake = FakeBucket()
    monkeypatch.setattr(settings, "s3_bucket", "tourcrm-files")
    monkeypatch.setattr(storage, "_bucket", lambda: fake)
    return fake


def test_a_photo_in_the_bucket(bucket):
    ws = "11111111-2222-3333-4444-555555555555"
    key = storage.save_image(ws, JPEG)
    assert list(bucket.files) == [f"tourcrm-files/uploads/{key}"] and bucket.files[f"tourcrm-files/uploads/{key}"][1] == "image/jpeg"
    assert storage.read_image(key) == (JPEG, "image/jpeg")
    storage.delete(key)
    assert storage.read_image(key) is None and not bucket.files


def test_no_key_from_outside(bucket):
    assert storage.read_image("../../etc/passwd") is None
    with pytest.raises(ValueError):
        storage.save_image("11111111-2222-3333-4444-555555555555", b"not an image")
