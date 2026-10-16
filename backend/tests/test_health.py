"""The server answers its health check, without signing in."""


def test_health_answers_without_signing_in(make_client):
    r = make_client().get("/health")
    assert r.status_code == 200, r.text
    assert r.json() == {"ok": True}
