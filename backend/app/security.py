from datetime import datetime, timedelta, timezone

import jwt
from argon2 import PasswordHasher
from argon2.exceptions import InvalidHashError, VerifyMismatchError

from .config import settings

_hasher = PasswordHasher()
ALGO = "HS256"
COOKIE_NAME = "tc_session"


def hash_password(password: str) -> str:
    return _hasher.hash(password)


# Checked when the email is unknown, so a wrong email takes as long as a wrong password.
_DUMMY_HASH = _hasher.hash("not-a-real-password")


def burn_time(password: str) -> None:
    verify_password(password, _DUMMY_HASH)


def verify_password(password: str, password_hash: str) -> bool:
    try:
        return _hasher.verify(password_hash, password)
    except (VerifyMismatchError, InvalidHashError):
        return False


def create_session_token(user_id: str, version: int = 0) -> str:
    exp = datetime.now(timezone.utc) + timedelta(days=settings.session_days)
    return jwt.encode({"sub": user_id, "v": version, "exp": exp}, settings.secret_key, algorithm=ALGO)


def decode_session_token(token: str) -> tuple[str, int] | None:
    """(user id, session version) of a valid token."""
    try:
        data = jwt.decode(token, settings.secret_key, algorithms=[ALGO])
    except jwt.PyJWTError:
        return None
    return (data["sub"], int(data.get("v", 0))) if data.get("sub") else None
