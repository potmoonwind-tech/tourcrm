# Moving sachoki360 → TourCRM agency "Sachiku"

Full story and notes: `docs/sachiku-migration.md`.

1. Copy the old app next to these scripts as `app/` and make a venv `venv/` with `requests openpyxl`.
2. `venv/Scripts/python run_sync.py` — downloads every sheet once into `raw/` and `xl/` (read-only),
   runs the old program's own readers → `app/gtc360.db`.
3. `venv/Scripts/python export.py` → `export.json` (tours, days, every balance line, contacts, menus).
4. From `tourcrm/backend`: `.venv/Scripts/python ../tools/import_sachoki360/import_sachiku.py` — dry run,
   prints what would be created. `--commit` creates the agency, `--replace` deletes an existing
   "sachiku" first. `--suppliers` lists the supplier names. `merge.json` = near-identical names merged.

Back up `tourcrm.db` before `--commit`.
