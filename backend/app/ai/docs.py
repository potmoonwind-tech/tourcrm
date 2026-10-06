"""Word documents for the assistant (tour programmes, contracts, price lists), read as numbered lines.

Like spreadsheets: the message shows the start, and the assistant pages through the rest with the
read_document tool, so a 40-page programme doesn't fill its context at once. Headings are marked
with "#", list items with "-", and each table row is one line with its cells separated by " | ".
Pictures are left out (they are counted, so the assistant knows they were there).
"""
import io
import zipfile

from defusedxml import ElementTree

W = "{http://schemas.openxmlformats.org/wordprocessingml/2006/main}"
MAX_XML = 40_000_000         # unpacked document.xml; more is not a real programme
MAX_LINES = 20_000
PREVIEW_LINES = 150
PREVIEW_CHARS = 15_000       # long paragraphs: fewer lines in the preview
PAGE_CHARS = 30_000          # at most this much text per read_document call
DOC_EXT = (".docx", ".docm", ".txt", ".md")


def _text(el) -> str:
    """A paragraph's text: its runs, with tabs and line breaks kept."""
    out = []
    for x in el.iter():
        if x.tag == W + "t" and x.text:
            out.append(x.text)
        elif x.tag == W + "tab":
            out.append("\t")
        elif x.tag in (W + "br", W + "cr"):
            out.append("\n")
    return "".join(out)


def _paragraph(p) -> list[str]:
    text = _text(p).strip()
    if not text:
        return []
    style = p.find(f"{W}pPr/{W}pStyle")
    name = (style.get(W + "val") or "").lower() if style is not None else ""
    if name.startswith(("heading", "title")) or name.isdigit() and int(name) <= 9:
        prefix = "# "
    elif p.find(f"{W}pPr/{W}numPr") is not None:
        prefix = "- "
    else:
        prefix = ""
    lines = [" ".join(x.split()) for x in text.split("\n")]
    return [prefix + lines[0], *lines[1:]] if lines else []


def _table(t) -> list[str]:
    rows = []
    for tr in t.findall(f"{W}tr"):
        cells = []
        for tc in tr.findall(f"{W}tc"):
            parts = [" ".join(_text(p).split()) for p in tc.iter(W + "p")]
            cells.append(" / ".join(x for x in parts if x))
        if any(cells):
            rows.append(" | ".join(cells))
    return rows


def _body(root) -> list[str]:
    body = root.find(f"{W}body")
    lines: list[str] = []
    for el in (body if body is not None else []):
        if el.tag == W + "p":
            lines.extend(_paragraph(el))
        elif el.tag == W + "tbl":
            lines.extend(_table(el))
        elif el.tag == W + "sdt":                 # content controls wrap ordinary paragraphs and tables
            content = el.find(f"{W}sdtContent")
            for inner in (content if content is not None else []):
                lines.extend(_paragraph(inner) if inner.tag == W + "p" else _table(inner) if inner.tag == W + "tbl" else [])
    return [x for x in lines if x.strip()]


def read(filename: str, data: bytes) -> dict:
    """{"lines": [...], "pictures": n}. Raises ValueError for anything that isn't a readable document."""
    name = filename.lower()
    if name.endswith((".txt", ".md")):
        for enc in ("utf-8-sig", "cp1251", "latin-1"):
            try:
                text = data.decode(enc)
                break
            except UnicodeDecodeError:
                continue
        lines = [" ".join(x.split()) for x in text.splitlines()]
        lines = [x for x in lines if x][:MAX_LINES]
        if not lines:
            raise ValueError("The file is empty")
        return {"lines": lines, "pictures": 0}
    try:
        z = zipfile.ZipFile(io.BytesIO(data))
        info = z.getinfo("word/document.xml")
    except (zipfile.BadZipFile, KeyError) as e:
        raise ValueError("Can't read this document — save it as .docx or PDF") from e
    if info.file_size > MAX_XML:
        raise ValueError("The document is too large to read")
    root = ElementTree.fromstring(z.read(info))
    lines = _body(root)[:MAX_LINES]
    pictures = sum(1 for n in z.namelist() if n.startswith("word/media/"))
    if not lines:
        raise ValueError("No text in this document" + (" — only pictures; send it as PDF" if pictures else ""))
    return {"lines": lines, "pictures": pictures}


def as_text(lines: list[str], start: int = 1) -> str:
    return "\n".join(f"{start + i}\t{x}" for i, x in enumerate(lines))


def fit(lines: list[str], limit: int, chars: int) -> int:
    """How many of these lines fit in `limit` lines and about `chars` characters (at least one)."""
    n, size = 0, 0
    for x in lines[:limit]:
        size += len(x) + 8
        if n and size > chars:
            break
        n += 1
    return n


def preview(filename: str, doc: dict) -> str:
    lines = doc["lines"]
    n = fit(lines, PREVIEW_LINES, PREVIEW_CHARS)
    more = f" (showing lines 1–{n}; read the rest with read_document)" if len(lines) > n else ""
    pics = f", {doc['pictures']} pictures left out" if doc.get("pictures") else ""
    return f"Document {filename!r}: {len(lines)} lines{pics}{more}\n" + as_text(lines[:n])
