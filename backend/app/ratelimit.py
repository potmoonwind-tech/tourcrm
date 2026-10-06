"""Small in-memory rate limits (one process): login guessing, mass sign-ups, map lookups.

Each limit counts events per key in a sliding window. With several server processes each
counts on its own, which still caps abuse; a shared store can replace this later.
"""
import threading
import time
from collections import defaultdict, deque

from fastapi import HTTPException, Request, status

_lock = threading.Lock()
_events: dict[tuple[str, str], deque] = defaultdict(deque)


def client_ip(request: Request) -> str:
    # Behind a proxy (Railway) the first X-Forwarded-For address is the visitor.
    fwd = request.headers.get("x-forwarded-for", "")
    return fwd.split(",")[0].strip() or (request.client.host if request.client else "?")


def hit(bucket: str, key: str, limit: int, per_seconds: int, count: bool = True) -> None:
    """Raise 429 when `key` already had `limit` events in the window; else (optionally) count one."""
    now = time.monotonic()
    with _lock:
        q = _events[(bucket, key)]
        while q and now - q[0] > per_seconds:
            q.popleft()
        if len(q) >= limit:
            wait = int(per_seconds - (now - q[0])) + 1
            raise HTTPException(status.HTTP_429_TOO_MANY_REQUESTS, f"Too many attempts — try again in {wait} seconds",
                                headers={"Retry-After": str(wait)})
        if count:
            q.append(now)


def add(bucket: str, key: str) -> None:
    with _lock:
        _events[(bucket, key)].append(time.monotonic())


def reset() -> None:
    """Tests start clean."""
    with _lock:
        _events.clear()
