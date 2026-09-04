"""
Focus Reader parsing service, on a GPU, via Modal.

Same contract as the local `server.py` — `GET /health` and `POST /parse`, both
returning the same JSON — so the reader only needs its service URL changed.

    modal deploy modal_app.py

**This one is not local.** The PDF is uploaded to Modal to be parsed. The local
sidecar exists precisely so you do not have to do that; use this when you want
the speed of a GPU and the document is not sensitive.

Layout inference is GPU-bound, which is the whole point: the same paper that
takes minutes on a laptop CPU takes seconds here. Model weights are baked into
the image at build time so a cold start does not also download them.
"""

# NOTE: deliberately no `from __future__ import annotations` here. FastAPI's
# route types are imported inside web(), and stringised annotations leave
# `UploadFile` as an unresolvable forward reference at request-validation time.

import hashlib
import io
import json
import logging
import os
import time
from typing import Any

import modal

APP_NAME = "focus-reader-parser"
GPU = os.environ.get("FOCUSREADER_GPU", "A10G")
MODEL_CACHE = "/models"          # baked into the image
RESULT_CACHE = "/cache"          # persisted between runs

log = logging.getLogger("focusreader.modal")

# Docling reads its weights from HF_HOME; point it at the baked-in copy.
image = (
    modal.Image.debian_slim(python_version="3.12")
    .apt_install("libgl1", "libglib2.0-0")
    .pip_install(
        "docling==2.125.0",
        "fastapi[standard]",
        "pypdfium2",
    )
    .env({"HF_HOME": MODEL_CACHE, "TORCH_HOME": MODEL_CACHE})
    # Fetch the layout + table models at build time. Without this every cold
    # start pays a multi-hundred-MB download before it can parse anything.
    .run_commands(
        "python -c \"from docling.document_converter import DocumentConverter; DocumentConverter()\""
    )
)

app = modal.App(APP_NAME)
cache_volume = modal.Volume.from_name("focus-reader-cache", create_if_missing=True)

with image.imports():
    from docling.datamodel.base_models import DocumentStream
    from docling.document_converter import DocumentConverter


@app.cls(
    image=image,
    gpu=GPU,
    volumes={RESULT_CACHE: cache_volume},
    scaledown_window=300,     # keep warm briefly; a reader opens papers in bursts
    timeout=1800,
    max_containers=2,
)
@modal.concurrent(max_inputs=1)   # one conversion at a time, as the local one does
class Parser:
    @modal.enter()
    def load(self) -> None:
        import torch
        from docling.datamodel.pipeline_options import (
            AcceleratorDevice,
            AcceleratorOptions,
            PdfPipelineOptions,
        )
        from docling.document_converter import PdfFormatOption
        from docling.datamodel.base_models import InputFormat

        self.cuda = torch.cuda.is_available()
        self.device_name = torch.cuda.get_device_name(0) if self.cuda else "cpu"
        print(f"[Parser] cuda={self.cuda} device={self.device_name} torch={torch.__version__}")

        # Do not leave this to AUTO: if it silently picks CPU inside a GPU
        # container you pay for the GPU and get none of the speed.
        opts = PdfPipelineOptions()
        opts.accelerator_options = AcceleratorOptions(
            device=AcceleratorDevice.CUDA if self.cuda else AcceleratorDevice.CPU,
            num_threads=8,
        )
        t0 = time.time()
        self.converter = DocumentConverter(
            format_options={InputFormat.PDF: PdfFormatOption(pipeline_options=opts)}
        )
        print(f"[Parser] docling ready in {time.time() - t0:.1f}s on {self.device_name}")

    @modal.method()
    def info(self) -> dict[str, Any]:
        """Proof of what is actually running, from inside the GPU container."""
        import torch

        # Plain builtins only: the web container has no torch, so anything
        # torch-typed (even TorchVersion, a str subclass) fails to deserialize.
        return {
            "ran_on": "Parser (GPU class)",
            "requested_gpu": str(GPU),
            "cuda_available": bool(self.cuda),
            "device": str(self.device_name),
            "torch": str(torch.__version__),
            "torch_cuda_build": str(torch.version.cuda),
            "container_id": str(os.environ.get("MODAL_TASK_ID", "?")),
        }

    @modal.method()
    def convert(self, data: bytes, filename: str) -> dict[str, Any]:
        """Convert a whole document. Returns the same shape as server.py."""
        t0 = time.time()
        source = DocumentStream(name=filename, stream=io.BytesIO(data))
        doc = self.converter.convert(source).document
        blocks = _blocks(doc)
        elapsed = time.time() - t0
        print(f"parsed {filename}: {len(blocks)} blocks in {elapsed:.1f}s")
        return {
            "parser": "docling-gpu",
            "seconds": round(elapsed, 2),
            "pages": [
                {"width": w, "height": h} for _, (w, h) in sorted(page_sizes(doc).items())
            ],
            "blocks": blocks,
        }


# ---------------------------------------------------------------------------
# Structure extraction — kept identical to the local server so the reader gets
# the same block kinds and boxes from either service.
# ---------------------------------------------------------------------------

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


def page_sizes(doc: Any) -> dict[int, tuple[float, float]]:
    sizes: dict[int, tuple[float, float]] = {}
    for no, page in getattr(doc, "pages", {}).items():
        size = getattr(page, "size", None)
        if size is not None:
            sizes[int(no)] = (float(size.width), float(size.height))
    return sizes


def _normalise(bbox: Any, width: float, height: float) -> dict[str, float] | None:
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
    sizes = page_sizes(doc)
    out: list[dict[str, Any]] = []
    for item, _level in doc.iterate_items():
        label = str(getattr(item, "label", "") or "").lower()
        role, heading = ROLE.get(label, ("prose", 0))
        if role == "skip":
            continue
        text = (getattr(item, "text", "") or "").strip()
        if role == "table" and not text:
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
                "page": page_no - 1,
                "kind": role,
                "heading": heading if role == "heading" else 0,
                "text": text,
                "box": box,
            }
        )
    return out


# ---------------------------------------------------------------------------
# HTTP surface — mirrors server.py so the browser client is unchanged.
# ---------------------------------------------------------------------------

web_image = modal.Image.debian_slim(python_version="3.12").pip_install("fastapi[standard]")


@app.function(image=web_image, volumes={RESULT_CACHE: cache_volume}, timeout=1800)
@modal.concurrent(max_inputs=20)
@modal.asgi_app()
def web():
    from fastapi import FastAPI, File, HTTPException, UploadFile
    from fastapi.middleware.cors import CORSMiddleware

    api = FastAPI(title="Focus Reader parser (Modal)")
    # The reader is served from a local static server, so it is cross-origin.
    api.add_middleware(
        CORSMiddleware,
        allow_origin_regex=r"^https?://(localhost|127\.0\.0\.1)(:\d+)?$",
        allow_methods=["GET", "POST"],
        allow_headers=["*"],
    )
    MAX_BYTES = 80 * 1024 * 1024

    def cache_path(digest: str) -> str:
        return os.path.join(RESULT_CACHE, f"{digest}.json")

    @api.get("/health")
    def health() -> dict[str, Any]:
        # The GPU container starts on demand; the web endpoint is always up.
        return {
            "ok": True,
            "parser": "docling-gpu",
            "docling": True,
            "state": "ready",
            "busy": 0,
            "queued": 0,
            "remote": True,
            "gpu": GPU,
            "progress": None,
            "detail": None,
        }

    @api.get("/diag")
    async def diag() -> dict[str, Any]:
        """Ask the GPU class what it is actually running on. This starts a
        container if none is warm, so it is a real end-to-end check."""
        return await Parser().info.remote.aio()

    @api.post("/parse")
    async def parse(file: UploadFile = File(...)) -> dict[str, Any]:
        data = await file.read()
        if not data:
            raise HTTPException(400, "empty upload")
        if len(data) > MAX_BYTES:
            raise HTTPException(413, "file too large")

        digest = hashlib.sha256(data).hexdigest()
        path = cache_path(digest)
        try:
            cache_volume.reload()
            if os.path.isfile(path):
                with open(path) as fh:
                    return {**json.load(fh), "cached": True}
        except Exception:
            pass

        try:
            # .aio — the blocking form would stall this container's event loop
            # for the whole conversion, so /health could not answer during it.
            payload = await Parser().convert.remote.aio(data, file.filename or "paper.pdf")
        except Exception as exc:
            raise HTTPException(500, f"{type(exc).__name__}: {exc}") from exc

        try:
            os.makedirs(RESULT_CACHE, exist_ok=True)
            with open(path, "w") as fh:
                json.dump(payload, fh)
            cache_volume.commit()
        except Exception:
            pass
        return {**payload, "cached": False}

    return api
