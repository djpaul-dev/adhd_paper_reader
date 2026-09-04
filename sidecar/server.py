"""
Focus Reader parsing sidecar.

Runs Docling locally and hands the browser a *structure* description of a PDF:
which blocks exist, in what reading order, and what each one is (paragraph,
heading, table, figure, formula...).

It deliberately does NOT return text geometry line by line. The browser already
has precise line boxes from PDF.js; what it lacks is structure. So the sidecar
supplies the structure, the browser matches it onto its own line geometry, and
the spotlight/sentence machinery keeps working unchanged.

The PDF is read in memory and never written to disk or sent anywhere else.

    python -m uvicorn server:app --host 127.0.0.1 --port 8077

or just:  python server.py
"""

from __future__ import annotations

import asyncio
import hashlib
import io
import json
import logging
import os
import threading
import time
from pathlib import Path
from typing import Any

from fastapi import FastAPI, File, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

log = logging.getLogger("focusreader.sidecar")
logging.basicConfig(level=logging.INFO, format="%(levelname)s %(message)s")

app = FastAPI(title="Focus Reader parsing sidecar", version="1.0")

# The page is served from a local static server on some other port, so the
# browser treats the sidecar as cross-origin. Only localhost origins are allowed.
app.add_middleware(
    CORSMiddleware,
    allow_origin_regex=r"^https?://(localhost|127\.0\.0\.1)(:\d+)?$",
    allow_methods=["GET", "POST"],
    allow_headers=["*"],
)

MAX_BYTES = 80 * 1024 * 1024

# Layout inference costs a minute or two per paper on CPU, so the result is
# cached by content hash. Re-opening the same document is then instant.
CACHE_DIR = Path(os.environ.get("FOCUSREADER_CACHE", Path.home() / ".cache" / "focusreader"))


def _cached(digest: str) -> dict[str, Any] | None:
    path = CACHE_DIR / f"{digest}.json"
    if not path.is_file():
        return None
    try:
        return json.loads(path.read_text())
    except Exception:
        return None


def _store(digest: str, payload: dict[str, Any]) -> None:
    try:
        CACHE_DIR.mkdir(parents=True, exist_ok=True)
        (CACHE_DIR / f"{digest}.json").write_text(json.dumps(payload))
    except Exception as exc:
        log.warning("could not cache result: %s", exc)

# Docling label -> what the reader should do with the block.
#   heading : becomes a section in the checklist
#   prose   : split into sentences
#   table / figure : kept whole, one stop for the spotlight
#   skip    : dropped (running heads, page numbers)
ROLE = {
    "title": ("heading", 1),
    "section_header": ("heading", 1),
    "subtitle_level_1": ("heading", 2),
    "paragraph": ("prose", 0),
    "text": ("prose", 0),
    "list_item": ("prose", 0),
    "caption": ("prose", 0),
    "footnote": ("prose", 0),
    "reference": ("prose", 0),
    "table": ("table", 0),
    "picture": ("figure", 0),
    "chart": ("figure", 0),
    "formula": ("figure", 0),
    "code": ("figure", 0),
    "page_header": ("skip", 0),
    "page_footer": ("skip", 0),
    "document_index": ("skip", 0),
}

"""Model loading and conversion are both slow and fully synchronous. They must
never run on the event loop: while they do, the server cannot answer /health,
and the reader concludes it is unreachable when in fact it is hard at work."""

_converter = None
_load_error: str | None = None
_load_started = False
_loaded = threading.Event()
_busy = 0     # conversions running (0 or 1 — they are serialised)
_waiting = 0  # requests queued behind the running one
_progress = {"file": "", "done": 0, "total": 0, "started": 0.0}
# One conversion at a time. Two at once on a CPU make both slower and leave
# the progress readout jumping between them.
_parse_lock: asyncio.Lock | None = None


def _load_models() -> None:
    global _converter, _load_error
    try:
        from docling.document_converter import DocumentConverter

        log.info("loading Docling models (first run downloads them)...")
        t0 = time.time()
        _converter = DocumentConverter()
        log.info("Docling ready in %.1fs", time.time() - t0)
    except Exception as exc:  # pragma: no cover - depends on the install
        _load_error = f"{type(exc).__name__}: {exc}"
        log.error("Docling unavailable: %s", _load_error)
    finally:
        _loaded.set()


def start_loading() -> None:
    """Warm the models in the background so the first parse is not also the
    first model load, and so /health answers immediately either way."""
    global _load_started
    if _load_started:
        return
    _load_started = True
    threading.Thread(target=_load_models, name="docling-load", daemon=True).start()


start_loading()


class Progress(BaseModel):
    file: str = ""
    done: int = 0
    total: int = 0
    seconds: float = 0.0


class Health(BaseModel):
    ok: bool
    parser: str
    docling: bool
    state: str          # loading | ready | error
    busy: int = 0
    queued: int = 0
    progress: Progress | None = None
    detail: str | None = None


@app.get("/health", response_model=Health)
def health() -> Health:
    """Answers instantly, including mid-parse. Never touches the models."""
    ready = _converter is not None
    state = "ready" if ready else ("error" if _load_error else "loading")
    prog = None
    if _busy and _progress["total"]:
        prog = Progress(
            file=_progress["file"],
            done=_progress["done"],
            total=_progress["total"],
            seconds=round(time.time() - _progress["started"], 1),
        )
    return Health(
        ok=ready,
        parser="docling",
        docling=ready,
        state=state,
        busy=_busy,
        queued=_waiting,
        progress=prog,
        detail=_load_error,
    )


def _page_sizes(doc: Any) -> dict[int, tuple[float, float]]:
    sizes: dict[int, tuple[float, float]] = {}
    for no, page in getattr(doc, "pages", {}).items():
        size = getattr(page, "size", None)
        if size is not None:
            sizes[int(no)] = (float(size.width), float(size.height))
    return sizes


def _normalise(bbox: Any, width: float, height: float) -> dict[str, float] | None:
    """Docling bboxes may be bottom-left origin; the reader wants top-left
    fractions of the page so it never has to care about page size."""
    if bbox is None or not width or not height:
        return None
    try:
        left, right = float(bbox.l), float(bbox.r)
        top, bottom = float(bbox.t), float(bbox.b)
    except Exception:
        return None

    origin = str(getattr(bbox, "coord_origin", "")).upper()
    if "BOTTOM" in origin:
        y0 = height - max(top, bottom)
        y1 = height - min(top, bottom)
    else:
        y0, y1 = min(top, bottom), max(top, bottom)

    x0, x1 = min(left, right), max(left, right)
    return {
        "x": max(0.0, x0 / width),
        "y": max(0.0, y0 / height),
        "w": max(0.0, min(1.0, (x1 - x0) / width)),
        "h": max(0.0, min(1.0, (y1 - y0) / height)),
    }


def _blocks(doc: Any) -> list[dict[str, Any]]:
    sizes = _page_sizes(doc)
    out: list[dict[str, Any]] = []

    # iterate_items walks the document body in reading order
    for item, _level in doc.iterate_items():
        label = str(getattr(item, "label", "") or "").lower()
        role, heading = ROLE.get(label, ("prose", 0))
        if role == "skip":
            continue

        text = (getattr(item, "text", "") or "").strip()
        if role == "table" and not text:
            # tables carry their text in cells, not .text
            try:
                text = item.export_to_dataframe().to_string(index=False)
            except Exception:
                try:
                    text = item.export_to_markdown()
                except Exception:
                    text = ""
        if role == "prose" and not text:
            continue

        prov = list(getattr(item, "prov", []) or [])
        if not prov:
            continue
        p = prov[0]
        page_no = int(getattr(p, "page_no", 1))
        width, height = sizes.get(page_no, (0.0, 0.0))
        box = _normalise(getattr(p, "bbox", None), width, height)
        if box is None:
            continue

        level = getattr(item, "level", None)
        if role == "heading" and isinstance(level, int) and level > 0:
            heading = min(3, level)

        out.append(
            {
                "page": page_no - 1,   # the reader is 0-based
                "kind": role,
                "heading": heading if role == "heading" else 0,
                "text": text,
                "box": box,
            }
        )
    return out


def _page_count(data: bytes) -> int:
    try:
        import pypdfium2 as pdfium

        doc = pdfium.PdfDocument(io.BytesIO(data))
        try:
            return len(doc)
        finally:
            doc.close()
    except Exception:
        return 0


def _convert(data: bytes, filename: str) -> dict[str, Any]:
    """The blocking part. Runs in a worker thread, never on the event loop.

    Converted a page at a time so the reader can show real progress. Costs
    roughly 15% over one whole-document call, which is worth it: a cold parse
    runs for minutes, and a bare elapsed-seconds counter tells you nothing
    about how much longer it will be."""
    t0 = time.time()
    from docling.datamodel.base_models import DocumentStream

    total = _page_count(data)
    _progress.update(file=filename, done=0, total=total, started=t0)

    blocks: list[dict[str, Any]] = []
    sizes: dict[int, tuple[float, float]] = {}

    if total <= 1:
        # unknown or single page: one shot, no progress to report
        doc = _converter.convert(DocumentStream(name=filename, stream=io.BytesIO(data))).document
        blocks = _blocks(doc)
        sizes = _page_sizes(doc)
        _progress.update(done=max(total, 1), total=max(total, 1))
    else:
        for page in range(1, total + 1):
            source = DocumentStream(name=filename, stream=io.BytesIO(data))
            doc = _converter.convert(source, page_range=(page, page)).document
            blocks.extend(_blocks(doc))
            sizes.update(_page_sizes(doc))
            _progress["done"] = page

    elapsed = time.time() - t0
    log.info("parsed %s: %d pages, %d blocks in %.1fs", filename, total, len(blocks), elapsed)
    return {
        "parser": "docling",
        "seconds": round(elapsed, 2),
        "pages": [{"width": w, "height": h} for _, (w, h) in sorted(sizes.items())],
        "blocks": blocks,
    }


@app.post("/parse")
async def parse(file: UploadFile = File(...)) -> dict[str, Any]:
    global _busy

    data = await file.read()
    if not data:
        raise HTTPException(400, "empty upload")
    if len(data) > MAX_BYTES:
        raise HTTPException(413, "file too large")

    digest = hashlib.sha256(data).hexdigest()
    hit = _cached(digest)
    if hit is not None:
        log.info("cache hit for %s", file.filename)
        return {**hit, "cached": True}

    # wait for the models off the event loop, so /health keeps answering
    start_loading()
    await asyncio.to_thread(_loaded.wait)
    if _converter is None:
        raise HTTPException(503, f"Docling is not available: {_load_error}")

    global _parse_lock, _waiting
    if _parse_lock is None:
        _parse_lock = asyncio.Lock()

    _waiting += 1
    entered = False
    try:
        async with _parse_lock:
            entered = True
            _waiting -= 1
            _busy += 1
            try:
                payload = await asyncio.to_thread(_convert, data, file.filename or "paper.pdf")
            finally:
                _busy -= 1
                _progress.update(file="", done=0, total=0, started=0.0)
    except HTTPException:
        raise
    except Exception as exc:
        log.exception("conversion failed")
        raise HTTPException(500, f"{type(exc).__name__}: {exc}") from exc
    finally:
        if not entered:
            _waiting -= 1

    _store(digest, payload)
    return {**payload, "cached": False}


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host="127.0.0.1", port=8077, log_level="info")
