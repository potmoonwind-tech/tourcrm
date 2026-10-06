"""Tasks: from bookings (to the person for that kind of work), payments (payments person, managers),
and own tasks; 'me' = mine + nobody's."""
from datetime import date, timedelta

from .conftest import invite_and_join, signup
from .test_finance import setup_tour
from .test_tours import agency


def iso(n):
    return (date.today() + timedelta(days=n)).isoformat()


def test_tasks_come_from_bookings_payments_and_people(make_client):
    c, base, ws = agency(make_client)
    t, hotel, resto, guide = setup_tour(c, base, start=iso(5))
    nino = make_client()
    signup(nino, "nino@a.com")
    invite_and_join(c, ws, nino, "nino@a.com", "staff")
    members = {m["email"]: m["user_id"] for m in c.get(f"{base}/members").json()}
    me = next(uid for email, uid in members.items() if email != "nino@a.com")
    c.patch(base, json={"task_owners": {"hotel": members["nino@a.com"], "payments": me}})

    tasks = c.get(f"{base}/tasks", params={"who": "all"}).json()
    book = {x["title"]: x for x in tasks if x["kind"] == "book"}
    assert set(book) == {"Hotel", "Resto", "Guide"}
    assert book["Hotel"]["assignee_name"] and book["Hotel"]["assignee_id"] == members["nino@a.com"]
    assert book["Resto"]["assignee_id"] is None                                  # nobody does meals yet
    # Nino sees the hotel and the nobody's ones, not money.
    mine = {(x["kind"], x["title"]) for x in nino.get(f"{base}/tasks").json()}
    assert ("book", "Hotel") in mine and ("book", "Resto") in mine and not any(k == "pay" for k, _ in mine)
    assert nino.get(f"{base}/tasks", params={"who": "all"}).status_code == 403

    # Booking moves on → the task changes, then disappears.
    url = f"{base}/tours/{t['id']}/bookings"
    hid = book["Hotel"]["booking_id"]
    nino.patch(f"{url}/{hid}", json={"status": "requested"})
    assert next(x for x in c.get(f"{base}/tasks", params={"who": "all"}).json() if x["booking_id"] == hid)["kind"] == "chase"
    nino.patch(f"{url}/{hid}", json={"status": "confirmed", "reference": "X1"})
    assert not any(x["booking_id"] == hid for x in c.get(f"{base}/tasks", params={"who": "all"}).json())

    # Payments due go to the payments person; one the guide pays in cash is not an office task.
    c.post(f"{base}/tours/{t['id']}/costs/generate")
    pays = {x["title"] for x in c.get(f"{base}/tasks").json() if x["kind"] == "pay"}
    assert "Guide" in pays and "Resto" in pays
    gid = book["Guide"]["booking_id"]
    c.patch(f"{url}/{gid}", json={"paid_by": "guide", "pay_method": "cash"})
    assert "Guide" not in {x["title"] for x in c.get(f"{base}/tasks").json() if x["kind"] == "pay"}

    # Own tasks: create for Nino, tick off.
    own = c.post(f"{base}/tasks", json={"title": "Send visa list", "assignee_id": members["nino@a.com"],
                                        "tour_id": t["id"], "due_date": iso(1)}).json()
    assert own["kind"] == "own" and own["tour_code"] == t["code"]
    assert any(x["task_id"] == own["task_id"] for x in nino.get(f"{base}/tasks").json())
    done = nino.patch(f"{base}/tasks/{own['task_id']}", json={"done": True}).json()
    assert done["done"] is True and not any(x["task_id"] == own["task_id"] for x in nino.get(f"{base}/tasks").json())
    s = nino.get(f"{base}/tasks/summary").json()
    assert s["mine"] >= 0 and "nobody" in s
    assert c.post(f"{base}/tasks", json={"title": "x", "assignee_id": "stranger"}).status_code == 422


def test_one_task_given_to_someone_book_and_pay_apart(make_client):
    c, base, ws = agency(make_client)
    t, hotel, resto, guide = setup_tour(c, base, start=iso(5))
    nino = make_client()
    signup(nino, "nino@a.com")
    invite_and_join(c, ws, nino, "nino@a.com", "staff")
    members = {m["email"]: m["user_id"] for m in c.get(f"{base}/members").json()}
    me = next(uid for email, uid in members.items() if email != "nino@a.com")
    c.post(f"{base}/tours/{t['id']}/costs/generate")

    def task(kind, title, who=c):
        return next(x for x in who.get(f"{base}/tasks", params={"who": "all"} if who is c else {}).json()
                    if x["kind"] == kind and x["title"] == title)

    # Nobody books the restaurant: Nino takes it herself; she can't hand it to someone else.
    resto_book = task("book", "Resto")
    assert resto_book["assignee_id"] is None
    assert nino.put(f"{base}/tasks/assign", json={"key": resto_book["key"], "assignee_id": me}).status_code == 403
    assert nino.put(f"{base}/tasks/assign", json={"key": resto_book["key"], "assignee_id": members["nino@a.com"]}).status_code == 204
    assert task("book", "Resto")["assignee_id"] == members["nino@a.com"]

    # Paying the same restaurant is a separate task: the manager gives it to himself.
    resto_pay = task("pay", "Resto")
    assert resto_pay["assignee_id"] is None
    assert c.put(f"{base}/tasks/assign", json={"key": resto_pay["key"], "assignee_id": me}).status_code == 204
    assert task("pay", "Resto")["assignee_id"] == me and task("book", "Resto")["assignee_id"] == members["nino@a.com"]
    assert nino.put(f"{base}/tasks/assign", json={"key": resto_pay["key"], "assignee_id": members["nino@a.com"]}).status_code == 403
    # Back to nobody; strangers and other agencies' tasks are refused.
    assert c.put(f"{base}/tasks/assign", json={"key": resto_pay["key"], "assignee_id": None}).status_code == 204
    assert task("pay", "Resto")["assignee_id"] is None
    assert c.put(f"{base}/tasks/assign", json={"key": resto_book["key"], "assignee_id": "stranger"}).status_code == 422
    other, base2, _ = agency(make_client, "o@o.com", "O")
    assert other.put(f"{base2}/tasks/assign", json={"key": resto_book["key"], "assignee_id": None}).status_code == 403 or \
        other.put(f"{base2}/tasks/assign", json={"key": resto_book["key"], "assignee_id": None}).status_code == 404


def test_own_task_types(make_client):
    c, base, ws = agency(make_client)
    nino = make_client()
    signup(nino, "nino@a.com")
    invite_and_join(c, ws, nino, "nino@a.com", "staff")
    types = [{"id": "visa", "name": "Visa", "color": "purple"}, {"id": "tix", "name": "Tickets"}]
    assert nino.put(f"{base}/tasks/types", json=types).status_code == 403          # managers keep the list
    assert c.put(f"{base}/tasks/types", json=types + [{"id": "v2", "name": "visa"}]).status_code == 422   # same name
    r = c.put(f"{base}/tasks/types", json=types)
    assert r.status_code == 200 and r.json()[1]["color"] == "blue"
    assert c.get(base).json()["task_types"][0]["name"] == "Visa"

    x = nino.post(f"{base}/tasks", json={"title": "Send passports", "type_id": "visa"}).json()
    assert x["type_id"] == "visa"
    assert nino.post(f"{base}/tasks", json={"title": "x", "type_id": "nope"}).status_code == 422
    assert nino.patch(f"{base}/tasks/{x['task_id']}", json={"type_id": "tix"}).json()["type_id"] == "tix"
    # Removing a type leaves its tasks without one.
    c.put(f"{base}/tasks/types", json=types[:1])
    assert next(i for i in nino.get(f"{base}/tasks").json() if i["task_id"] == x["task_id"])["type_id"] is None
