"""Official rates of the National Bank of Georgia, as a *suggestion* for an agency's own rates.

Source: Bank of Georgia's public API (no login), `GET /api/rates/nbg/{currency}` → GEL for one
unit of the currency, e.g. USD → 2.6039, AMD → 0.0071762. Docs:
https://api.bog.ge/docs/en/bonline/rates/nbg — rate limited to 60 requests a minute, so answers
are cached for an hour per currency. Any currency pair goes through GEL: 1 X = nbg(X) / nbg(base).

The agency always decides its rates itself; this never writes them.
"""
import time
from datetime import date
from decimal import Decimal

import httpx

URL = "https://api.businessonline.ge/api/rates/nbg/{currency}"
TTL = 3600.0
_cache: dict[str, tuple[float, Decimal | None, date]] = {}   # currency → (fetched at, GEL per unit or None, day)


class Unavailable(Exception):
    """The bank's API could not be reached or answered something unusable."""


def _gel_per_unit(currency: str, client: httpx.Client) -> Decimal:
    if currency == "GEL":
        return Decimal(1)
    hit = _cache.get(currency)
    if hit and time.monotonic() - hit[0] < TTL:
        if hit[1] is None:
            raise Unavailable(currency)
        return hit[1]
    try:
        r = client.get(URL.format(currency=currency), headers={"Accept": "application/json"})
        if r.status_code == 404:
            _cache[currency] = (time.monotonic(), None, date.today())     # not quoted: don't ask again for an hour
            raise Unavailable(currency)
        r.raise_for_status()
        value = Decimal(str(r.json()))
    except (httpx.HTTPError, ValueError, ArithmeticError) as e:
        raise Unavailable(currency) from e
    if value <= 0:
        _cache[currency] = (time.monotonic(), None, date.today())
        raise Unavailable(currency)
    _cache[currency] = (time.monotonic(), value, date.today())
    return value


def rates_to(base: str, currencies: list[str], timeout: float = 6.0) -> dict[str, Decimal]:
    """1 unit of each currency in `base`, by the National Bank's rates of today.
    Currencies the bank doesn't quote are left out; raises Unavailable if the bank can't be reached."""
    out: dict[str, Decimal] = {}
    wanted = [c for c in dict.fromkeys(currencies) if c != base]
    with httpx.Client(timeout=timeout) as client:
        per_base = _gel_per_unit(base, client)          # the bank is unreachable → Unavailable
        for cur in wanted:
            try:
                out[cur] = (_gel_per_unit(cur, client) / per_base).quantize(Decimal("0.000001"))
            except Unavailable:
                continue                                 # not quoted by the bank: the agency types it
    if wanted and not out and base == "GEL":
        raise Unavailable(",".join(wanted))
    return out
