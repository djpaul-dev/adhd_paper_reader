# Parsing sidecar (optional)

The reader's built-in parser infers the layout from page geometry, in your
browser. That works on most papers and needs nothing installed. Where it
struggles — unusual grids, dense figures, borderless tables — a layout model
does markedly better.

Layout models are Python, so this is a small local service. **The PDF is posted
to `127.0.0.1` and nothing else.** It is never written anywhere except the
result cache, and never leaves your machine.

## Setup

```bash
cd sidecar
python3 -m venv .venv
.venv/bin/pip install docling fastapi "uvicorn[standard]" python-multipart
.venv/bin/python server.py
```

First run downloads the Docling model weights (a few hundred MB). Then, in the
reader's **notes panel → Parser**, tick *Use the local parsing sidecar* and
press *Check connection*. Re-open your paper.

The badge next to the document title shows which parser produced the structure.

## Speed

Layout inference is slow on CPU — roughly **1–2 minutes per document** here
(a 2-page paper took 59s, a 15-page one 132s). With a CUDA GPU it is far faster.

Results are cached by content hash, so this is a **one-time cost per paper**:
re-opening the same file returns in ~20ms. The cache lives in
`~/.cache/focusreader/` (override with `FOCUSREADER_CACHE`). Delete it to reparse.

Documents are converted **a page at a time** so progress is real rather than a
bare timer: `/health` reports `progress` as `{file, done, total, seconds}` while
a parse runs, and the reader shows "reading page 4 of 11 — 27%". Chunking costs
roughly 15% over one whole-document call and is otherwise lossless (same blocks,
same page numbering), which is a fair trade when a cold parse runs for minutes.

Conversions are **serialised**: one at a time, with any others queued
(`busy` / `queued` in `/health`). Two at once on a CPU make both slower and leave
the progress readout jumping between documents.

Model loading and conversion are both fully synchronous, so they run in worker
threads — never on the event loop. That matters: while a parse was blocking the
loop, `/health` could not answer at all, and the reader concluded the service was
unreachable when it was in fact working. `/health` now replies instantly at any
time and reports `state` (`loading` / `ready` / `error`) and `busy`, the number of
parses in flight. The reader's own timeout is 15 minutes to match.

## What it actually returns

Only *structure*: which regions exist, what each one is, and where it sits.

```json
{ "parser": "docling", "cached": false,
  "pages": [{"width": 612, "height": 792}],
  "blocks": [
    {"page": 0, "kind": "heading", "heading": 1,
     "text": "1. Introduction",
     "box": {"x": 0.07, "y": 0.28, "w": 0.10, "h": 0.01}} ] }
```

`kind` is one of `heading` / `prose` / `table` / `figure`. Boxes are fractions of
the page with **y measured from the top**.

The browser deliberately does **not** use the returned text. It already has
exact line geometry from PDF.js, which is what the spotlight, the sentence
marks and the selectable text layer are drawn from. Each region box simply
claims the local line fragments whose centres fall inside it. So you get the
model's structure with the reader's precision.

Two safeguards:

- **Reading order is re-derived locally.** Docling's own item order is not
  reliable on interrupted grids — on the stress-test document it emitted the
  title *after* the abstract and interleaved a three-column block with the
  section below it. The reader re-orders the model's regions with the same
  whitespace recursion it uses for its own parsing, which fixes both.
- **Coverage check.** If the model's boxes fail to claim at least 75% of the
  page text, its idea of the layout does not match the file and the reader
  falls back to the built-in parser rather than lose content.

If the service is off, unreachable, slow, or returns something unusable, the
reader silently uses the built-in parser. Nothing breaks.

## Swapping the model

`ROLE` in `server.py` maps labels to the four kinds the reader understands, and
`_blocks()` walks the document. To try MinerU, GROBID or anything else, keep the
response shape and rewrite those two — the browser needs no changes.


---

## On a GPU (Modal)

`modal_app.py` is the same service on a GPU. Same `/health` and `/parse`
contract, so the reader only needs its URL changed.

```bash
cd sidecar
.venv/bin/pip install modal
.venv/bin/modal deploy modal_app.py     # prints a https://….modal.run URL
```

Paste that URL into the reader's Parser panel (**Where it runs**). Model weights
are baked into the image at build time so a cold start does not also download
them; results are cached in a Modal volume by content hash, as locally.

**This one is not local.** The PDF is uploaded to Modal to be parsed. The reader
says so plainly: the badge reads `☁ accurate` rather than `✓ accurate`, and a
standing warning names the host. Use it when the speed is worth it and the paper
is not sensitive; keep the local service for anything else.

Measured on the papers in this repo (11 pages each):

| | local CPU | Modal A10G |
| --- | --- | --- |
| `fireplace.pdf` | 145 s | **3.4 s** |
| `2025.naacl-demo.30.pdf` | 145–460 s | **3.4 s** |

End to end through the browser, including upload and container start, a cold
call lands at roughly 10–20 s; most of that is uploading a 15 MB file.

There is no page-by-page progress from the GPU service — it finishes before the
readout would be useful — so the reader falls back to an elapsed-seconds counter
for remote endpoints.


### Checking it really is on the GPU

`GET /diag` asks the GPU class itself, starting a container if none is warm:

```json
{ "ran_on": "Parser (GPU class)", "requested_gpu": "A10G",
  "cuda_available": true, "device": "NVIDIA A10",
  "torch": "2.14.0+cu130", "container_id": "ta-…" }
```

Two things to know if you go looking in the logs:

- **A cached result never reaches the GPU.** `/parse` checks the content hash in
  the Modal volume first and returns immediately, so re-parsing the same paper
  shows no `[Parser]` activity at all. That is the cache working, not a bug — to
  force a real run, change a byte in the file or clear the volume.
- **The web container has no torch.** It only serves HTTP; the GPU class does the
  work. So anything a `@modal.method()` returns must be plain builtins — a
  `torch.__version__` (a `str` subclass) comes back as
  `DeserializationError: the 'torch' module is not available`. `convert()` returns
  plain dicts, which is why parsing was unaffected.

Docling's accelerator is pinned to CUDA explicitly rather than left on `AUTO`:
silently falling back to CPU inside a GPU container costs the money and gives
none of the speed.
