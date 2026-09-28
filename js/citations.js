/* ============================================================
   citations.js — find in-text citations

   A citation is the one part of a sentence that carries no meaning
   when you are reading for comprehension: "(Peters et al., 2018;
   Devlin et al., 2019)" spoken aloud is thirty syllables of noise in
   the middle of a clause, and on the page it is the thing your eye
   snags on and then has to find its way back from. So they are
   marked, and read-aloud steps over them.

   Deliberately conservative. Skipping a citation costs nothing;
   swallowing "(see Figure 3)" or "(i.e., 3 + 6 = 9)" would quietly
   remove something the sentence needs, and a reader who cannot trust
   what is being read to them will stop using the feature.
   ============================================================ */
(function () {
  // 1887, 2020, and the 2020a/2020b of a paper cited twice
  const YEAR = /\b(1[89]\d\d|20\d\d)[a-z]?\b/;
  // [1] [1, 2] [1-3] [12; 34] — digits and separators only, nothing else
  const NUMERIC = /^[\d\s,;&–—-]*\d[\d\s,;&–—-]*$/;
  // a bracketed group with no bracket inside it
  const GROUP = /[([][^()[\]]*[)\]]/g;

  FR.cite = {
    /* Ranges of `text` that are citations, in order and non-overlapping. */
    find(text) {
      const out = [];
      if (!text) return out;
      GROUP.lastIndex = 0;
      let m;
      while ((m = GROUP.exec(text))) {
        const whole = m[0];
        const inner = whole.slice(1, -1).trim();
        if (!inner) continue;
        /* Square brackets carrying nothing but numbers are a numbered
           citation. Round ones are not: "(1)" is an equation number far more
           often than it is a reference, and stripping those from a methods
           section would be worse than leaving every citation in. */
        const numbered = whole[0] === "[" && NUMERIC.test(inner);
        // "(Wei et al., 2022)", "(2022)" closing a narrative citation
        const dated = YEAR.test(inner);
        if (numbered || dated) out.push({ start: m.index, end: m.index + whole.length });
      }
      return out;
    },

    /* `text` split into runs, each flagged as citation or not. Rendering
       walks this so a citation can be coloured without the caller having to
       think about offsets. */
    segments(text) {
      const spans = this.find(text);
      if (!spans.length) return [{ text: text || "", cite: false }];
      const out = [];
      let at = 0;
      for (const s of spans) {
        if (s.start > at) out.push({ text: text.slice(at, s.start), cite: false });
        out.push({ text: text.slice(s.start, s.end), cite: true });
        at = s.end;
      }
      if (at < text.length) out.push({ text: text.slice(at), cite: false });
      return out;
    },

    /* `text` with the citations taken out, for reading aloud. */
    strip(text) {
      const spans = this.find(text);
      if (!spans.length) return text;
      let out = "";
      let at = 0;
      for (const s of spans) {
        out += text.slice(at, s.start);
        at = s.end;
      }
      out += text.slice(at);

      out = out
        .replace(/\s+([,.;:!?%)\]])/g, "$1") // "shown in [1], we" -> "shown in, we"
        .replace(/([([])\s+/g, "$1")
        .replace(/\(\s*\)|\[\s*\]/g, "")     // a group that held only citations
        .replace(/\s{2,}/g, " ")
        .trim();

      /* A sentence that was nothing but a citation leaves nothing to say, and
         a spotlight sitting on silence reads as the app having crashed. Say
         the original rather than nothing at all. */
      return /[A-Za-z0-9]/.test(out) ? out : text;
    },

    /* Whether the feature is on. Kept here so callers read the same way. */
    on() {
      return !!FR.settings.citations;
    },
  };
})();
