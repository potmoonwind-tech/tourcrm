import os

from pydantic_settings import BaseSettings, SettingsConfigDict

DEV_SECRET = "dev-only-insecure-secret-key-change-me-in-production"


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    database_url: str = "sqlite:///./tourcrm.db"
    # Must be overridden in production; the default only exists so local dev
    # and tests run without any setup.
    secret_key: str = DEV_SECRET
    session_days: int = 30
    cookie_secure: bool | None = None   # default: on when app_url is https
    # Where invite links point to (the frontend's own origin).
    app_url: str = "http://localhost:5173"
    cors_origins: list[str] = ["http://localhost:5173"]
    invite_days: int = 7
    upload_dir: str = "./uploads"       # receipt photos (app/storage.py)
    # Setup assistant (app/ai). The key stays on the server; each agency gets a monthly allowance.
    anthropic_api_key: str = ""
    anthropic_workspace_id: str = ""     # only for a key that isn't scoped to a Console workspace
    ai_model: str = "claude-opus-5-5"
    ai_monthly_usd: float = 25.0


settings = Settings()
# On Render the site's address is given to the app; it's where invite links point and where the
# browser calls from (same origin), unless APP_URL says otherwise (a custom domain).
_render = os.environ.get("RENDER_EXTERNAL_URL", "").rstrip("/")
if _render and "APP_URL" not in os.environ:
    settings.app_url = _render
    settings.cors_origins = [_render]
LOCAL =settings.app_url.startswith(("http://localhost", "http://127.0.0.1"))
if settings.cookie_secure is None:
    settings.cookie_secure = settings.app_url.startswith("https://")

# The development secret would let anyone forge a login: only ever on a developer's machine.
if settings.secret_key == DEV_SECRET and (not LOCAL or not settings.database_url.startswith("sqlite")):
    raise RuntimeError("SECRET_KEY must be set outside local development")
