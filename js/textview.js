/* ============================================================
   textview.js — the ADHD reading surface
   Renders extracted paragraphs, one-at-a-time spotlight, bionic
   text, reading ruler, auto-pace, typography controls.
   ============================================================ */
(function () {
  const view = () => FR.$("#text-view");
  const scroll = () => FR.$("#reader-scroll");

  let paras = [];   // .para node per block index
  let sents = [];   // .sent node per unit index
  let active = 0;   // index into FR.pdf.units

  const unit = (i) => FR.pdf.units[i];

  /* ---------- bionic reading ---------- */
  function bionic(text) {
    return FR.escape(text).replace(/[A-Za-zÀ-ɏ]+/g, (word) => {
      const n = word.length <= 3 ? 1 : Math.ceil(word.length * 0.42);
      return "<b>" + word.slice(0, n) + "</b>" + word.slice(n);
    });
  }
  function paintSpan(node) {
    const raw = node.dataset.raw;
    node.innerHTML = FR.settings.bionic ? bionic(raw) : FR.escape(raw);
  }

  /* ---------- render ---------- */
  FR.text = {
    render(paragraphs) {
      const root = view();
      root.innerHTML = "";
      paras = [];
      sents = [];

      paragraphs.forEach((p, i) => {
        if (p.heading) {
          root.append(FR.el("h3", { text: p.text, "data-i": i }));
          paras[i] = null;
          return;
        }
        const wrap = FR.el("div", { class: "para", "data-i": i });

        // one span per reading unit, so the same sentence is lit here and on the page
        FR.pdf.units.forEach((u, ui) => {
          if (u.block !== i) return;
          const span = FR.el("span", { class: "sent", "data-u": ui });
          span.dataset.raw = u.text;
          paintSpan(span);
          span.addEventListener("click", (e) => { e.stopPropagation(); FR.text.goToUnit(ui); });
          wrap.append(span, document.createTextNode(" "));
          sents[ui] = span;
        });

        const tools = FR.el("div", { class: "para-tools" });
        tools.append(
          FR.el("button", { text: "★ highlight", title: "Highlight this paragraph",
            onclick: (e) => { e.stopPropagation(); FR.text.toggleHighlight(i); } }),
          FR.el("button", { text: "✎ note", title: "Attach a note",
            onclick: (e) => { e.stopPropagation(); FR.text.addNote(i); } })
        );
        wrap.append(tools);
        wrap.addEventListener("click", () => FR.text.goToPara(i));
        root.append(wrap);
        paras[i] = wrap;
      });

      this.applyHighlights();
      const d = FR.doc.data;
      active = d && d.lastPara ? FR.pdf.unitAt(d.lastPara, d.lastUnitInBlock || 0) : 0;
      this.refreshSpotlight(false);
    },

    /* ---------- spotlight / navigation ---------- */
    refreshSpotlight(doScroll = true) {
      const units = FR.pdf.units;
      if (!units.length) return;
      active = Math.max(0, Math.min(active, units.length - 1));
      const u = units[active];
      const node = sents[active];
      const para = paras[u.block];

      sents.forEach((s) => s && s.classList.remove("is-active"));
      paras.forEach((p) => p && p.classList.remove("is-active", "is-near"));
      if (node) node.classList.add("is-active");
      if (para) para.classList.add("is-active");
      for (const off of [-1, 1]) {
        const n = units[active + off];
        if (n && paras[n.block] && n.block !== u.block) paras[n.block].classList.add("is-near");
      }

      FR.app.showPosition(active);
      if (FR.doc.data) {
        FR.doc.data.lastPara = u.block;
        FR.doc.data.lastUnitInBlock = u.nth;
        FR.doc.save();
      }
      FR.session.markSectionByPara(u.block);

      // only announce on a real move — not on render / view switch
      if (doScroll) {
        (node || para).scrollIntoView({ block: "center", behavior: "smooth" });
        FR.app.onSpotlightMoved();
      }
    },
    next() { if (active < FR.pdf.units.length - 1) { active++; this.refreshSpotlight(); } },
    prev() { if (active > 0) { active--; this.refreshSpotlight(); } },
    nextBlock() {
      const cur = unit(active);
      const i = FR.pdf.units.findIndex((u) => u.block > cur.block);
      active = i < 0 ? FR.pdf.units.length - 1 : i;
      this.refreshSpotlight();
    },
    prevBlock() {
      const units = FR.pdf.units;
      const cur = unit(active);
      const firstOfCur = units.findIndex((u) => u.block === cur.block);
      if (active > firstOfCur) active = firstOfCur;
      else if (firstOfCur > 0) {
        const pb = units[firstOfCur - 1].block;
        active = units.findIndex((u) => u.block === pb);
      } else active = 0;
      this.refreshSpotlight();
    },
    goToUnit(i) { active = i; this.refreshSpotlight(); },
    goToPara(globalI) {
      active = FR.pdf.firstUnitOfBlock(globalI);
      this.refreshSpotlight();
    },
    goToParaNear(globalI) {
      active = FR.pdf.firstUnitOfBlock(globalI);
      this.refreshSpotlight();
    },
    activeUnitIndex() { return active; },
    activeGlobalIndex() { return unit(active) ? unit(active).block : 0; },

    /* ---------- typography ---------- */
    repaintAll() { sents.forEach((s) => s && paintSpan(s)); },

    applyTypography() {
      const s = FR.settings;
      const rootStyle = document.documentElement.style;
      rootStyle.setProperty("--reader-font-size", s.fontSize + "px");
      const fam = { hyper: '"Atkinson Hyperlegible", system-ui, sans-serif',
                    serif: '"Lora", Georgia, serif',
                    system: "system-ui, -apple-system, Segoe UI, Roboto, sans-serif" }[s.fontFamily];
      rootStyle.setProperty("--font-read", fam);
    },

    /* ---------- reading ruler ---------- */
    ruler: {
      bind() {
        const r = FR.$("#reading-ruler");
        const sc = scroll();
        this._move = (e) => {
          if (!FR.settings.ruler) return;
          const rect = sc.getBoundingClientRect();
          const y = e.clientY - rect.top + sc.scrollTop - 23;
          r.style.top = y + "px";
        };
        sc.addEventListener("mousemove", this._move);
      },
      toggle(on) { FR.$("#reading-ruler").hidden = !on; },
    },

    atEnd() { return active >= FR.pdf.units.length - 1; },

    /* ---------- highlights & notes ---------- */
    toggleHighlight(globalI) {
      const list = FR.doc.data.highlights;
      const at = list.findIndex((h) => h.para === globalI);
      if (at >= 0) list.splice(at, 1);
      else list.push({ para: globalI, note: "" });
      FR.doc.save();
      this.applyHighlights();
      if (FR.paper) FR.paper.applyHighlights();
      FR.session.renderNotes();
    },
    addNote(globalI) {
      const existing = FR.doc.data.highlights.find((h) => h.para === globalI);
      const cur = existing ? existing.note : "";
      const txt = window.prompt("Note for this paragraph:", cur);
      if (txt === null) return;
      if (existing) existing.note = txt;
      else FR.doc.data.highlights.push({ para: globalI, note: txt });
      FR.doc.save();
      this.applyHighlights();
      if (FR.paper) FR.paper.applyHighlights();
      FR.session.renderNotes();
    },
    applyHighlights() {
      FR.$$(".para", view()).forEach((n) => {
        n.classList.remove("hl");
        const old = n.querySelector(".para-note");
        if (old) old.remove();
      });
      (FR.doc.data.highlights || []).forEach((h) => {
        const node = view().querySelector(`.para[data-i="${h.para}"]`);
        if (!node) return;
        node.classList.add("hl");
        if (h.note) node.append(FR.el("div", { class: "para-note", text: h.note }));
      });
    },
  };
})();
