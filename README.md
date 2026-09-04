# Focus Reader

A calmer way to get through a research paper — built for brains that lose the thread
after two paragraphs.

It takes a PDF and turns it into a reading surface that does the work of *staying
oriented* so you don't have to: one paragraph lit at a time, your goal pinned in
view, enforced breaks on a timer, and a place to dump the thoughts that barge in.

Everything runs in your browser. **No PDF is uploaded anywhere.** Notes, progress,
and settings are saved in `localStorage` on your machine.

---

## Run it

No build step. You just need to serve the folder over HTTP (opening `index.html`
straight from disk works too, but a server is more reliable):

```bash
cd adhd_reader
python3 -m http.server 8000
# then open http://localhost:8000
```

Open `sample-paper.pdf` (included) to try it immediately.

---

## What's in it

### Reading
- **Original layout mode (default)** — the paper is rendered exactly as it was laid
  out: columns, figures, equations, fonts, everything. A **spotlight** frames the
  current sentence and dims the rest of the page. Advance with **Space / →**, back
  with **←**; **↓ / ↑** (or **Shift**+arrow) skip a whole paragraph; click anywhere
  to jump to the sentence you clicked. An invisible text layer keeps the real text
  selectable for quotes, notes, and "explain this".
- **One sentence at a time.** The reading unit is a sentence, not a paragraph, so the
  spotlight and the narration always sit on the same words. Because a sentence
  usually starts and ends mid-line, the frame covers the *lines* it occupies and a
  soft underline marks its exact extent — you can see precisely where to start and
  stop without the layout jumping around. Turn the **Sentence** chip off to step by
  whole paragraphs instead.
- **Clean text mode** — the same paragraphs reflowed into one column, for when a
  dense two-column layout or tiny type gets in the way. Adds **bionic reading**
  (**B**, bolds the start of each word), text-size and typeface controls.
- **Reading ruler** — a band that follows your cursor and mutes everything else
  (**R**), in either mode.
- **Read aloud** (**S**) — the browser's own speech synthesis reads the spotlighted
  sentence. Pick a voice and speed; 🔊 in the bottom bar replays the current one.
- **Auto-pace** (**P**) — one control: the chip is lit while it is running, and
  the speed slider appears with it. It advances on its own. With **Read aloud** on, the *voice* sets the
  pace: one sentence per utterance, and the spotlight moves when that sentence
  finishes — so the highlight and the audio are never out of step. With it off,
  pacing falls back to a words-per-minute estimate. Skipping ahead or back while
  it runs does **not** stop it — it drops whatever was queued and picks up from
  the sentence you landed on. Only **pause** (`P`) stops it.
- Four themes (sepia / light / dark / high-contrast). The theme styles the app and
  the spotlight scrim; it never alters the rendered page itself.

Your place in the paper, your highlights, and your notes are shared between the two
modes — switch freely.

### Staying on task
- **One goal per paper** — write the single thing you need from it; it stays on screen.
- **Focus blocks** — 25 / 5 Pomodoro timer with a real, enforced break screen and a
  longer break every fourth block. Chime on switch (toggleable). Press **T** to
  start/pause.
- **Section checklist** — auto-built from the PDF outline, or detected headings, or
  page markers. Check sections off; watch the progress bar move. Click one to jump.
- **Distraction parking lot** — a thought pops up, you type it, hit *Park it*, and get
  back to reading. Press **D** to jump to the box.
- **Today** — focus minutes, blocks completed, and a day streak.

### Understanding & keeping
- **Highlights & notes** — highlight the lit paragraph or attach a note; select any
  text to save a quote. All stored per paper and listed in the right panel.
- **AI helper (optional, off by default)** — add an Anthropic API key to get a
  plain-language TL;DR, per-section summaries, and "explain this selection". The
  paper's text is sent to Anthropic only when you press one of those buttons. The key
  is kept in `localStorage` on this device and can be removed with one click.

---

## Keyboard shortcuts

| Key | Action |
| --- | --- |
| `Space` / `→` | Next sentence |
| `←` | Previous sentence |
| `↓` / `↑` | Next / previous paragraph |
| `B` | Bionic reading |
| `F` | Spotlight (dim other paragraphs) |
| `R` | Reading ruler |
| `S` | Read aloud on / off |
| `P` | Play / pause auto-pace |
| `H` / `N` | Highlight / note the current paragraph |
| `T` | Start / pause focus timer |
| `D` | Jump to the distraction parking lot |
| `1` / `2` | Original layout / Clean text |
| `+` / `-` | Text size |
| `F2` / `F4` | Toggle left / right panel |
| `Esc` | Close overlay / selection popup |

---

## How the PDF gets read

There are two parsers. The built-in one runs in your browser and needs nothing
installed; an optional [local sidecar](sidecar/README.md) runs a layout model for
the papers it gets wrong. The badge beside the document title says which one ran.

### Built-in (default)

`js/pdfview.js` uses [PDF.js](https://mozilla.github.io/pdf.js/) (loaded from a CDN)
to pull the text layer out of each page, then:

> **Keep PDF.js current.** It is pinned to 5.4.149 and loaded as an ES module,
> because the version genuinely matters. On 3.11.174 a CVPR 2025 paper in this
> repo produced *zero* text on every page — the console showed
> `Error during font loading: Unknown block type in flate stream`, so glyphs
> could not be mapped to Unicode even though the page had 58 text-drawing
> operators. Same file on 4.10 / 5.4 / 6.3: 73 items on page one. No amount of
> layout analysis recovers from an empty text layer, so if a paper comes up
> blank, check the pdf.js version before suspecting anything else.

1. **Line fragments.** Glyphs are grouped into runs that share a baseline *and* run
   left-to-right with no gutter-sized gap. Both conditions matter: in a two-column
   paper the left and right columns share baselines, so sorting by `y` interleaves
   them, and a naive merge silently swallows a left-column line into the right one.

   Sideways text is dropped first: an arXiv stamp down the margin has a rotated
   text matrix, so its width lands on the wrong axis and it reads as one very
   wide line — which then swallows a whole column into its block and wrecks the
   reading order of the page.

   "Gutter-sized" is measured against the **body type size**, not the page width.
   A fraction of the width is far too coarse: on an ACL paper the gutter is 17pt
   while a stretched justified space is 7pt, so a 21pt threshold fuses the two
   columns into one string that nothing downstream can pull apart. The split
   deliberately errs towards over-splitting — an over-split line is harmless
   (the pieces share a baseline, sort back together and rejoin with a space).
2. **Regions, by recursive XY-cut.** One column split per page cannot survive a
   paper that interrupts its own grid — a full-width table between two-column
   bands breaks the whole page. Instead the page is recursively carved along
   whitespace channels no text crosses: a *vertical* channel is a column gutter
   (read left, then right), a *horizontal* one is a structural break (read top,
   then bottom). Columns are tried first at each step, because a gutter running
   a region's full height is unambiguous while a horizontal band can line up by
   coincidence across two columns and interleave them.

   Three things make that survive real pages:

   - **Artwork comes out first.** A row-by-row ink profile finds runs of nearly
     empty rows several lines deep — a plot or a diagram. The gaps *inside* a
     figure are wider than the gap separating it from the text, so an ordinary
     gap cut slices it in half and neither piece is recognisable as artwork
     afterwards. The band is lifted out whole instead. (The band is trimmed to
     start at a genuinely empty row, or the short last line of the paragraph
     above gets swallowed into it, and only lifted out if its contents really
     look like a figure or table — a lone heading stranded in a gap is sparse
     too, and belongs to its column.)
   - **Bands are cut topmost-first, not widest-first.** A page reads top to
     bottom, and the widest gap is often somewhere unhelpful.
   - **Straddler extraction** as a last resort. A full-width title sitting
     directly on two columns leaves neither a clean gutter nor a gap wide
     enough to cut at. The near-gutter is found by locating the x that fewest
     boxes cross; those few are lifted out and the bands between them are
     column-cut. Without this the region is emitted as one lump and the columns
     interleave.
3. **Region kinds.** Recursion stops at a table (rows of several *narrow* cells —
   width is what separates a table from three columns of text) or a figure
   (either all-short labels, or low ink density over a tall area, which also
   catches a figure carrying a long caption). Those stay whole, so the spotlight
   treats them as one stop instead of stepping through them row by row. A
   `Figure 1:`-style caption underneath is split back off and read as prose.
4. **Blocks.** Within each prose region, lines become paragraphs/headings from
   inter-line spacing, line-width shortfall, and first-line indentation, measured
   *per region*. If nearly every line becomes its own block those rules misfired,
   and the region is redone using only real vertical gaps.
5. **Units.** Blocks are split into sentences — a period only ends a sentence if a
   space and a sentence-like opener follow it, and it isn't an abbreviation, an
   initial ("J. R. Anderson") or a decimal ("0.6"). Stubs shorter than 24 characters
   fold into the previous sentence so the voice doesn't stutter. The line-range map
   turns each sentence's character span back into page rectangles.

Being pure geometry, it encodes assumptions and will lose on layouts that break
them. That is not a hypothetical: every new paper tried against it has found a
fresh hole — an interrupted grid, a figure sliced at its widest internal gap, a
gutter narrower than the threshold, a pseudocode listing that reads as a table
and swallows the page. Each fix is verified against the paper in front of it,
which is the definition of overfitting. **Treat this parser as the offline
fallback and use the sidecar for anything it gets wrong** — on the same CVPR
paper, the layout model needed no tuning at all.

### Local sidecar (optional)

`sidecar/server.py` runs [Docling](https://github.com/DS4SD/docling) and returns
*structure only* — region boxes and kinds. The browser keeps its own line geometry
and lets each region box claim the fragments inside it, so the spotlight stays
precise while the structure comes from a model trained on real documents.

Measured on the real papers in this repo: on the CVPR one it splits a column
that the built-in parser emitted as a single 48-line block into four correct
paragraphs, labels `3.2.` and `Algorithm 1` as headings, keeps the listing
whole, and finds 29 sections — all without a threshold being touched. Coverage
of the page text was 97%.

Two things it does *not* get to decide:

- **Reading order.** Docling's own item order put the title *after* the abstract
  and interleaved a three-column block with the section below it. The reader
  re-orders the model's regions with the same whitespace recursion it uses for
  its own parsing.
- **Whether anything is lost.** A model can simply fail to emit a region — on
  one ICML paper it returned the abstract's left column and nothing at all for
  the right. Fragments no box claims are **not** discarded: they go through the
  built-in segmenter and are placed back in reading order. A coverage check
  would not have caught that page — it was still 86% claimed — and across that
  document 54 blocks were being recovered this way. The reader only abandons the
  model's structure outright when it recognised under 25% of the text.

**Choosing where papers are parsed.** The notes panel → *Parser* offers three:

| | speed | privacy |
| --- | --- | --- |
| **Built-in** (default) | instant | nothing leaves the browser |
| **This machine** | ~2 min a paper | nothing leaves the machine |
| **GPU** | ~10 s a paper | **the paper is uploaded** |

GPU needs a URL first — `modal deploy sidecar/modal_app.py` prints one; paste it
under *Where it runs*. Picking GPU without a URL refuses rather than silently
staying off.

**Switching between them.** The badge beside the document title is the control:

| badge | meaning |
| --- | --- |
| `built-in` | read with the browser parser — click to switch |
| `✓ accurate` | read with the layout model on this machine |
| `☁ accurate` | read with the GPU service — the paper was uploaded |
| `⚠ built-in` | the accurate parser was *asked for* but could not run — the tooltip says why |

Clicking it flips between the built-in parser and whichever service you last
chose, and re-reads the open paper immediately — you do not have to find the file
again, and your place, highlights and notes survive. The same switch, plus the
service address and a *Re-read this paper* button, lives in the notes panel.

The `⚠` state matters: an unavailable service degrades to the built-in parser so
the app keeps working, but it never quietly claims the accurate one ran. Its
tooltip distinguishes *unreachable* from *took longer than the time limit* from
*its layout did not match this file*.

While a parse runs the panel shows real progress — `reading page 4 of 11 — 27%`
with a bar — rather than going quiet. A cold parse of a long paper takes several
minutes, and silence is indistinguishable from a hang. If the service is busy
with a different document, it says so and waits its turn.

It can run in two places. **On this machine** (default) nothing leaves your
browser, and a paper takes 1–2 minutes on CPU. **On a GPU via Modal**
(`modal deploy sidecar/modal_app.py`) the same paper takes ~3 seconds — but it is
uploaded to be parsed, so the badge reads `☁ accurate` instead of `✓ accurate`
and the panel carries a standing warning naming the host. Either way results are
cached by content hash, so re-opening is instant.

Setup, speed and caching: [`sidecar/README.md`](sidecar/README.md).

### Known limits, either parser

- **Scanned / image-only PDFs** have no text layer — the page still displays, but the
  spotlight, selection, and Clean text mode have nothing to work with. (An OCR path
  in the sidecar would fix this; not wired up yet.)
- The selectable text layer in Original layout mode is positioned from our own line
  boxes, so selection is approximate, not pixel-perfect on every glyph.
- A column gutter narrower than the body type size will still merge the two
  columns into one line, which nothing downstream can undo. Real papers sit
  comfortably above that (ACL's is 17pt against 11pt type), but it is the floor.
- A word hyphenated across a line break is rejoined without the hyphen, so a genuine
  compound can lose it ("within-subjects" → "withinsubjects"). Hyphens before a
  capital or digit are kept.
- Non-prose blocks (file paths, code, equations) have no sentence boundary and stay
  one unit.
- **Read aloud** uses the voices your OS/browser provides; Linux needs `speech-dispatcher`
  plus a voice installed, or the voice list will be empty.

---

## Project layout

```
index.html          markup + panel structure
css/styles.css      theme tokens + layout
js/state.js          namespace, localStorage, per-doc records, daily stats
js/pdfview.js         PDF load, page render + text layer, line/paragraph/sentence extraction
js/paperview.js       spotlight + navigation over the original rendered pages
js/textview.js        clean-reflow view: sentence spans, bionic, typography
js/speech.js          read-aloud: voice, speed, chunked utterances
js/sidecar.js         optional parsing service: health, upload, progress, fallback
sidecar/server.py     the local service (Docling on CPU), page progress, cache
sidecar/modal_app.py  the same service on a GPU via Modal (uploads the PDF)
js/timer.js           Pomodoro focus blocks + break overlay
js/session.js         goal, section checklist, parking lot, stats, notes panel
js/ai.js              optional Anthropic API integration
js/app.js             wiring, view switching, shortcuts, shared auto-pace driver
sample-paper.pdf     single-column test paper
hard-paper.pdf       layout stress test: full-width table and figure interrupting
                     a two-column grid, plus a three-column block
page3-paper.pdf      three pages of two-column text, the last interrupted by a
                     full-width figure at its foot
```

Those three are generated for this project and are committed. **Real papers are
gitignored** — they are other people's copyrighted work and they are large — but
each of the ones below caught a distinct bug and is worth re-fetching if you
touch the parser:

| paper | where | what it catches |
| --- | --- | --- |
| `2025.naacl-demo.30` | [ACL Anthology](https://aclanthology.org/2025.naacl-demo.30/) | 17pt gutter against 11pt type: a width-scaled split threshold fuses the two columns into one string |
| FirePlace (CVPR 2025) | [CVF open access](https://openaccess.thecvf.com/) | fonts PDF.js 3.x cannot decode — zero text on every page; a pseudocode listing that reads as a table and swallows the page |
| `arXiv:2511.20639` | `arxiv.org/abs/2511.20639` | layout model omits the abstract's right column entirely; a rotated arXiv stamp down the margin wrecks the page's reading order |

`FR.pdf.debugPage(n)` in the browser console prints the signals for page *n* —
item count, gutter threshold, fragment count, and the regions in reading order.
`FR.pdf.debugRegions(n)` prints just the regions.

No dependencies to install. The only network calls are the PDF.js library + web font
from their CDNs, and — if you opt in — requests to the Anthropic API.
