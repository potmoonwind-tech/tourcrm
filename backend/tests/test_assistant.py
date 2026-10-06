"""The setup assistant, with a scripted stand-in for Claude: it proposes, a person confirms, and
only then are suppliers, prices, routes and tours saved - through the app's own rules."""
from types import SimpleNamespace as NS

import pytest

from app.ai import agent

from .conftest import invite_and_join, signup
from .test_tours import agency, mk

CSV = "Hotel,City,DBL per night,SGL per night,Currency\nRioni Palace,Kutaisi,120,90,USD\nSighnaghi View,Sighnaghi,95,70,USD\n"


class Block(NS):
    def to_dict(self):
        return {k: v for k, v in vars(self).items()}


def text(t):
    return Block(type="text", text=t)


def use(i, tool, /, **args):
    return Block(type="tool_use", id=f"tu_{i}", name=tool, input=args)


class FakeClaude:
    """Plays back scripted assistant turns; records what it was sent and uploaded."""
    def __init__(self, turns):
        self.turns, self.sent, self.uploads = list(turns), [], []
        self.files = NS(upload=self._upload, delete=lambda fid: None)

    def _upload(self, file, expires_in_seconds):
        self.uploads.append((file[0], file[2], expires_in_seconds))
        return NS(id=f"file_{len(self.uploads)}")


class _CM:
    def __init__(self, msg):
        self.msg = msg

    def __enter__(self):
        return NS(get_final_message=lambda: self.msg)

    def __exit__(self, *a):
        return False


@pytest.fixture
def claude(monkeypatch):
    from app.config import settings
    monkeypatch.setattr(settings, "anthropic_api_key", "test-key")

    def install(turns):
        fake = FakeClaude(turns)

        def stream(**kw):
            fake.sent.append(kw)
            content, stop = fake.turns.pop(0)
            return _CM(NS(content=content, stop_reason=stop, usage=NS(
                input_tokens=1000, output_tokens=500, cache_creation_input_tokens=0, cache_read_input_tokens=0)))
        fake.beta = NS(messages=NS(stream=stream))
        monkeypatch.setattr(agent, "make_client", lambda ws: fake)
        return fake
    return install


def test_proposes_then_saves_only_what_is_confirmed(make_client, claude):
    c, base, _ = agency(make_client)
    fake = claude([
        ([text("Let me check what exists."), use(1, "list_records", kind="vendors"),
          use(2, "read_sheet", file="hotels.csv", sheet="Sheet1", start_row=1)], "tool_use"),
        ([use(3, "propose_vendors", vendors=[{"name": "Rioni Palace", "type": "hotel", "city": "Kutaisi", "currency": "USD"},
                                            {"name": "Sighnaghi View", "type": "hotell"}])], "tool_use"),       # a typo: refused
        ([use(4, "propose_vendors", vendors=[{"name": "Rioni Palace", "type": "hotel", "city": "Kutaisi", "currency": "USD"},
                                            {"name": "Sighnaghi View", "type": "hotel", "city": "Sighnaghi"}])], "tool_use"),
        ([use(5, "propose_prices", items=[{"vendor": "p1", "services": [
            {"name": "Double room", "code": "room_DBL", "category": "hotel", "unit": "room_night", "rates": [{"price": 120, "currency": "USD"}]},
            {"name": "Single room", "code": "room_SGL", "category": "hotel", "unit": "room_night", "rates": [{"price": 90, "currency": "USD"}]}]}]),
          use(6, "propose_route", code="ku", name="Kutaisi weekend", days=[{"city": "Kutaisi", "hotel": "p1"}, {"city": "Kutaisi"}]),
          ], "tool_use"),
        ([use(7, "propose_tours", tours=[{"route": "p4", "start_date": "2027-05-12", "pax": 20, "rooms": "10 DBL"}])], "tool_use"),
        ([text("I proposed 2 hotels, Rioni's prices, a route and a tour. Sighnaghi View has no prices in the file.")], "end_turn"),
    ])
    s = mk(c, f"{base}/ai/sessions", {})
    r = c.post(f"{base}/ai/sessions/{s['id']}/messages", data={"text": "Import my hotels and make a May tour"},
               files=[("files", ("hotels.csv", CSV.encode(), "text/csv"))])
    assert r.status_code == 200, r.text
    s = c.get(f"{base}/ai/sessions/{s['id']}").json()
    assert s["status"] == "idle", s["error"]
    assert [p["kind"] for p in s["plan"]] == ["vendor", "vendor", "prices", "route", "tour"]
    assert s["chat"][-1]["text"].startswith("I proposed") and s["title"] == "Import my hotels and make a May tour"

    # What Claude was sent: the sheet preview, cached request, the typo came back as an error it could fix.
    first = fake.sent[0]
    assert first["model"] == "claude-opus-5-5" and first["fallbacks"] == "default" and first["cache_control"] == {"type": "ephemeral"}
    assert "Rioni Palace" in str(first["messages"][0]["content"]) and "Base currency" in str(first["messages"][0]["content"])
    typo = fake.sent[2]["messages"][-1]["content"][0]
    assert typo["is_error"] and "type" in typo["content"]
    # Nothing saved yet.
    assert c.get(f"{base}/vendors").json() == []

    # Confirm everything but the second hotel.
    ids = [p["id"] for p in s["plan"] if p["id"] != "p2"]
    s = c.post(f"{base}/ai/sessions/{s['id']}/apply", json={"ids": ids}).json()
    assert {p["id"]: p["status"] for p in s["plan"]} == {"p1": "applied", "p2": "proposed", "p3": "applied", "p4": "applied", "p5": "applied"}
    vendors = c.get(f"{base}/vendors").json()
    assert [v["name"] for v in vendors] == ["Rioni Palace"]
    prices = c.get(f"{base}/vendors/{vendors[0]['id']}/services").json()
    assert {x["code"]: x["rates"][0]["price"] for x in prices} == {"room_DBL": 120, "room_SGL": 90}
    tour = c.get(f"{base}/tours/{s['plan'][4]['result_id']}").json()
    assert tour["start_date"] == "2027-05-12" and tour["end_date"] == "2027-05-13" and tour["days"][0]["hotel"]["name"] == "Rioni Palace"
    assert c.get(f"{base}/ai/status").json()["spent_usd"] > 0


def test_prices_for_an_existing_supplier_keep_the_rest(make_client, claude):
    c, base, _ = agency(make_client)
    v = mk(c, f"{base}/vendors", {"name": "Supra", "type": "restaurant"})
    c.put(f"{base}/vendors/{v['id']}/services", json=[
        {"code": "lunch", "name": "Lunch", "category": "meal", "unit": "person", "rates": [{"price": "25", "currency": "GEL"}]},
        {"code": "dinner", "name": "Dinner", "category": "meal", "unit": "person", "rates": [{"price": "35", "currency": "GEL"}]}])
    claude([
        ([use(1, "propose_prices", items=[{"vendor": v["id"], "services": [
            {"name": "Dinner", "code": "dinner", "category": "meal", "unit": "person", "rates": [{"price": 40, "currency": "GEL"}]}]}])], "tool_use"),
        ([text("New dinner price proposed.")], "end_turn"),
    ])
    s = mk(c, f"{base}/ai/sessions", {})
    c.post(f"{base}/ai/sessions/{s['id']}/messages", data={"text": "Supra dinner is now 40 GEL"})
    c.post(f"{base}/ai/sessions/{s['id']}/apply", json={"ids": ["p1"]})
    prices = {x["code"]: x["rates"][0]["price"] for x in c.get(f"{base}/vendors/{v['id']}/services").json()}
    assert prices == {"lunch": 25, "dinner": 40}


def test_files_limits_and_access(make_client, claude):
    from app.config import settings
    c, base, ws = agency(make_client)
    fake = claude([([text("Got the contract.")], "end_turn")])
    s = mk(c, f"{base}/ai/sessions", {})
    url = f"{base}/ai/sessions/{s['id']}"
    r = c.post(f"{url}/messages", data={"text": ""}, files=[("files", ("contract.pdf", b"%PDF-1.7 ...", "application/pdf"))])
    assert r.status_code == 200
    assert fake.uploads == [("contract.pdf", "application/pdf", 7 * 86400)]
    sent = fake.sent[0]["messages"][0]["content"]
    assert {"type": "document", "source": {"type": "file", "file_id": "file_1"}, "title": "contract.pdf"} in sent
    assert c.post(f"{url}/messages", files=[("files", ("x.exe", b"MZ....", "application/octet-stream"))]).status_code == 422

    # Staff can't use it; another agency can't see it.
    nino = make_client()
    signup(nino, "nino@a.com")
    invite_and_join(c, ws, nino, "nino@a.com", "staff")
    assert nino.get(f"{base}/ai/sessions").status_code == 403
    other, base2, _ = agency(make_client, "o@o.com", "O")
    assert other.get(f"{base2}/ai/sessions/{s['id']}").status_code == 404

    # The month's allowance used up: refused before calling Claude.
    settings_limit = settings.ai_monthly_usd
    try:
        settings.ai_monthly_usd = 0.0
        assert c.post(f"{url}/messages", data={"text": "more"}).status_code == 402
    finally:
        settings.ai_monthly_usd = settings_limit


def test_not_set_up(make_client, monkeypatch):
    from app.config import settings
    monkeypatch.setattr(settings, "anthropic_api_key", "")
    c, base, _ = agency(make_client)
    s = mk(c, f"{base}/ai/sessions", {})
    assert c.get(f"{base}/ai/status").json()["available"] is False
    assert c.post(f"{base}/ai/sessions/{s['id']}/messages", data={"text": "hi"}).status_code == 503


def test_agency_key_in_settings(make_client, monkeypatch):
    from app.config import settings
    from app.routers import assistant
    monkeypatch.setattr(settings, "anthropic_api_key", "")            # no server key
    checked = []
    monkeypatch.setattr(assistant, "_check_key", lambda key, wsid="": checked.append(key))
    c, base, ws = agency(make_client)
    assert c.get(f"{base}/ai/status").json()["available"] is False
    key = "sk-ant-api03-" + "x" * 40 + "WXYZ"
    assert c.put(f"{base}/ai/key", json={"key": "not-a-key-at-all-123456"}).status_code == 422
    assert c.put(f"{base}/ai/key", json={"key": key}).json() == {"hint": "WXYZ"} and checked == [key]
    st = c.get(f"{base}/ai/status").json()
    assert st["available"] is True and st["own_key"] is True
    # The key never comes back: only its last 4 characters.
    me = c.get("/api/auth/me").text
    assert key not in me and '"ai_key_hint":"WXYZ"' in me.replace(" ", "")
    # Saved encrypted; the agent gets the real key.
    from app.ai import keys
    from app.db import get_db
    from app.main import app
    from app.models import Workspace
    db = next(app.dependency_overrides[get_db]())
    w = db.get(Workspace, ws)
    assert key not in (w.ai_key_enc or "") and keys.key_for(w) == key and keys.headers_for(w) == {}
    # An organization-level key also needs the Console workspace.
    c.put(f"{base}/ai/key", json={"key": key, "workspace_id": "wrkspc_01AbC"})
    db.refresh(w)
    assert keys.headers_for(w) == {"anthropic-workspace-id": "wrkspc_01AbC"}
    assert c.put(f"{base}/ai/key", json={"key": key, "workspace_id": "bad id!"}).status_code == 422
    # Only owners/admins manage it.
    nino = make_client()
    signup(nino, "nino@a.com")
    invite_and_join(c, ws, nino, "nino@a.com", "manager")
    assert nino.put(f"{base}/ai/key", json={"key": key}).status_code == 403
    assert c.delete(f"{base}/ai/key").status_code == 204
    assert c.get(f"{base}/ai/status").json()["available"] is False
