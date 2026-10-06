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


def test_board_moves_do_the_work_and_tasks_are_passed_with_a_note(make_client):
    c, base, ws = agency(make_client)
    t, hotel, resto, guide = setup_tour(c, base, start=iso(5))
    nino = make_client()
    signup(nino, "nino@a.com")
    invite_and_join(c, ws, nino, "nino@a.com", "staff")
    giorgi = make_client()
    signup(giorgi, "giorgi@a.com")
    invite_and_join(c, ws, giorgi, "giorgi@a.com", "staff")
    members = {m["email"]: m["user_id"] for m in c.get(f"{base}/members").json()}
    c.patch(base, json={"task_owners": {"hotel": members["nino@a.com"]}})
    all_ = lambda: c.get(f"{base}/tasks", params={"who": "all"}).json()
    hotel_task = next(x for x in all_() if x["kind"] == "book" and x["title"] == "Hotel")
    key, bid = hotel_task["key"], hotel_task["booking_id"]
    assert hotel_task["stage"] == "todo"

    # In progress: only the board remembers; the booking is untouched.
    assert nino.post(f"{base}/tasks/move", json={"key": key, "stage": "doing"}).status_code == 204
    assert next(x for x in all_() if x["key"] == key)["stage"] == "doing"
    # Waiting = asked the supplier: the booking is requested (a "chase" task now).
    nino.post(f"{base}/tasks/move", json={"key": key, "stage": "waiting"})
    x = next(x for x in all_() if x["key"] == key)
    assert x["kind"] == "chase" and x["stage"] == "waiting"
    booking = next(b for b in c.get(f"{base}/tours/{t['id']}/bookings").json()["bookings"] if b["id"] == bid)
    assert booking["status"] == "requested"

    # Nino passes it to Giorgi with a note; Giorgi sees who and why.
    assert nino.post(f"{base}/tasks/pass", json={"key": key, "assignee_id": members["giorgi@a.com"],
                                                 "note": "Asked them - please chase tomorrow"}).status_code == 204
    g = next(x for x in giorgi.get(f"{base}/tasks").json() if x["key"] == key)
    assert g["assignee_id"] == members["giorgi@a.com"] and g["passed_note"] == "Asked them - please chase tomorrow" and g["passed_by"]
    # Nino can't hand on Giorgi's task any more (it isn't hers); a manager can.
    assert nino.post(f"{base}/tasks/pass", json={"key": key, "assignee_id": members["nino@a.com"]}).status_code == 403

    # Done = confirmed: the task is gone, the booking is confirmed.
    giorgi.post(f"{base}/tasks/move", json={"key": key, "stage": "done"})
    assert not any(x["key"] == key for x in all_())
    booking = next(b for b in c.get(f"{base}/tours/{t['id']}/bookings").json()["bookings"] if b["id"] == bid)
    assert booking["status"] == "confirmed"
    hist = c.get(f"{base}/tasks/history", params={"key": key}).json()
    assert [h["kind"] for h in hist] == ["moved", "moved", "passed", "done"]
    assert hist[2]["note"] == "Asked them - please chase tomorrow" and hist[2]["to"]

    # Own tasks: stages, done, and history from the start.
    own = c.post(f"{base}/tasks", json={"title": "Send invoice", "assignee_id": members["nino@a.com"]}).json()
    okey = own["key"]
    nino.post(f"{base}/tasks/move", json={"key": okey, "stage": "waiting"})
    assert next(x for x in nino.get(f"{base}/tasks").json() if x["key"] == okey)["stage"] == "waiting"
    nino.post(f"{base}/tasks/move", json={"key": okey, "stage": "done"})
    assert not any(x["key"] == okey for x in nino.get(f"{base}/tasks").json())
    assert [h["kind"] for h in c.get(f"{base}/tasks/history", params={"key": okey}).json()] == ["created", "moved", "done"]

    # A payment is done only by recording it.
    c.post(f"{base}/tours/{t['id']}/costs/generate")
    pay = next(x for x in c.get(f"{base}/tasks").json() if x["kind"] == "pay")
    assert c.post(f"{base}/tasks/move", json={"key": pay["key"], "stage": "done"}).status_code == 422
    assert c.post(f"{base}/tasks/move", json={"key": pay["key"], "stage": "doing"}).status_code == 204
