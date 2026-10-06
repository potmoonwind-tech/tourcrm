"""Spreadsheets we hand out (rooming lists, price lists) must not run formulas someone typed
as a name: a tourist called '=HYPERLINK(...)' stays text. Cells starting with = + - @ get a
leading apostrophe-equivalent (stored as text)."""
from openpyxl.workbook.workbook import Workbook

_RISKY = ("=", "+", "-", "@", "\t", "\r")


def defuse(wb: Workbook) -> Workbook:
    for ws in wb.worksheets:
        for row in ws.iter_rows():
            for cell in row:
                v = cell.value
                if isinstance(v, str) and v.startswith(_RISKY) and len(v.strip()) > 1:   # a lone "-" is fine
                    cell.value = "'" + v
                    cell.data_type = "s"
    return wb
