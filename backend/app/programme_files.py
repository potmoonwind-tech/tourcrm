"""The programme as a Word or Excel file (the PDF is the print page).

Each day reads top to bottom like the day itself: the day's heading and road total, then one timeline
where every drive has its own time ("08:30–10:00  ↓ 86 km · 1 h 30 min") just before the place it leads
to, and at the end what's included (meals, tickets, the night's hotel)."""
import io

from docx import Document
from docx.enum.table import WD_TABLE_ALIGNMENT
from docx.oxml import OxmlElement
from docx.oxml.ns import qn
from docx.shared import Cm, Pt, RGBColor
from openpyxl import Workbook
from openpyxl.styles import Alignment, Border, Font, PatternFill, Side

from .programme import ProgrammeOut
from .xlsx_safe import defuse

# Fonts that have the letters: Georgian, Chinese, and the rest.
FONT = {"ka": "Sylfaen", "zh": "Microsoft YaHei", "en": "Calibri"}
GREY, DARK, SKY = RGBColor(0x64, 0x74, 0x8B), RGBColor(0x0F, 0x17, 0x2A), RGBColor(0x02, 0x84, 0xC7)


def _date(d) -> str:
    return d.strftime("%d.%m.%Y") if d else ""


def _span(a: str, b: str) -> str:
    return f"{a}–{b}" if a and b else a


def _step(s) -> str:
    when = _span(s.time, s.end)
    return f"{when}  {s.text}" if when else s.text


def _hop(g, L) -> str:
    """The drive just before a step: "↓ 25 km · 40 min"."""
    what = " · ".join(x for x in (f"{g.km} {L['km']}" if g.km else "", g.drive) if x)
    return f"↓ {what}" if what else ""


def _leg(g, L) -> str:
    return " · ".join(x for x in (f"{g.start} → {g.end}", f"{g.km} {L['km']}" if g.km else "", g.drive) if x)


def _road(d, L) -> str:
    """The day's road in one line: "Distance: 228 km · Driving: 3 h 55 min"."""
    return " · ".join(x for x in (d.km and f"{L['distance']}: {d.km} {L['km']}", d.drive and f"{L['driving']}: {d.drive}") if x)


def _meal_words(d) -> str:
    """With the timeline the menus are already under each restaurant: the footer just says which meals."""
    return ", ".join(a for a, _ in d.meals)


def _timeline(d, L) -> list[tuple[str, str, str, str]]:
    """The day as rows: (time, what, note, kind) - kind "drive" for the road between places."""
    rows = [("", f"✈ {f}", "", "flight") for f in d.flights]
    for s in d.steps:
        if s.drive and _hop(s.drive, L):
            rows.append((_span(s.drive.depart, s.drive.arrive), _hop(s.drive, L), "", "drive"))
        rows.append((_span(s.time, s.end), s.text, s.note, s.kind))
    if not d.steps:
        rows += [("", _leg(g, L), "", "drive") for g in (d.legs if len(d.legs) > 1 else [])]
    return rows


# --- Word -----------------------------------------------------------------------------------------------

def _shade(cell, hex_fill: str) -> None:
    tc = cell._tc.get_or_add_tcPr()
    sh = OxmlElement("w:shd")
    sh.set(qn("w:val"), "clear"), sh.set(qn("w:color"), "auto"), sh.set(qn("w:fill"), hex_fill)
    tc.append(sh)


def _no_borders(table) -> None:
    borders = OxmlElement("w:tblBorders")
    for edge in ("top", "left", "bottom", "right", "insideH", "insideV"):
        e = OxmlElement(f"w:{edge}")
        e.set(qn("w:val"), "nil")
        borders.append(e)
    table._tbl.tblPr.append(borders)


def _run(para, text: str, *, size=None, bold=False, italic=False, color=None):
    r = para.add_run(text)
    if size:
        r.font.size = Pt(size)
    r.bold, r.italic = bold, italic
    if color is not None:
        r.font.color.rgb = color
    return r


def _tight(para, before=0, after=0) -> None:
    para.paragraph_format.space_before, para.paragraph_format.space_after = Pt(before), Pt(after)


def docx_bytes(p: ProgrammeOut) -> bytes:
    L = p.labels
    doc = Document()
    for sec in doc.sections:
        sec.left_margin = sec.right_margin = Cm(2)
    font = FONT.get(p.lang, "Calibri")
    st = doc.styles["Normal"]
    st.font.name, st.font.size = font, Pt(10.5)
    st.element.rPr.rFonts.set(qn("w:eastAsia"), font)      # Chinese and Georgian letters in the same font
    for name in ("Title", "Heading 1", "Heading 2"):
        doc.styles[name].font.name = font
        doc.styles[name].element.rPr.rFonts.set(qn("w:eastAsia"), font)
    _run(doc.add_paragraph(), p.agency, color=GREY)
    doc.add_heading(p.title, level=0)
    _run(doc.add_paragraph(), p.subtitle, color=GREY)
    for d in p.days:
        head = doc.add_heading(level=1)
        _run(head, d.title)
        if d.date:
            _run(head, f"   {_date(d.date)}", size=11, bold=False, color=GREY)
        _tight(head, before=16, after=2)
        if _road(d, L):
            _tight(para := doc.add_paragraph(), after=6)
            _run(para, _road(d, L), size=9.5, color=GREY)
        rows = _timeline(d, L)
        if rows:
            table = doc.add_table(rows=0, cols=2)
            table.alignment = WD_TABLE_ALIGNMENT.LEFT
            _no_borders(table)
            for when, what, note, kind in rows:
                tc, wc = table.add_row().cells
                tc.width, wc.width = Cm(2.6), Cm(14.4)
                drive = kind == "drive"
                _tight(tp := tc.paragraphs[0], 1, 1)
                _run(tp, when, size=9 if drive else 10, color=GREY if drive else DARK, bold=not drive)
                _tight(wp := wc.paragraphs[0], 1, 1)
                _run(wp, what, size=9 if drive else 10.5, color=GREY if drive else DARK, italic=drive)
                if note:
                    _run(wc.add_paragraph(), note, size=9, italic=True, color=GREY)
                if drive:
                    _shade(tc, "F1F5F9"), _shade(wc, "F1F5F9")
        facts = [(L["meals"], _meal_words(d) if d.steps else "; ".join(f"{a} – {b}" for a, b in d.meals)),
                 (L["activities"], ", ".join(d.activities)), (L["border"], d.border), (L["overnight"], d.hotel)]
        for i, (label, text) in enumerate(x for x in facts if x[1]):
            _tight(para := doc.add_paragraph(), before=6 if i == 0 else 0)
            _run(para, f"{label}: ", bold=True, color=SKY)
            _run(para, text)
        if d.notes:
            _run(doc.add_paragraph(), d.notes, italic=True, color=GREY)
    buf = io.BytesIO()
    doc.save(buf)
    return buf.getvalue()


# --- Excel: one row per step, a coloured row for each day -----------------------------------------------

def xlsx_bytes(p: ProgrammeOut) -> bytes:
    L = p.labels
    wb = Workbook()
    ws = wb.active
    ws.title = L["programme"][:31]
    font = FONT.get(p.lang, "Calibri")
    ws.append([p.title])
    ws["A1"].font = Font(name=font, size=16, bold=True)
    ws.append([p.subtitle])
    ws.append([p.agency])
    ws.append([])
    ws.append([L["day"].format(n="").strip() or "#", "", L["programme"], L["notes"]])
    for cell in ws[5]:
        cell.font = Font(name=font, bold=True, color="FFFFFF")
        cell.fill = PatternFill("solid", fgColor="1E293B")
    day_fill, drive_fill = PatternFill("solid", fgColor="E0F2FE"), PatternFill("solid", fgColor="F8FAFC")
    line = Border(top=Side(style="thin", color="BAE6FD"))
    for d in p.days:
        ws.append([f"{d.title}" + (f"  ·  {_date(d.date)}" if d.date else ""), "", "", _road(d, L)])
        r = ws.max_row
        for cell in ws[r]:
            cell.fill, cell.border = day_fill, line
            cell.font = Font(name=font, bold=True, size=12, color="0F172A")
        ws.merge_cells(start_row=r, start_column=1, end_row=r, end_column=3)
        for when, what, note, kind in _timeline(d, L):
            ws.append(["", when, what, note])
            if kind == "drive":
                for cell in ws[ws.max_row]:
                    cell.fill, cell.font = drive_fill, Font(name=font, italic=True, color="64748B")
        facts = [(L["meals"], _meal_words(d) if d.steps else "; ".join(f"{a}: {b}" for a, b in d.meals)),
                 (L["activities"], ", ".join(d.activities)), (L["border"], d.border), (L["overnight"], d.hotel),
                 (L["notes"], d.notes)]
        for label, text in facts:
            if text:
                ws.append(["", f"{label}:", text])
                ws.cell(ws.max_row, 2).font = Font(name=font, bold=True, color="0284C7")
        ws.append([])
    for row in ws.iter_rows(min_row=6):
        for cell in row:
            cell.alignment = Alignment(wrap_text=True, vertical="top")
            if cell.font.name != font:
                cell.font = Font(name=font, bold=cell.font.bold, italic=cell.font.italic, color=cell.font.color)
    for col, width in zip("ABCD", (6, 14, 60, 40)):
        ws.column_dimensions[col].width = width
    ws.freeze_panes = "A6"
    defuse(wb)      # nothing typed as a name runs as a formula
    buf = io.BytesIO()
    wb.save(buf)
    return buf.getvalue()
