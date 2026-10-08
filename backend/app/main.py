from pathlib import Path

from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import JSONResponse
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

from .config import settings
from .locks import TourLocked
from .routers import day_templates, menu_builder
from .routers import (
    alerts, assistant, auth, bills, bookings, distances, field, hotel_change, staff_change, meals, budget, cancellation, catalog, lifecycle, finance, imports, incidents, invites, invoices, people, pricing, programme, mail, quotes, rooms, search, series, setup, dashboard, tasks, tours, workspaces,
)

from .config import LOCAL

# The API description is for developers on their own machine, not for the public internet.
app = FastAPI(title="TourCRM", docs_url="/docs" if LOCAL else None, redoc_url=None, openapi_url="/openapi.json" if LOCAL else None)


@app.exception_handler(TourLocked)
def _locked(request: Request, exc: TourLocked):
    return JSONResponse(status_code=409, content={"detail": str(exc)})

app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

MAX_UPLOAD = 6 * 1024 * 1024
AI_UPLOAD = 25 * 1024 * 1024        # files for the setup assistant (PDF contracts, photos)


@app.middleware("http")
async def limit_uploads(request, call_next):
    """Spreadsheet imports and receipt photos are small: refuse big bodies before they are read."""
    limit = AI_UPLOAD if "/ai/sessions" in request.url.path else MAX_UPLOAD
    if request.method == "POST" and ("/import/" in request.url.path or request.url.path.startswith("/api/field/")
                                     or "/ai/sessions" in request.url.path):
        size = request.headers.get("content-length")
        if size is None or not size.isdigit() or int(size) > limit:
            from fastapi.responses import JSONResponse
            return JSONResponse({"detail": f"The file is too big (at most {limit // 1024 // 1024} MB)"}, status_code=413)
    return await call_next(request)


app.include_router(auth.router)
app.include_router(workspaces.router)
app.include_router(invites.router)
app.include_router(setup.router)
app.include_router(dashboard.router)
app.include_router(search.router)
app.include_router(bookings.router)
app.include_router(tasks.router)
app.include_router(distances.router)
app.include_router(catalog.router)
app.include_router(series.router)
app.include_router(tours.router)
app.include_router(people.router)
app.include_router(imports.router)
app.include_router(finance.router)
app.include_router(budget.router)
app.include_router(incidents.router)
app.include_router(cancellation.router)
app.include_router(lifecycle.router)
app.include_router(bills.router)
app.include_router(alerts.router)
app.include_router(meals.router)
app.include_router(rooms.router)
app.include_router(mail.router)
app.include_router(pricing.router)
app.include_router(invoices.router)
app.include_router(quotes.router)
app.include_router(field.router)
app.include_router(assistant.router)
app.include_router(hotel_change.router)
app.include_router(staff_change.router)
app.include_router(programme.router)
app.include_router(programme.public)
app.include_router(menu_builder.router)
app.include_router(day_templates.router)


@app.get("/health")
def health():
    return {"ok": True}


@app.get("/api/config")
def public_config():
    """What the browser needs before sign-in: which map to draw, and Google's browser key (public by
    design: Google limits it to this site's address)."""
    from .config import settings
    google = bool(settings.google_maps_key and settings.google_maps_browser_key)
    return {"maps": "google" if google else "osm", "maps_key": settings.google_maps_browser_key if google else ""}


# In production the built frontend is served from here, so the app is one service.
_dist = Path(__file__).resolve().parents[2] / "frontend" / "dist"
if _dist.is_dir():
    app.mount("/assets", StaticFiles(directory=_dist / "assets"), name="assets")

    @app.get("/{path:path}", include_in_schema=False)
    def spa(path: str):
        if path.startswith("api/"):
            raise HTTPException(404, "Not found")
        file = _dist / path
        if path and file.is_file() and _dist in file.resolve().parents:
            return FileResponse(file)
        # The page that loads the app is always checked anew, so a new version shows without Ctrl+F5
        # (its scripts have new names each build and may be kept).
        return FileResponse(_dist / "index.html", headers={"Cache-Control": "no-cache"})
