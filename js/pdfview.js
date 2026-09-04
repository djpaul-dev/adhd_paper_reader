/* ============================================================
   pdfview.js — load a PDF, render pages, extract structured text
   Exposes FR.pdf with:
     load(file)            -> parses; fills FR.pdf.paragraphs / .sections
     renderPages(container) -> draws canvases into page view
   ============================================================ */
(function () {
  // PDF.js is loaded as a module from index.html, so it arrives asynchronously;
  // resolve it when a document is opened rather than at script-evaluation time.
  const getLib = async () => {
    const lib = await (window.pdfjsReady || Promise.resolve(window.pdfjsLib));
    if (!lib) throw new Error("PDF.js could not be loaded (offline?)");
    return lib;
  };

  const KNOWN_HEADING_RE = new RegExp(
    "^(" +
      "abstract|introduction|related work|prior work|background|preliminaries|" +
      "motivation|problem statement|methodology|methods?|approach|the model|model|" +
      "experimental setup|experiments?|evaluation|results?|analysis|ablations?|" +
      "discussion|limitations?|threats to validity|conclusions?|" +
      "future work|acknowledge?ments?|references|bibliography|appendix|" +
      "supplementary material|contributions?" +
    ")([:.]| and | & |\\s*$)",
    "i"
  );
  // "3 Method", "3.1 Block segmentation", "IV. Results".
  // The title after the number MUST start with a capital and contain no sentence
  // punctuation — otherwise prose tails like "44 percent." get read as headings.
  const NUM_HEADING_RE = /^(\d{1,2})((?:\.\d{1,2}){0,3})[.)]?\s+([A-Z][A-Za-z0-9][^.!?]{0,68})$/;
  const ROMAN_HEADING_RE = /^([IVXL]{1,5})[.)]\s+([A-Z][A-Za-z0-9][^.!?]{0,68})$/;

  const median = (arr) => {
    if (!arr.length) return 0;
    const s = [...arr].sort((a, b) => a - b);
    return s[Math.floor(s.length / 2)];
  };
  const percentile = (arr, p) => {
    if (!arr.length) return 0;
    const s = [...arr].sort((a, b) => a - b);
    return s[Math.min(s.length - 1, Math.floor(p * s.length))];
  };

  function headingLevel(text, opts = {}) {
    const t = text.trim();
    if (!t || t.length > 90) return 0;
    const words = t.split(/\s+/);
    const num = t.match(NUM_HEADING_RE);
    if (num && words.length <= 14) {
      const depth = (num[1] + (num[2] || "")).split(".").filter(Boolean).length;
      return Math.min(3, Math.max(1, depth));
    }
    if (ROMAN_HEADING_RE.test(t) && words.length <= 12) return 1;
    if (KNOWN_HEADING_RE.test(t) && words.length <= 6) return 1;
    // geometrically isolated, short, capitalised, no terminal sentence punctuation
    if (opts.isolated && words.length <= 9 && !/[.,;]$/.test(t) && /^[A-Z(0-9]/.test(t)) {
      const capish = words.filter((w) => /^[A-Z0-9("']/.test(w) || w.length <= 3).length;
      if (capish / words.length >= 0.7) return 2;
    }
    return 0;
  }

  /* ============================================================
     Sentence segmentation
     A period is only a sentence end if it is followed by a space and
     something that starts like a sentence, and isn't part of an
     abbreviation, an initial ("J. R. Anderson") or a decimal ("0.6").
     ============================================================ */
  const ABBREV_RE = new RegExp(
    "(?:^|[\\s(\\[])(?:[A-Za-z]|et al|e\\.g|i\\.e|cf|vs|viz|Dr|Mr|Mrs|Ms|Prof|" +
      "Fig|Figs|Eq|Eqs|Sec|Secs|Ch|Tab|Ref|Refs|No|Vol|pp|approx|est|" +
      "Inc|Ltd|Co|St|Jr|Sr|resp|etc|al|vs|ca|cf" +
    ")\\.$"
  );
  let lastGutterStats = null; // diagnostics for debugPage
  const MIN_SENTENCE = 24; // shorter fragments fold into the previous one
  const CAPTION_RE = /^(figure|fig\.?|table|chart|algorithm|listing|scheme)\s*\.?\s*\d/i;

  function splitSentences(text) {
    const found = [];
    const push = (s, e) => {
      while (s < e && /\s/.test(text[s])) s++;
      while (e > s && /\s/.test(text[e - 1])) e--;
      if (e > s) found.push({ start: s, end: e });
    };

    let start = 0;
    for (let i = 0; i < text.length; i++) {
      if (text[i] !== "." && text[i] !== "!" && text[i] !== "?") continue;
      let j = i + 1;
      while (j < text.length && /["'’”)\]]/.test(text[j])) j++;
      if (j >= text.length) break;
      if (!/\s/.test(text[j])) continue;             // "0.6", "e.g.", "et.al"
      const next = text.slice(j).match(/^\s+(\S)/);
      if (!next) break;
      if (!/[A-Z“"'(\[]/.test(next[1])) continue;    // next must open a sentence
      if (ABBREV_RE.test(text.slice(start, i + 1))) continue;
      push(start, j);
      start = j;
    }
    push(start, text.length);

    // fold stubs ("See Fig. 2.") into their neighbour so the voice doesn't stutter
    const out = [];
    for (const s of found) {
      const prev = out[out.length - 1];
      if (prev && s.end - s.start < MIN_SENTENCE) prev.end = s.end;
      else out.push(s);
    }
    if (!out.length) out.push({ start: 0, end: text.length });
    return out.map((s) => ({ ...s, text: text.slice(s.start, s.end) }));
  }

  /* Where does [start,end) of a block's text sit on the page?
     Returns the full-width line span to frame, plus tight rectangles marking
     the sentence's real extent (partial first line, whole middles, partial last). */
  function unitGeometry(b, start, end) {
    const covered = (b.lineRanges || []).filter((r) => r.end > start && r.start < end);
    if (!covered.length) return { box: b.box, marks: [] };

    const marks = [];
    for (const r of covered) {
      const ln = b.lines[r.line];
      if (!ln) continue;
      const len = Math.max(1, r.end - r.start);
      const a = Math.max(0, start - r.start) / len;
      const z = Math.min(1, (end - r.start) / len);
      if (z - a > 0.01) marks.push({ x: ln.x + ln.w * a, y: ln.y, w: ln.w * (z - a), h: ln.h });
    }
    const ls = covered.map((r) => b.lines[r.line]).filter(Boolean);
    if (!ls.length) return { box: b.box, marks };
    const x = Math.min(...ls.map((l) => l.x));
    const y = Math.min(...ls.map((l) => l.y));
    return {
      box: {
        x,
        y,
        w: Math.max(...ls.map((l) => l.x + l.w)) - x,
        h: Math.max(...ls.map((l) => l.y + l.h)) - y,
      },
      marks,
    };
  }

  /* ---- reconstruct lines from pdf.js text items ----
     Two-column papers put left- and right-column lines on the SAME baseline,
     so we can't just sort by y. Instead we build line *fragments*, breaking a
     line wherever the horizontal gap between glyphs is far wider than a space
     (i.e. the gutter), then cluster the fragments into columns by their left
     edge and emit column by column in true reading order.                     */
  function itemsToLines(items, vpWidth, vpHeight, hintSplitX) {
    const toks = items
      .filter((it) => {
        if (!it.str || !it.str.trim().length) return false;
        /* Skip anything not running left-to-right. A sideways arXiv stamp down
           the margin has a rotated text matrix, so its width lands on the wrong
           axis and it reads as one very wide line — which then swallows a whole
           column into its block and wrecks the reading order. */
        const [a, b, c, d] = it.transform;
        return Math.abs(a) >= Math.abs(b) && Math.abs(d) >= Math.abs(c);
      })
      .map((it) => ({
        x: it.transform[4],
        y: it.transform[5],
        w: it.width || 0,
        h: Math.abs(it.transform[3]) || it.height || 10,
        str: it.str,
        eol: !!it.hasEOL,
      }));
    if (!toks.length) return [];

    // ---- 1. line fragments, split on gutter-sized horizontal gaps ----
    // Quantised y keeps the comparator a strict weak ordering (a raw
    // tolerance compare is non-transitive and lets V8 scramble the array).
    const band = (y) => Math.round(y / 3);
    toks.sort((a, b) => band(b.y) - band(a.y) || a.x - b.x);

    /* Where does a gap stop being a word space and start being a column gutter?
       A fixed fraction of the page width is wrong: papers with a tight gutter
       fall under it, and then the left and right columns MERGE into one line —
       which no later column detection can undo. Measure this page's own word
       spaces instead and split well above them. */
    const sameLine = (a, b) =>
      Math.abs(a.y - b.y) <= Math.max(2.5, Math.min(a.h, b.h) * 0.5);
    /* Justified text stretches its spaces, but not past about one glyph
       height; a column gutter is comfortably wider than that. Scale off the
       type size, not the page width — a fixed fraction of the width is far too
       coarse and merges the columns of any paper with a tight gutter.

       Bias towards splitting: an over-split line is harmless (the pieces share
       a baseline, sort back together and rejoin with a space), whereas a
       merged one fuses the two columns into a single string that no later
       stage can pull apart. */
    const glyphH = median(toks.map((t) => t.h)) || 10;
    const GUTTER_GAP = Math.min(vpWidth * 0.06, Math.max(glyphH, 5));
    lastGutterStats = { glyphH: +glyphH.toFixed(2), gutterGap: +GUTTER_GAP.toFixed(2) };

    const frags = [];
    let cur = null;
    for (const t of toks) {
      const dx = cur ? t.x - cur.right : 0;
      const sameBand =
        cur && Math.abs(cur.y - t.y) <= Math.max(2.5, Math.min(cur.h, t.h) * 0.5);
      // text must also run left-to-right: sorting by y interleaves the columns
      // of a two-column page, and without this a left-column line gets swallowed
      // by the right-column fragment that happens to share its baseline.
      const continues = dx > -Math.min(cur ? cur.h : 0, t.h) && dx <= GUTTER_GAP;
      if (sameBand && continues) {
        if (dx > t.h * 0.25 && !/\s$/.test(cur.str)) cur.str += " ";
        cur.str += t.str;
        cur.right = Math.max(cur.right, t.x + t.w);
        cur.h = Math.max(cur.h, t.h);
      } else {
        if (cur) frags.push(cur);
        cur = { y: t.y, x: t.x, right: t.x + t.w, h: t.h, str: t.str };
      }
      if (cur && t.eol) { frags.push(cur); cur = null; }
    }
    if (cur) frags.push(cur);

    // ---- 2. drop running headers / footers / bare page numbers ----
    const topEdge = vpHeight * 0.94;
    const botEdge = vpHeight * 0.06;
    return frags
      .map((l) => ({ ...l, str: l.str.replace(/\s+/g, " ").trim() }))
      .filter((l) => {
        if (!l.str) return false;
        if (/^\d{1,4}$/.test(l.str)) return false; // bare page number
        const wc = l.str.split(/\s+/).length;
        if ((l.y > topEdge || l.y < botEdge) && wc <= 8 && !/[.!?]$/.test(l.str)) return false;
        return true;
      });
  }

  /* ============================================================
     Region segmentation — recursive XY-cut

     A single column split per page cannot survive a paper that
     interrupts its own grid (a full-width table or figure between
     two-column bands). Instead we recursively carve the page along
     whitespace channels that no text crosses:

       · a *vertical* channel is a column gutter        -> cut, read left then right
       · a *horizontal* channel is a structural break   -> cut, read top then bottom

     Columns are tried first at every node: a gutter that runs the
     full height of the region it splits is unambiguous, whereas a
     horizontal band can line up by coincidence across two columns
     and would interleave them.

     Recursion stops at a region that is a table or a figure, which
     stays whole so the spotlight treats it as one stop.
     ============================================================ */
  /* Channels along one axis that no box crosses.
     `pick` is "widest" for gutters (the biggest clear channel is the column
     boundary) but "first" for horizontal bands: a page reads top to bottom, and
     taking the widest gap instead can slice through the middle of a figure —
     splitting it in two, after which neither half is recognisable as one. */
  function allGaps(bs, lo, hi, minSize) {
    if (bs.length < 2) return [];
    const iv = bs.map((b) => [lo(b), hi(b)]).sort((a, b) => a[0] - b[0]);
    const out = [];
    let reach = iv[0][1];
    for (let i = 1; i < iv.length; i++) {
      const size = iv[i][0] - reach;
      if (size >= minSize) out.push({ start: reach, end: iv[i][0], size });
      reach = Math.max(reach, iv[i][1]);
    }
    return out; // in ascending order of position
  }
  function widestGap(bs, lo, hi, minSize) {
    let best = null;
    for (const g of allGaps(bs, lo, hi, minSize)) if (!best || g.size > best.size) best = g;
    return best;
  }

  /* Reading order for a set of already-identified regions.

     Layout models are strong at saying what a region *is* and weak at saying
     when to read it — on a page whose grid is interrupted they routinely emit
     the title after the abstract, or interleave a three-column block with the
     section under it. The regions themselves are few and rectangular, so the
     same whitespace recursion that segments a page orders them reliably. */
  function orderByLayout(items) {
    const out = [];
    // boxes are normalised (0..1 of the page) on both axes
    const MIN_X = 0.012;
    const MIN_Y = 0.004;
    const flushSorted = (bs) =>
      bs.slice().sort((a, b) => a.y0 - b.y0 || a.x0 - b.x0).forEach((b) => out.push(b.ref));

    (function cut(bs, depth) {
      if (bs.length <= 1 || depth > 16) return flushSorted(bs);

      const v = widestGap(bs, (b) => b.x0, (b) => b.x1, MIN_X);
      if (v) {
        const left = bs.filter((b) => b.x1 <= v.start);
        const right = bs.filter((b) => b.x0 >= v.end);
        if (left.length && right.length && left.length + right.length === bs.length) {
          cut(left, depth + 1);
          cut(right, depth + 1);
          return;
        }
      }
      const h = widestGap(bs, (b) => b.y0, (b) => b.y1, MIN_Y);
      if (h) {
        const top = bs.filter((b) => b.y1 <= h.start);
        const bot = bs.filter((b) => b.y0 >= h.end);
        if (top.length && bot.length && top.length + bot.length === bs.length) {
          cut(top, depth + 1);
          cut(bot, depth + 1);
          return;
        }
      }
      flushSorted(bs);
    })(items, 0);

    return out;
  }

  function segmentRegions(frags, W) {
    if (!frags.length) return [];

    // work top-down so "first" means "higher on the page"
    const boxes = frags.map((f) => ({
      f,
      x0: f.x,
      x1: f.right,
      y0: -f.y - f.h,
      y1: -f.y + f.h * 0.3,
    }));

    const medH = median(boxes.map((b) => b.y1 - b.y0)) || 10;
    // Boxes already span ascender to descender, so consecutive lines of a
    // paragraph leave almost no gap. Half a line of clear space is therefore
    // already a structural break (the margin around a figure or table).
    const byTop = boxes.slice().sort((a, b) => a.y0 - b.y0);
    const pitches = [];
    for (let i = 1; i < byTop.length; i++) {
      const d = byTop[i].y0 - byTop[i - 1].y0;
      if (d > 0.5 && d < medH * 3) pitches.push(d);
    }
    const pitch = median(pitches) || medH;
    const MIN_GAP_Y = Math.max(pitch * 0.55, 3);
    const MIN_GAP_X = Math.max(W * 0.018, 6);
    const regions = [];

    // group boxes that share a baseline — a "row"
    const rowsOf = (bs) => {
      const sorted = bs.slice().sort((a, b) => a.y0 - b.y0 || a.x0 - b.x0);
      const rows = [];
      let cur = null;
      for (const b of sorted) {
        if (cur && Math.abs(b.y0 - cur[0].y0) <= (b.y1 - b.y0) * 0.6) cur.push(b);
        else rows.push((cur = [b]));
      }
      return rows;
    };

    const spanX = (bs) =>
      Math.max(1, Math.max(...bs.map((b) => b.x1)) - Math.min(...bs.map((b) => b.x0)));
    const spanY = (bs) =>
      Math.max(1, Math.max(...bs.map((b) => b.y1)) - Math.min(...bs.map((b) => b.y0)));

    /* A plot, a diagram, a schematic: a few small labels scattered over a large
       area. Running text fills its bounding box — a graphic barely marks it.
       Density catches figures that carry a long caption, which a
       "every label is short" test misses. */
    const looksLikeGraphic = (bs) => {
      if (bs.length < 4) return false;
      const w = spanX(bs);
      const h = spanY(bs);
      if (h < pitch * 2.5) return false; // too shallow to judge
      const ink = bs.reduce((s, b) => s + (b.x1 - b.x0) * (b.y1 - b.y0), 0);
      return ink / (w * h) < 0.25 && median(bs.map((b) => b.x1 - b.x0)) < w * 0.35;
    };

    // A plot's axis labels: nothing but short strings scattered across a wide
    // area. Safe to test before cutting, because any region containing real
    // prose has long lines and fails immediately.
    const looksLikeFigure = (bs) => {
      if (bs.length < 5) return false;
      if (bs.some((b) => b.f.str.length > 24)) return false;
      const short = bs.filter((b) => b.f.str.length < 16).length / bs.length;
      return short >= 0.8 && median(bs.map((b) => b.x1 - b.x0)) < spanX(bs) * 0.3;
    };

    // A table's rows hold several NARROW cells. Three columns of running text
    // also put three fragments on a row, so cell width (or a lot of digits)
    // is what separates a table from a multi-column layout.
    const looksLikeTable = (bs) => {
      if (bs.length < 6) return false;
      const rows = rowsOf(bs);
      if (rows.length < 3 || median(rows.map((r) => r.length)) < 3) return false;
      // Running prose is never a table. A pseudocode listing has enough short
      // numbered rows to pass every other test, and if it is still mixed in
      // with body text this would swallow the whole page into one block.
      const w = spanX(bs);
      const proseLines = bs.filter((b) => b.x1 - b.x0 > w * 0.45).length;
      if (proseLines > bs.length * 0.15) return false;
      const medW = median(bs.map((b) => b.x1 - b.x0));
      const txt = bs.map((b) => b.f.str).join("");
      const digits = (txt.match(/[0-9]/g) || []).length / Math.max(1, txt.length);
      return medW < w * 0.25 || digits > 0.18;
    };

    /* Scan the region's rows for ink. Running text fills most of the width on
       every row; a plot marks only a few percent. A tall enough run of empty
       rows is artwork — but a single short line (a heading ending a column)
       is not, which is why the run has to be several lines deep. */
    const firstSparseBand = (bs) => {
      const top = Math.min(...bs.map((b) => b.y0));
      const bottom = Math.max(...bs.map((b) => b.y1));
      const width = spanX(bs);
      const step = Math.max(2, pitch / 2);
      const rows = Math.ceil((bottom - top) / step);
      if (rows < 8) return null;

      const ink = new Array(rows).fill(0);
      for (const b of bs) {
        const from = Math.max(0, Math.floor((b.y0 - top) / step));
        const to = Math.min(rows - 1, Math.floor((b.y1 - top) / step));
        for (let i = from; i <= to; i++) ink[i] += b.x1 - b.x0;
      }
      const dense = ink.map((v) => v / width >= 0.45);

      const minRows = Math.ceil((pitch * 3) / step);
      for (let i = 0; i < rows; i++) {
        if (dense[i]) continue;
        let j = i;
        while (j < rows && !dense[j]) j++;
        // A paragraph's last line is short, so it reads as sparse too. Start the
        // band at the first genuinely empty row instead, or the line above the
        // figure gets swallowed into it.
        let k = i;
        while (k < j && ink[k] > 0) k++;
        // a sparse run touching the region edge is just the margin, not artwork
        if (k < j && j - k >= minRows && k > 0 && j < rows) {
          return { y0: top + k * step, y1: top + j * step };
        }
        i = j;
      }
      return null;
    };

    /* The x where the fewest boxes cross — the gutter the columns would have
       if a title or a figure were not lying across it. Returns null unless
       both sides hold real columns and only a minority of boxes cross. */
    const nearGutter = (bs) => {
      const x0 = Math.min(...bs.map((b) => b.x0));
      const width = spanX(bs);
      let best = null;
      for (let i = 10; i <= 30; i++) {
        const x = x0 + (width * i) / 40;
        const left = [], right = [];
        let cross = 0;
        for (const b of bs) {
          if (b.x0 < x && b.x1 > x) cross++;
          else if (b.x1 <= x) left.push(b);
          else right.push(b);
        }
        if (left.length < 3 || right.length < 3) continue;
        if (spanX(left) < width * 0.15 || spanX(right) < width * 0.15) continue;
        if (!best || cross < best.cross) best = { x, cross };
      }
      return best && best.cross <= bs.length * 0.35 ? best.x : null;
    };

    // reject a "gutter" that would shear off a sliver — real columns are wide
    const okColumnCut = (bs, gap) => {
      const left = bs.filter((b) => b.x1 <= gap.start);
      const right = bs.filter((b) => b.x0 >= gap.end);
      if (left.length < 3 || right.length < 3) return false;
      const span = (g) => Math.max(...g.map((b) => b.x1)) - Math.min(...g.map((b) => b.x0));
      const whole = span(bs);
      return span(left) >= whole * 0.15 && span(right) >= whole * 0.15;
    };

    const emit = (bs, kind) => {
      if (!bs.length) return;
      regions.push({
        kind,
        lines: bs.slice().sort((a, b) => a.y0 - b.y0 || a.x0 - b.x0).map((b) => b.f),
      });
    };

    const X0 = (b) => b.x0, X1 = (b) => b.x1;
    const Y0 = (b) => b.y0, Y1 = (b) => b.y1;

    (function cut(bs, depth) {
      if (!bs.length) return;
      if (bs.length === 1 || depth > 14) return emit(bs, "prose");

      if (looksLikeFigure(bs) || looksLikeGraphic(bs)) {
        // a caption sitting under the artwork is prose worth reading on its
        // own, not another axis label
        const capTop = Math.min(
          ...bs.filter((b) => CAPTION_RE.test(b.f.str)).map((b) => b.y0),
          Infinity
        );
        const art = bs.filter((b) => b.y0 < capTop);
        const caption = bs.filter((b) => b.y0 >= capTop);
        if (art.length >= 3 && caption.length) {
          emit(art, "figure");
          cut(caption, depth + 1);
          return;
        }
        return emit(bs, "figure");
      }

      // A gutter here spans the region's whole height, so nothing crosses it:
      // that is a genuine column boundary and it outranks any horizontal band
      // break, which could otherwise be a coincidence across the two columns.
      const v = widestGap(bs, X0, X1, MIN_GAP_X);
      const canColumn = !!v && okColumnCut(bs, v);

      // No clean gutter means something full-width interrupts the grid (a
      // table, a figure, a spanning title). Slice that band off first, then
      // let each band find its own columns.
      if (!canColumn) {
        /* Artwork first. A run of rows carrying almost no ink is a figure, and
           the gaps *inside* it are wider than the gap separating it from the
           text — so a plain gap cut slices it in half and neither piece is
           recognisable as artwork afterwards. Lift the band out whole. */
        const band = firstSparseBand(bs);
        if (band) {
          const mid = (b) => (b.y0 + b.y1) / 2;
          const above = bs.filter((b) => mid(b) < band.y0);
          const inside = bs.filter((b) => mid(b) >= band.y0 && mid(b) < band.y1);
          const below = bs.filter((b) => mid(b) >= band.y1);
          // Only lift the band out if what is in it really is artwork. A lone
          // short heading stranded in a gap is sparse too, and must stay with
          // the column it belongs to.
          const isArt =
            inside.length >= 3 &&
            (looksLikeGraphic(inside) || looksLikeFigure(inside) || looksLikeTable(inside));
          if (isArt && above.length + below.length) {
            if (above.length) cut(above, depth + 1);
            cut(inside, depth + 1);
            if (below.length) cut(below, depth + 1);
            return;
          }
        }
        // otherwise the topmost band break — a page reads top to bottom
        const h = allGaps(bs, Y0, Y1, MIN_GAP_Y)[0];
        if (h) {
          cut(bs.filter((b) => b.y1 <= h.start), depth + 1);
          cut(bs.filter((b) => b.y0 >= h.end), depth + 1);
          return;
        }
      }

      // The region is now a single band — safe to judge what it is.
      if (looksLikeTable(bs)) return emit(bs, "table");

      if (canColumn) {
        cut(bs.filter((b) => b.x1 <= v.start), depth + 1);
        cut(bs.filter((b) => b.x0 >= v.end), depth + 1);
        return;
      }

      /* Neither a clean gutter nor a clear band — which happens when a
         full-width title sits directly on top of two columns with no gap
         wide enough to cut at. Find the gutter the columns *nearly* have,
         lift out the few things that cross it, and read the bands between
         them. Without this the whole region is emitted as one lump and the
         two columns interleave. */
      const gx = nearGutter(bs);
      if (gx != null) {
        const straddles = (b) => b.x0 < gx && b.x1 > gx;
        const crossing = bs.filter(straddles).sort((a, b) => a.y0 - b.y0);
        const rest = bs.filter((b) => !straddles(b));
        if (crossing.length && rest.length) {
          const runs = [];
          for (const s of crossing) {
            const last = runs[runs.length - 1];
            if (last && s.y0 - last[last.length - 1].y1 <= MIN_GAP_Y) last.push(s);
            else runs.push([s]);
          }
          const midY = (b) => (b.y0 + b.y1) / 2;
          const band = (lo, hi) => {
            const inBand = rest.filter((b) => midY(b) >= lo && midY(b) < hi);
            if (inBand.length) cut(inBand, depth + 1);
          };
          let prev = -Infinity;
          for (const run of runs) {
            const edge = (run[0].y0 + run[run.length - 1].y1) / 2;
            band(prev, edge);
            cut(run, depth + 1);
            prev = edge;
          }
          band(prev, Infinity);
          return;
        }
      }
      emit(bs, "prose");
    })(boxes, 0);

    return regions;
  }

  /* Turn a run of line fragments into one block: the joined text, the slice of
     that text each line contributed (so a sentence maps back to page
     rectangles), and the normalised bounding box. Shared by the geometric
     parser and the sidecar parser. */
  function makeBlock(lines, pageIndex, W, H, opts = {}) {
    if (!lines.length) return null;

    let text = "";
    const lineRanges = [];
    lines.forEach((l, i) => {
      const s = l.str.replace(/\s+/g, " ").trim();
      if (!s) return;
      let joiner = text ? " " : "";
      // a word broken across lines is rejoined; a hyphen before a capital or
      // digit is a real one ("COVID-19") and survives
      if (text && /[a-z]-$/.test(text) && /^[a-z]/.test(s)) {
        text = text.slice(0, -1);
        if (lineRanges.length) lineRanges[lineRanges.length - 1].end -= 1;
        joiner = "";
      }
      const start = text.length + joiner.length;
      text += joiner + s;
      lineRanges.push({ line: i, start, end: text.length });
    });
    if (text.length <= 1) return null;

    const nlines = lines.map((l) => ({
      text: l.str,
      x: l.x / W,
      y: (H - l.y - l.h) / H,
      w: (l.right - l.x) / W,
      h: (l.h * 1.25) / H,
    }));
    const box = {
      x: Math.min(...nlines.map((n) => n.x)),
      y: Math.min(...nlines.map((n) => n.y)),
    };
    box.w = Math.max(...nlines.map((n) => n.x + n.w)) - box.x;
    box.h = Math.max(...nlines.map((n) => n.y + n.h)) - box.y;

    return {
      page: pageIndex,
      text,
      heading: opts.heading || 0,
      kind: opts.kind || "prose",
      box,
      lines: nlines,
      lineRanges,
    };
  }

  // Group lines into blocks using spacing, line-width shortfall and indentation.
  function linesToBlocks(lines, pageIndex, W, H, out, opts = {}) {
    if (!lines.length) return;
    const kind = opts.kind || "prose";

    const colLeft = percentile(lines.map((l) => l.x), 0.08);
    const colRight = percentile(lines.map((l) => l.right), 0.92);
    const charW =
      median(lines.filter((l) => l.str.length > 4).map((l) => (l.right - l.x) / l.str.length)) || 5;
    const gaps = [];
    for (let i = 1; i < lines.length; i++) {
      const g = lines[i - 1].y - lines[i].y;
      if (g > 0 && g < lines[i].h * 4) gaps.push(g);
    }
    const lineGap = median(gaps) || median(lines.map((l) => l.h)) * 1.2 || 12;

    let buf = [];
    const flush = (heading) => {
      if (!buf.length) return;
      const b = makeBlock(buf, pageIndex, W, H, { heading, kind });
      if (b) out.push(b);
      buf = [];
    };

    // A table or a figure is one stop: stepping through it row by row (or
    // axis-label by axis-label) is exactly the "line-by-line" failure.
    if (kind !== "prose") {
      buf = lines.slice();
      flush();
      return;
    }

    const scan = (conservative) => {
      buf = [];
      for (let i = 0; i < lines.length; i++) {
        const ln = lines[i];
        const prev = lines[i - 1];
        const nextY = i + 1 < lines.length ? lines[i + 1].y : -Infinity;

        const gapAbove = prev ? prev.y - ln.y : Infinity;
        const gapBelow = ln.y - nextY;
        const isolated = gapAbove > lineGap * 1.5 && gapBelow > lineGap * 1.5;
        const lvl = headingLevel(ln.str, { isolated });

        // a jump back up the page means a new region — never straddle one
        if (prev && gapAbove < 0 && buf.length) flush();

        if (lvl > 0) {
          flush();
          buf = [ln];
          flush(lvl);
          continue;
        }

        if (prev && buf.length) {
          const bigGap = gapAbove > lineGap * 1.34;
          if (conservative) {
            if (bigGap) flush();
          } else {
            const prevShort = prev.right < colRight - charW * 3.5;
            const startsAtMargin = ln.x <= colLeft + charW * 1.5;
            const startsUpper = /^[A-Z(“"'\[]/.test(ln.str);
            const indented = ln.x > colLeft + charW * 2 && ln.x < colLeft + charW * 14;
            if (bigGap || (prevShort && startsAtMargin && startsUpper) || indented) flush();
          }
        }
        buf.push(ln);
      }
      flush();
    };

    const before = out.length;
    scan(false);
    // If nearly every line became its own block the indent/short-line rules
    // misfired on this region — redo it using only real vertical gaps.
    const produced = out.length - before;
    if (lines.length >= 4 && produced >= lines.length * 0.8) {
      out.length = before;
      scan(true);
    }
  }

  /* ============================================================
     Sidecar structure -> blocks

     A layout model is good at saying *what* the regions are and in
     *what order* to read them, but it reports one box per region.
     The browser already has exact line geometry from PDF.js, which is
     what the spotlight and the sentence marks are drawn from — so we
     keep our geometry and borrow only the structure: each region box
     claims the local line fragments whose centres fall inside it.
     ============================================================ */
  function blocksFromStructure(structure, pages) {
    const out = [];
    const claimed = pages.map(() => new Set());
    let matched = 0;
    const total = pages.reduce((n, p) => n + p.frags.length, 0);
    if (!total) return null;

    const PAD = 0.006; // model boxes hug the ink a little tighter than we do

    for (const sb of structure.blocks || []) {
      const pg = pages[sb.page];
      if (!pg || !sb.box) continue;
      const { W, H, frags } = pg;
      const bx = sb.box;

      const picked = [];
      frags.forEach((f, i) => {
        if (claimed[sb.page].has(i)) return;
        const cx = (f.x + f.right) / 2 / W;
        const cy = (H - f.y - f.h * 0.5) / H; // fragment centre, from the top
        if (
          cx >= bx.x - PAD && cx <= bx.x + bx.w + PAD &&
          cy >= bx.y - PAD && cy <= bx.y + bx.h + PAD
        ) picked.push(i);
      });
      if (!picked.length) continue;

      picked.forEach((i) => claimed[sb.page].add(i));
      matched += picked.length;

      const lines = picked.map((i) => frags[i]).sort((a, b) => b.y - a.y || a.x - b.x);
      const isHeading = sb.kind === "heading";
      const block = makeBlock(lines, sb.page, W, H, {
        heading: isHeading ? sb.heading || 1 : 0,
        kind: isHeading ? "prose" : sb.kind || "prose",
      });
      if (block) out.push(block);
    }

    /* Recover anything the model missed.

       A layout model can simply fail to emit a region — on one ICML paper it
       returned the abstract's left column and nothing at all for the right.
       Dropping the fragments no box claimed loses that text outright, and a
       coverage check does not catch it: that page was still 86% claimed.
       So the leftovers go through the built-in segmenter instead, and the
       reader ends up with the model's structure AND all of the words. */
    let recovered = 0;
    pages.forEach((pg, i) => {
      const leftover = pg.frags.filter((_, k) => !claimed[i].has(k));
      if (!leftover.length) return;
      const found = [];
      for (const region of segmentRegions(leftover, pg.W)) {
        linesToBlocks(region.lines, i, pg.W, pg.H, found, { kind: region.kind });
      }
      recovered += found.length;
      out.push(...found);
    });

    if (!out.length) return null;

    // Only distrust the model outright when it recognised almost nothing.
    const coverage = matched / total;
    if (coverage < 0.25) {
      console.warn("sidecar structure covered only", Math.round(coverage * 100), "% of the text");
      return null;
    }

    /* Order everything — the model's regions and the recovered ones together —
       with our own whitespace cuts. The model's own sequence is not reliable on
       an interrupted grid, and recovered blocks have no place in it at all. */
    const ordered = [];
    const byPage = new Map();
    out.forEach((b) => {
      if (!byPage.has(b.page)) byPage.set(b.page, []);
      byPage.get(b.page).push(b);
    });
    [...byPage.keys()].sort((a, b) => a - b).forEach((pageNo) => {
      const items = byPage.get(pageNo).map((b) => ({
        x0: b.box.x, x1: b.box.x + b.box.w,
        y0: b.box.y, y1: b.box.y + b.box.h,
        ref: b,
      }));
      ordered.push(...orderByLayout(items));
    });

    if (recovered) {
      console.info(`recovered ${recovered} block(s) the layout model did not return`);
    }
    return { blocks: ordered, coverage, recovered };
  }

  FR.pdf = {
    doc: null,
    source: "geometry", // which parser produced the current blocks
    coverage: 1,
    recovered: 0,
    blocks: [],       // { page, text, heading, box:{x,y,w,h}, lines:[...] }  (normalised 0..1)
    paragraphs: [],   // { page, text, heading }  — same order/index as blocks
    units: [],        // reading atoms: { block, nth, text, start, end, box, marks }
    sections: [],     // { id, title, level, para }
    pageSizes: [],     // { w, h } per page at scale 1

    async load(file) {
      const buf = await file.arrayBuffer();
      const lib = await getLib();
      this.doc = await lib.getDocument({ data: buf }).promise;
      this.blocks = [];
      this.paragraphs = [];
      this.sections = [];
      this.pageSizes = [];
      this.source = "geometry";
      this.coverage = 1;
      this.recovered = 0;

      // Ask the sidecar first so the model runs while we extract line geometry.
      const structurePromise =
        FR.sidecar && FR.sidecar.enabled() ? FR.sidecar.parse(file) : Promise.resolve(null);

      // Line geometry is always extracted locally: it is what the spotlight,
      // the sentence marks and the selectable text layer are built from.
      const pages = [];
      for (let p = 1; p <= this.doc.numPages; p++) {
        const page = await this.doc.getPage(p);
        const vp = page.getViewport({ scale: 1 });
        this.pageSizes.push({ w: vp.width, h: vp.height });
        const tc = await page.getTextContent();
        pages.push({
          W: vp.width,
          H: vp.height,
          frags: itemsToLines(tc.items, vp.width, vp.height),
        });
      }

      let structure = null;
      this.sourceReason = "";
      try {
        structure = await structurePromise;
        if (!structure && FR.sidecar && FR.sidecar.enabled()) {
          this.sourceReason =
            {
              timeout: "it took longer than the time limit",
              starting: "it was still loading its models",
            }[FR.sidecar.status] || "the service could not be reached";
        }
      } catch (e) {
        console.warn("sidecar parse failed", e);
        this.sourceReason = "the service returned an error";
      }

      if (structure) {
        const built = blocksFromStructure(structure, pages);
        if (built) {
          this.blocks = built.blocks;
          this.source = structure.parser || "sidecar";
          this.coverage = built.coverage;
          this.recovered = built.recovered || 0;
        } else {
          this.sourceReason = "its layout did not match this file";
        }
      }

      if (!this.blocks.length) {
        // carve each page into regions in true reading order, then split each
        // one using its OWN margins and line spacing
        pages.forEach((pg, i) => {
          for (const region of segmentRegions(pg.frags, pg.W)) {
            linesToBlocks(region.lines, i, pg.W, pg.H, this.blocks, { kind: region.kind });
          }
        });
      }

      this.paragraphs = this.blocks.map((b) => ({
        page: b.page,
        text: b.text,
        heading: b.heading,
      }));

      this.buildUnits(FR.settings.sentenceMode ? "sentence" : "paragraph");
      await this.buildSections();
      return this;
    },

    /* The sequence the reader actually steps through. One sentence per stop
       keeps the spotlight and the narration on the same unit; "paragraph"
       restores whole-paragraph stops. Headings are skipped either way. */
    buildUnits(mode) {
      const units = [];
      let paraNo = 0;
      this.blocks.forEach((b, bi) => {
        if (b.heading) return;
        paraNo++;
        const parts =
          mode === "paragraph"
            ? [{ start: 0, end: b.text.length, text: b.text }]
            : splitSentences(b.text);
        parts.forEach((p, n) => {
          units.push({
            block: bi,
            paraNo,
            nth: n,
            of: parts.length,
            text: p.text,
            start: p.start,
            end: p.end,
            ...unitGeometry(b, p.start, p.end),
          });
        });
      });
      this.units = units;
      this.paraCount = paraNo;
      return units;
    },

    /* Diagnostic: the signals that decide a page's reading order.
       Run FR.pdf.debugPage(2) in the console and paste the result. */
    async debugPage(pageIndex) {
      const page = await this.doc.getPage(pageIndex + 1);
      const vp = page.getViewport({ scale: 1 });
      const tc = await page.getTextContent();
      const items = tc.items.filter((it) => it.str && it.str.trim());
      const frags = itemsToLines(tc.items, vp.width, vp.height);
      const regions = segmentRegions(frags, vp.width);
      // a fragment covering most of the width on a 2-column page means the
      // columns were merged at the line level — the fault would be upstream
      const wide = frags.filter((f) => f.right - f.x > vp.width * 0.6);
      return {
        page: pageIndex + 1,
        pageSize: [Math.round(vp.width), Math.round(vp.height)],
        items: items.length,
        hasEOL: items.filter((it) => it.hasEOL).length,
        gutter: lastGutterStats,
        fragments: frags.length,
        wideFragments: wide.length,
        wideSamples: wide.slice(0, 3).map((f) => f.str.slice(0, 70)),
        regions: regions.map((r) => ({
          kind: r.kind,
          lines: r.lines.length,
          x: [
            +(Math.min(...r.lines.map((l) => l.x)) / vp.width).toFixed(2),
            +(Math.max(...r.lines.map((l) => l.right)) / vp.width).toFixed(2),
          ],
          yTop: +((vp.height - Math.max(...r.lines.map((l) => l.y))) / vp.height).toFixed(2),
          text: r.lines.map((l) => l.str).join(" ").slice(0, 70),
        })),
      };
    },

    /* How the geometric parser carved one page, in reading order. */
    async debugRegions(pageIndex) {
      const page = await this.doc.getPage(pageIndex + 1);
      const vp = page.getViewport({ scale: 1 });
      const tc = await page.getTextContent();
      const frags = itemsToLines(tc.items, vp.width, vp.height);
      return segmentRegions(frags, vp.width).map((r, i) => ({
        i,
        kind: r.kind,
        lines: r.lines.length,
        x0: +(Math.min(...r.lines.map((l) => l.x)) / vp.width).toFixed(3),
        x1: +(Math.max(...r.lines.map((l) => l.right)) / vp.width).toFixed(3),
        yTop: +((vp.height - Math.max(...r.lines.map((l) => l.y))) / vp.height).toFixed(3),
        text: r.lines.map((l) => l.str).join(" ").slice(0, 60),
      }));
    },

    firstUnitOfBlock(blockIndex) {
      const i = this.units.findIndex((u) => u.block >= blockIndex);
      return i < 0 ? Math.max(0, this.units.length - 1) : i;
    },
    unitAt(blockIndex, nth) {
      const i = this.units.findIndex((u) => u.block === blockIndex && u.nth === nth);
      return i < 0 ? this.firstUnitOfBlock(blockIndex) : i;
    },

    async buildSections() {
      const sections = [];
      // 1) prefer the PDF's own outline
      let outline = null;
      try { outline = await this.doc.getOutline(); } catch {}
      if (outline && outline.length) {
        const walk = async (items, level) => {
          for (const it of items) {
            let para = 0;
            try {
              let dest = it.dest;
              if (typeof dest === "string") dest = await this.doc.getDestination(dest);
              if (Array.isArray(dest) && dest[0]) {
                const pageIndex = await this.doc.getPageIndex(dest[0]);
                para = this.firstParaOnPage(pageIndex);
              }
            } catch {}
            sections.push({
              id: "o" + sections.length,
              title: it.title.trim(),
              level: Math.min(3, level),
              para,
            });
            if (it.items && it.items.length) await walk(it.items, level + 1);
          }
        };
        await walk(outline, 1);
      }

      // 2) fall back to detected headings
      if (sections.length < 3) {
        sections.length = 0;
        this.paragraphs.forEach((p, i) => {
          if (p.heading && i > 0) { // i === 0 is the paper's title, not a section
            sections.push({
              id: "h" + i,
              title: p.text,
              level: p.heading,
              para: i,
            });
          }
        });
      }

      // 3) last resort: page markers
      if (sections.length < 2) {
        sections.length = 0;
        let lastPage = -1;
        this.paragraphs.forEach((p, i) => {
          if (p.page !== lastPage && p.page % 2 === 0) {
            sections.push({ id: "p" + i, title: "Page " + (p.page + 1), level: 1, para: i });
            lastPage = p.page;
          }
        });
      }
      this.sections = sections;
    },

    firstParaOnPage(pageIndex) {
      const idx = this.paragraphs.findIndex((p) => p.page >= pageIndex);
      return idx < 0 ? 0 : idx;
    },

    // Render the pages exactly as laid out, with an invisible selectable text
    // layer and one hit-box per block on top. Records block DOM elements on
    // FR.pdf.blocks[i].pageEl / .hitEl for the paper view to drive.
    async renderPaper(container) {
      container.innerHTML = "";
      if (!this.doc) return;
      const dpr = window.devicePixelRatio || 1;
      const targetWidth = Math.max(320, Math.min(920, container.clientWidth - 48));

      for (let p = 1; p <= this.doc.numPages; p++) {
        const page = await this.doc.getPage(p);
        const base = page.getViewport({ scale: 1 });
        const cssScale = targetWidth / base.width;
        const vp = page.getViewport({ scale: cssScale * dpr });
        const pageH = base.height * cssScale;

        const pageEl = FR.el("div", { class: "paper-page", "data-page": p - 1 });
        // The page scales with the reader (a side panel opening narrows it), so
        // width is a ceiling and everything inside is expressed relatively.
        pageEl.style.width = targetWidth + "px";
        pageEl.dataset.baseW = targetWidth;

        const canvas = FR.el("canvas", { class: "paper-canvas" });
        canvas.width = vp.width;
        canvas.height = vp.height;
        await page.render({ canvasContext: canvas.getContext("2d"), viewport: vp }).promise;
        pageEl.append(canvas);

        // selectable text layer (built from our own line boxes — approximate,
        // its only job is to let the reader select real text for quotes/notes)
        // Spans are placed in px against the full-size page, then the whole
        // layer is scaled by --fit so it tracks the rendered page at any width.
        const tl = FR.el("div", { class: "text-layer" });
        tl.style.width = targetWidth + "px";
        tl.style.height = pageH + "px";
        const spans = [];
        this.blocks.forEach((b, bi) => {
          if (b.page !== p - 1) return;
          b.lines.forEach((ln) => {
            const s = FR.el("span", { text: ln.text, "data-blk": bi });
            s.style.left = ln.x * targetWidth + "px";
            s.style.top = ln.y * pageH + "px";
            s.style.fontSize = Math.max(6, ln.h * pageH * 0.82) + "px";
            s.dataset.w = ln.w * targetWidth;
            spans.push(s);
            tl.append(s);
          });
        });
        pageEl.append(tl);
        // squeeze each span to its real width so selection tracks the glyphs
        spans.forEach((s) => {
          const real = s.offsetWidth;
          if (real > 0) s.style.transform = `scaleX(${(+s.dataset.w / real).toFixed(3)})`;
        });

        // per-block hit boxes (below the text layer, so text stays selectable)
        this.blocks.forEach((b, bi) => {
          if (b.page !== p - 1) return;
          const hit = FR.el("div", {
            class: "blk" + (b.heading ? " blk-h" : ""),
            "data-blk": bi,
          });
          hit.style.left = b.box.x * 100 + "%";
          hit.style.top = b.box.y * 100 + "%";
          hit.style.width = b.box.w * 100 + "%";
          hit.style.height = b.box.h * 100 + "%";
          pageEl.append(hit);
          b.pageEl = pageEl;
          b.hitEl = hit;
        });

        container.append(pageEl);
        container.append(FR.el("div", { class: "page-num", text: `Page ${p} / ${this.doc.numPages}` }));
      }
    },
  };
})();
