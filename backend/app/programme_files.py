"""The programme as a Word or Excel file (the PDF is the print page)."""
import io

from docx import Document
from docx.enum.text import WD_ALIGN_PARAGRAPH
from docx.oxml.ns import qn
from docx.shared import Pt, RGBColor
from openpyxl import Workbook
from openpyxl.styles import Alignment, Font, PatternFill

from .programme import ProgrammeOut
from .xlsx_safe import defuse

# Fonts that have the letters: Georgian, Chinese, and the rest.
FONT = {"ka": "Sylfaen", "zh": "Microsoft YaHei", "en": "Calibri"}


def _date(d) -> str:
    return d.strftime("%d.%m.%Y") if d else ""


def _step(s) -> str:
    when = f"{s.time}\u2013{s.end}" if s.time and s.end else s.time
    return f"{when}  {s.text}" if when else s.text


def _leg(g, L) -> str:
    return " \u00b7 ".join(x for x in (f"{g.start} \u2192 {g.end}", f"{g.km} {L['km']}" if g.km else "", g.drive) if x)


def docx_bytes(p: ProgrammeOut) -> bytes:
    L = p.labels
    doc = Document()
    font = FONT.get(p.lang, "Calibri")
    st = doc.styles["Normal"]
    st.font.name, st.font.size = font, Pt(10.5)
    st.element.rPr.rFonts.set(qn("w:eastAsia"), font)      # Chinese and Georgian letters in the same font
    for name in ("Title", "Heading 1", "Heading 2"):
        doc.styles[name].font.name = font
        doc.styles[name].element.rPr.rFonts.set(qn("w:eastAsia"), font)
    doc.add_paragraph(p.agency).runs[0].font.color.rgb = RGBColor(0x64, 0x74, 0x8B)
    doc.add_heading(p.title, level=0)
    sub = doc.add_paragraph(p.subtitle)
    sub.runs[0].font.color.rgb = RGBColor(0x47, 0x55, 0x69)
    for d in p.days:
        doc.add_heading(f"{d.title}" + (f"  \u00b7  {_date(d.date)}" if d.date else ""), level=1)
        facts = []
        if d.km:
            facts.append(f"{L['distance']}: {d.km} {L['km']}")
        if d.drive:
            facts.append(f"{L['driving']}: {d.drive}")
        if facts:
            para = doc.add_paragraph(" \u00b7 ".join(facts))
            para.runs[0].font.color.rgb = RGBColor(0x47, 0x55, 0x69)
        for g in (d.legs if len(d.legs) > 1 else []):      # one leg is the day's distance already
            para = doc.add_paragraph(_leg(g, L), style="List Bullet")
            para.runs[0].font.color.rgb = RGBColor(0x47, 0x55, 0x69)
        for f in d.flights:
            doc.add_paragraph(f"\u2708 {f}")
        if d.steps:
            for s in d.steps:
                doc.add_paragraph(_step(s), style="List Bullet")
        if d.activities:
            para = doc.add_paragraph()
            para.add_run(f"{L['activities']}: ").bold = True
            para.add_run(", ".join(d.activities))
        if d.meals:
            para = doc.add_paragraph()
            para.add_run(f"{L['meals']}: ").bold = True
            para.add_run("; ".join(f"{a} \u2013 {b}" for a, b in d.meals))
        if d.border:
            para = doc.add_paragraph()
            para.add_run(f"{L['border']}: ").bold = True
            para.add_run(d.border)
        if d.hotel:
            para = doc.add_paragraph()
            para.add_run(f"{L['overnight']}: ").bold = True
            para.add_run(d.hotel)
        if d.notes:
            para = doc.add_paragraph(d.notes)
            para.runs[0].italic = True
    buf = io.BytesIO()
    doc.save(buf)
    return buf.getvalue()


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
    head = [L["day"].format(n="").strip() or "#", L["route"], L["distance"], L["driving"], L["programme"],
            L["activities"], L["meals"], L["overnight"], L["notes"]]
    ws.append(head)
    for cell in ws[5]:
        cell.font = Font(name=font, bold=True, color="FFFFFF")
        cell.fill = PatternFill("solid", fgColor="1E293B")
    for d in p.days:
        when = f"{d.number}" + (f"\n{_date(d.date)}" if d.date else "")
        dist = "\n".join([f"{d.km} {L['km']}" if d.km else "", *(_leg(g, L) for g in d.legs)]).strip()
        ws.append([when, " \u2192 ".join(d.route), dist, d.drive,
                   "\n".join([*(f"\u2708 {f}" for f in d.flights), *(_step(s) for s in d.steps)]),
                   "\n".join(d.activities), "\n".join(f"{a}: {b}" for a, b in d.meals),
                   d.hotel, "\n".join(x for x in (d.border and f"{L['border']}: {d.border}", d.notes) if x)])
    for row in ws.iter_rows(min_row=6):
        for cell in row:
            cell.alignment = Alignment(wrap_text=True, vertical="top")
            cell.font = Font(name=font)
    for col, width in zip("ABCDEFGHI", (8, 30, 34, 12, 46, 30, 32, 26, 30)):
        ws.column_dimensions[col].width = width
    ws.freeze_panes = "A6"
    defuse(wb)      # nothing typed as a name runs as a formula
    buf = io.BytesIO()
    wb.save(buf)
    return buf.getvalue()
