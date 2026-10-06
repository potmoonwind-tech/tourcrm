import pytest
from fastapi.testclient import TestClient
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from app.db import Base, get_db, make_engine
from app.main import app


@pytest.fixture(autouse=True)
def _fresh_rate_limits():
    from app import ratelimit
    ratelimit.reset()
    yield


@pytest.fixture
def make_client():
    engine = make_engine("sqlite://", poolclass=StaticPool)
    Base.metadata.create_all(engine)
    TestSession = sessionmaker(bind=engine, autoflush=False, expire_on_commit=False)

    def _get_db():
        db = TestSession()
        try:
            yield db
        finally:
            db.close()

    app.dependency_overrides[get_db] = _get_db

    def factory() -> TestClient:
        # A separate client per person = a separate cookie jar.
        return TestClient(app)

    yield factory
    app.dependency_overrides.clear()
    engine.dispose()


def signup(client: TestClient, email: str, workspace_name: str | None = None) -> dict:
    r = client.post("/api/auth/signup", json={
        "email": email, "password": "password123", "full_name": email.split("@")[0],
        "workspace_name": workspace_name,
    })
    assert r.status_code == 201, r.text
    return r.json()


def invite_and_join(owner: TestClient, ws_id: str, member: TestClient, email: str, role: str) -> dict:
    r = owner.post(f"/api/workspaces/{ws_id}/invites", json={"email": email, "role": role})
    assert r.status_code == 201, r.text
    token = r.json()["link"].rsplit("/", 1)[1]
    r = member.post(f"/api/invites/{token}/accept")
    assert r.status_code == 200, r.text
    return r.json()
