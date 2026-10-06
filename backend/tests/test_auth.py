from .conftest import signup


def test_signup_creates_owned_workspace(make_client):
    c = make_client()
    me = signup(c, "nino@agency.ge", "Silk Road Tours")
    assert me["user"]["email"] == "nino@agency.ge"
    [ws] = me["workspaces"]
    assert ws["name"] == "Silk Road Tours"
    assert ws["slug"] == "silk-road-tours"
    assert ws["role"] == "owner"


def test_signup_without_workspace(make_client):
    me = signup(make_client(), "guide@mail.com")
    assert me["workspaces"] == []


def test_duplicate_email_rejected_case_insensitive(make_client):
    signup(make_client(), "a@x.com")
    r = make_client().post("/api/auth/signup", json={"email": "A@X.com", "password": "password123"})
    assert r.status_code == 409


def test_short_password_rejected(make_client):
    r = make_client().post("/api/auth/signup", json={"email": "a@x.com", "password": "short"})
    assert r.status_code == 422


def test_login_logout(make_client):
    signup(make_client(), "a@x.com", "A")
    c = make_client()
    assert c.get("/api/auth/me").status_code == 401
    assert c.post("/api/auth/login", json={"email": "a@x.com", "password": "wrong-pass"}).status_code == 401
    r = c.post("/api/auth/login", json={"email": "A@x.com", "password": "password123"})
    assert r.status_code == 200
    assert c.get("/api/auth/me").status_code == 200
    c.post("/api/auth/logout")
    assert c.get("/api/auth/me").status_code == 401


def test_duplicate_workspace_names_get_unique_slugs(make_client):
    a = signup(make_client(), "a@x.com", "Tours")["workspaces"][0]
    b = signup(make_client(), "b@x.com", "Tours")["workspaces"][0]
    assert a["slug"] != b["slug"]


def test_each_person_picks_the_apps_colour(make_client):
    c = make_client()
    signup(c, "nino@a.com")
    assert c.get("/api/auth/me").json()["user"]["theme"] == "blue"
    assert c.patch("/api/auth/me", json={"theme": "green"}).json()["user"]["theme"] == "green"
    assert c.get("/api/auth/me").json()["user"]["theme"] == "green"
    assert c.patch("/api/auth/me", json={"theme": "pink"}).status_code == 422


def test_easier_to_see(make_client):
    c = make_client()
    signup(c, "eka@a.com")
    u = c.get("/api/auth/me").json()["user"]
    assert (u["easy_view"], u["text_size"]) == (False, "normal")
    u = c.patch("/api/auth/me", json={"easy_view": True, "text_size": "larger"}).json()["user"]
    assert (u["easy_view"], u["text_size"], u["theme"]) == (True, "larger", "blue")
    assert c.patch("/api/auth/me", json={"text_size": "huge"}).status_code == 422
