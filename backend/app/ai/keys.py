"""An agency's own Anthropic API key, typed in Settings.

Stored encrypted with a key derived from SECRET_KEY, never sent back to the browser (only its
last 4 characters, to recognise it). If SECRET_KEY changes, saved keys can't be read any more:
the agency is asked to enter its key again. Without an agency key, the server's key is used.
"""
import base64
import hashlib

from cryptography.fernet import Fernet, InvalidToken

from ..config import settings
from ..models import Workspace


def _box() -> Fernet:
    raw = hashlib.sha256(f"tourcrm-ai-key:{settings.secret_key}".encode()).digest()
    return Fernet(base64.urlsafe_b64encode(raw))


def seal(key: str) -> str:
    return _box().encrypt(key.encode()).decode()


def agency_key(ws: Workspace) -> str | None:
    if not ws.ai_key_enc:
        return None
    try:
        return _box().decrypt(ws.ai_key_enc.encode()).decode()
    except InvalidToken:
        return None


def key_for(ws: Workspace) -> str | None:
    """The agency's own key, else the server's; None when neither is set."""
    return agency_key(ws) or settings.anthropic_api_key or None


def headers_for(ws: Workspace) -> dict[str, str]:
    """An organization-level key must say which Console workspace to use (anthropic-workspace-id)."""
    wsid = ws.ai_workspace_id if agency_key(ws) else settings.anthropic_workspace_id
    return {"anthropic-workspace-id": wsid} if wsid else {}
