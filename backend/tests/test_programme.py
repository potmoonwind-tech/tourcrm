"""The programme to send: by day, in the chosen language, from what's on screen (saved or not)."""
import io
import json
from types import SimpleNamespace

import pytest
from docx import Document
from openpyxl import load_workbook

from app import programme
from app.config import settings

from .test_quotes_api import mk
from .test_tours import agency


class FakeTranslator:
    """Answers like Claude: the list, each item marked with the language. Counts the calls."""
    def __init__(self):
        self.calls = 0
        self.messages = self

    def create(self, model, max_tokens, messages):
        self.calls += 1
        prompt = messages[0]["content"]
        items = json.loads(prompt[prompt.index("["):])
        lang = "ZH" if "Chinese" in prompt else "KA" if "Georgian" in prompt else "EN"
        return SimpleNamespace(content=[SimpleNamespace(type="text", text=json.dumps([f"{lang}:{x}" for x in items], ensure_ascii=False))])


@pytest.fixture
def translator(monkeypatch):
    monkeypatch.setattr(settings, "anthropic_api_key", "test-key")
    fake = FakeTranslator()
    monkeypatch.setattr(programme, "make_client", lambda ws: fake)
    return fake


def _days(hotel, resto, museum_service):
    return [
        {"city": "Tbilisi", "hotel_id": hotel, "dinner_id": resto, "schedule": [
            {"id": "a", "kind": "visit", "time": "15:00", "end": "17:00", "title": "Old Tbilisi walk"},
            {"id": "b", "kind": "meal", "time": "19:00", "ref": "dinner"}]},
        {"city": "Kazbegi", "stops": ["Mtskheta", "Ananuri"], "km": 160, "drive_minutes": [30, 40, 50], "drive_km": [25, 45, 90],
         "hotel_id": hotel, "lunch_mode": "own", "extras": [{"service_id": museum_service, "quantity": None, "notes": ""}],
         "notes": "Bring warm clothes"},
        {"city": "Tbilisi", "km": 155},
    ]


def _setup(c, base):
    hotel = mk(c, f"{base}/vendors", {"name": "Rooms Hotel", "type": "hotel"})
    resto = mk(c, f"{base}/vendors", {"name": "Barbarestan", "type": "restaurant"})
    museum = mk(c, f"{base}/vendors", {"name": "Gergeti Trinity", "type": "activity"})
    svc = c.put(f"{base}/vendors/{museum['id']}/services", json=[
        {"name": "Jeep up the hill", "category": "activity", "unit": "person", "rates": [{"price": "20", "currency": "GEL"}]}]).json()[0]
    return _days(hotel["id"], resto["id"], svc["id"])


def test_programme_by_day_in_chinese_translated_once(make_client, translator):
    c, base, _ = agency(make_client)
    days = _setup(c, base)
    body = {"title": "Georgia Highlights", "start_date": "2026-11-01", "days": days, "lang": "zh"}
    p = c.post(f"{base}/programme", json=body).json()
    assert p["labels"]["breakfast"] == "早餐" and p["warnings"] == []
    d1, d2, d3 = p["days"]
    assert d1["title"].startswith("第1天") and d1["hotel"] == "ZH:Rooms Hotel" and d1["date"] == "2026-11-01"
    assert d1["steps"][0] == {"time": "15:00", "end": "17:00", "text": "ZH:Old Tbilisi walk"}
    assert d1["steps"][1]["text"] == "晚餐: ZH:Barbarestan"
    # Day 2: the road through its places, km and the coach time (×1.25: 120 min → 2 h 30 min).
    assert d2["route"] == ["ZH:Tbilisi", "ZH:Mtskheta", "ZH:Ananuri", "ZH:Kazbegi"]
    assert d2["km"] == 160 and d2["drive"] == "2 小时 30 分钟"
    assert ["早餐", "ZH:Rooms Hotel"] in d2["meals"] and ["午餐", "自理"] in d2["meals"]
    assert d2["activities"] == ["ZH:Gergeti Trinity: ZH:Jeep up the hill"] and d2["notes"] == "ZH:Bring warm clothes"
    assert d3["km"] == 155 and p["total_km"] == 315 and p["title"] == "ZH:Georgia Highlights"
    # No prices anywhere.
    assert "GEL" not in json.dumps(p["days"], ensure_ascii=False)
    calls = translator.calls
    c.post(f"{base}/programme", json=body)
    assert translator.calls == calls                     # kept: not asked (or paid) again


def test_georgian_texts_stay_and_files_download(make_client, translator):
    c, base, _ = agency(make_client)
    days = _setup(c, base)
    days[0]["city"] = "თბილისი"
    p = c.post(f"{base}/programme", json={"days": days, "lang": "ka", "include": {"schedule": False}}).json()
    assert p["days"][0]["route"] == ["თბილისი"] and p["days"][0]["steps"] == []
    assert p["days"][1]["route"][0] == "თბილისი"
    r = c.post(f"{base}/programme.docx", json={"title": "Test", "days": days, "lang": "en"})
    assert r.status_code == 200 and "attachment" in r.headers["content-disposition"]
    text = "\n".join(x.text for x in Document(io.BytesIO(r.content)).paragraphs)
    assert "Day 2" in text and "Overnight: Rooms Hotel" in text and "Distance: 160 km" in text
    x = c.post(f"{base}/programme.xlsx", json={"title": "Test", "days": days, "lang": "en"})
    ws = load_workbook(io.BytesIO(x.content)).active
    assert ws["A1"].value == "Test" and ws["B7"].value.endswith("Kazbegi")


def test_without_an_ai_key_texts_stay_as_written(make_client, monkeypatch):
    monkeypatch.setattr(settings, "anthropic_api_key", "")
    c, base, _ = agency(make_client)
    p = c.post(f"{base}/programme", json={"days": _setup(c, base), "lang": "zh"}).json()
    assert p["warnings"] == ["no_ai_key"] and p["days"][0]["hotel"] == "Rooms Hotel" and p["labels"]["day"] == "第{n}天"


def test_place_to_place_km_and_only_some_days(make_client, translator):
    c, base, _ = agency(make_client)
    days = _setup(c, base)
    p = c.post(f"{base}/programme", json={"days": days, "lang": "en", "translate": False, "only_days": [2]}).json()
    assert [d["number"] for d in p["days"]] == [2] and p["total_km"] == 160
    legs = p["days"][0]["legs"]
    assert [(g["start"], g["end"], g["km"]) for g in legs] == [("Tbilisi", "Mtskheta", 25), ("Mtskheta", "Ananuri", 45), ("Ananuri", "Kazbegi", 90)]
    assert legs[0]["drive"] == "40 min"          # 30 min by car x 1.25, to 5 minutes
    assert p["days"][0]["meals"][0] == ["Breakfast", "Rooms Hotel"]     # day 1 left out, its hotel still counts
    text = "\n".join(x.text for x in Document(io.BytesIO(c.post(f"{base}/programme.docx", json={"days": days, "lang": "en"}).content)).paragraphs)
    assert "Mtskheta \u2192 Ananuri \u00b7 45 km" in text
