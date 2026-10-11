"""A new tour from a few words: the AI's fields become days, with hotels from the catalogue."""
from types import SimpleNamespace

from app.routers import tour_draft

from .test_tours import agency


def fake_ai(fields):
    block = SimpleNamespace(type="tool_use", input=fields)
    return lambda ws: SimpleNamespace(messages=SimpleNamespace(create=lambda **k: SimpleNamespace(content=[block])))


def test_a_draft_from_words(make_client, monkeypatch):
    c, base, _ = agency(make_client)
    h = c.post(f"{base}/vendors", json={"name": "Old Town Hotel", "type": "hotel", "city": "Tbilisi"}).json()
    cl = c.post(f"{base}/clients", json={"name": "Shanghai Silk Travel"}).json()
    monkeypatch.setattr(tour_draft.keys, "key_for", lambda ws: "k")
    monkeypatch.setattr(tour_draft, "make_client", fake_ai({
        "start_date": "2026-11-03", "towns": [{"town": "Tbilisi", "nights": 2}, {"town": "Kazbegi", "nights": 1}],
        "pax": 20, "leaders": 1, "client": "Shanghai Silk"}))
    d = c.post(f"{base}/tours/draft", json={"text": "20+1 from Shanghai Silk, 3 Nov, Tbilisi 2 nights, Kazbegi"}).json()
    assert d["start_date"] == "2026-11-03" and d["pax"] == 20 and d["leaders"] == 1
    assert [x["city"] for x in d["days"]] == ["Tbilisi", "Tbilisi", "Kazbegi", "Kazbegi"]
    assert d["days"][0]["hotel_id"] == h["id"] and d["days"][2]["hotel_id"] is None and d["days"][3]["hotel_id"] is None
    assert d["client_id"] == cl["id"]


def test_no_ai_key_says_so(make_client, monkeypatch):
    c, base, _ = agency(make_client)
    monkeypatch.setattr(tour_draft.keys, "key_for", lambda ws: None)
    assert c.post(f"{base}/tours/draft", json={"text": "a tour"}).status_code == 503
