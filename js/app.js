/* ============================================================
   app.js — wiring, file loading, view switching, shortcuts
   ============================================================ */
(function () {
  const S = FR.settings;

  // the currently active reading surface
  const surface = () => (FR.app.viewMode === "page" ? FR.paper : FR.text);

  /* ------------------------------------------------------------------
     Auto-pace: one driver for both views. When "Read aloud" is on it is
     the speech that paces the reading — we advance when the paragraph
     has finished being spoken, not on a word-count timer.
     ------------------------------------------------------------------ */
  FR.pace = {
    running: false,
    _timer: null,

    toggle() { this.running ? this.stop() : this.start(); },

    start() {
      if (!FR.pdf.blocks.length) return FR.toast("Open a paper first.");
      this.running = true;
      this.paint();
      this.step();
    },

    // one control, so its lit state IS whether pacing is running
    paint() {
      FR.$("#tb-autoscroll").classList.toggle("is-active", this.running);
      FR.$("#tb-autoscroll").title = this.running
        ? "Stop advancing on its own (Space)"
        : "Advance through the paper on its own (Space)";
      FR.$("#autoscroll-controls").hidden = !this.running;
    },

    step() {
      if (!this.running) return;
      const text = FR.app.activeText();
      if (FR.settings.speech.enabled && FR.speech.supported()) {
        FR.speech.speak(text, () => this.advance());
      } else {
        const words = Math.max(1, text.split(/\s+/).length);
        const secs = Math.max(2.2, (words / FR.settings.wpm) * 60);
        this._timer = setTimeout(() => this.advance(), secs * 1000);
      }
    },

    advance() {
      if (!this.running) return;
      const s = surface();
      if (s.atEnd()) {
        this.stop();
        FR.toast("Reached the end of the paper 🎉");
        return;
      }
      // moving the spotlight re-arms the pacer via onSpotlightMoved, so there
      // is exactly one place that decides what to read next
      s.next();
    },

    // The spotlight landed somewhere new while auto-pace is on — whether the
    // pacer moved it or the reader skipped ahead by hand. Drop whatever was
    // queued for the old sentence and pick up from this one.
    resync() {
      if (!this.running) return;
      clearTimeout(this._timer);
      this._timer = null;
      FR.speech.cancel();
      this.step();
    },

    stop() {
      this.running = false;
      clearTimeout(this._timer);
      this._timer = null;
      FR.speech.cancel();
      this.paint();
    },
  };

  FR.app = {
    viewMode: "page", // page = original layout | text = clean reflow
    paperRendered: false,

    async openFile(file) {
      if (!file || file.type !== "application/pdf") return FR.toast("That doesn't look like a PDF.");
      FR.toast("Reading the paper…", 60000);
      FR.doc.open(file);
      try {
        await FR.pdf.load(file);
      } catch (e) {
        console.error(e);
        return FR.toast("Could not parse that PDF.");
      }
      FR.$("#toast").hidden = true;

      this.lastFile = file; // so the parser can be switched without reopening
      FR.$("#doc-title").textContent = file.name;
      FR.$("#doc-title").title = file.name;
      FR.$("#drop-hint").hidden = true;
      FR.sidecar.showBadge();
      this.paperRendered = false;

      FR.text.render(FR.pdf.paragraphs);
      FR.session.loadDoc();
      await this.setView(this.viewMode);

      if (!FR.pdf.paragraphs.length) {
        FR.toast("No selectable text — likely a scanned PDF. The page view still works; focus aids need a text layer.", 5500);
      } else {
        FR.toast(`${FR.pdf.blocks.length} blocks · ${FR.pdf.sections.length} sections`, 3000);
      }
    },

    // Re-read the open paper with whichever parser is selected now. Your place,
    // highlights and notes are keyed to the document, so they survive.
    async reparse() {
      if (!this.lastFile) return FR.toast("Open a paper first.");
      FR.pace.stop();
      FR.speech.cancel();
      await this.openFile(this.lastFile);
    },

    async setView(mode) {
      this.viewMode = mode;
      const isText = mode === "text";
      const hasText = FR.pdf.paragraphs.length > 0;

      FR.$("#view-text").classList.toggle("is-active", isText);
      FR.$("#view-page").classList.toggle("is-active", !isText);
      FR.$("#text-view").hidden = !isText;
      FR.$("#paper-view").hidden = isText;
      FR.$("#paper-spotlight").hidden = isText || !S.spotlight;
      FR.$("#text-nav").hidden = !hasText;

      this.applyModeChips();

      if (!isText && !this.paperRendered && FR.pdf.doc) {
        FR.toast("Rendering pages…", 30000);
        await FR.pdf.renderPaper(FR.$("#paper-view"));
        this.paperRendered = true;
        FR.paper.mount();
        FR.$("#toast").hidden = true;
      } else if (!isText && this.paperRendered) {
        FR.paper.mount(); // re-sync position / spotlight
      }

      // point the new surface at the same sentence AND scroll it into view —
      // the two views have different content heights, so keeping the raw
      // scrollTop would strand the reader in a blank part of the page
      if (FR.doc.data && hasText) {
        const i = FR.pdf.unitAt(FR.doc.data.lastPara || 0, FR.doc.data.lastUnitInBlock || 0);
        this.quietly(() => {
          if (isText) FR.text.goToUnit(i);
          else FR.paper.refreshSpotlight(true);
        });
      }
    },

    // grey out controls that don't apply to the current mode
    applyModeChips() {
      const paperOnlyOff = ["#tb-bionic", "#font-inc", "#font-dec", "#font-family"];
      const disable = this.viewMode === "page";
      paperOnlyOff.forEach((sel) => {
        const el = FR.$(sel);
        el.classList.toggle("is-disabled", disable);
        el.toggleAttribute("disabled", disable);
      });
      FR.$("#tb-bionic").title = disable
        ? "Bionic text is only available in Clean text mode"
        : "Bold the start of each word (B)";
    },

    setPanel(side, open) {
      const layout = FR.$(".layout");
      const cls = side === "left" ? "left-collapsed" : "right-collapsed";
      if (side === "right") FR.$("#right-panel").hidden = !open;
      layout.classList.toggle(cls, !open);
    },
    togglePanel(side) {
      const layout = FR.$(".layout");
      const cls = side === "left" ? "left-collapsed" : "right-collapsed";
      this.setPanel(side, layout.classList.contains(cls));
    },

    // shared prev/next dispatcher; byBlock skips to the next whole paragraph.
    // Skipping does not stop auto-pace — it carries on from wherever you land.
    nav(dir, byBlock) {
      const s = surface();
      if (byBlock) dir > 0 ? s.nextBlock() : s.prevBlock();
      else dir > 0 ? s.next() : s.prev();
    },

    activeIndex() {          // the paragraph — what highlights and notes attach to
      return FR.pdf.blocks.length ? surface().activeGlobalIndex() : 0;
    },
    activeUnit() {           // the sentence — what the spotlight frames and the voice reads
      return FR.pdf.units[surface().activeUnitIndex()] || null;
    },
    activeText() {
      const u = this.activeUnit();
      return u ? u.text : "";
    },

    showPosition(unitIdx) {
      const u = FR.pdf.units[unitIdx];
      const el = FR.$("#para-pos");
      if (!u) { el.textContent = "—"; return; }
      el.textContent =
        u.of > 1
          ? `¶ ${u.paraNo}/${FR.pdf.paraCount} · ${u.nth + 1}/${u.of}`
          : `¶ ${u.paraNo}/${FR.pdf.paraCount}`;
      el.title =
        `Paragraph ${u.paraNo} of ${FR.pdf.paraCount}` +
        (u.of > 1 ? `, sentence ${u.nth + 1} of ${u.of}` : "");
    },

    // run a repositioning without the voice re-reading it
    quietly(fn) {
      this._quiet = true;
      try { fn(); } finally { this._quiet = false; }
    },

    // called by both views whenever the spotlight lands on a new unit
    onSpotlightMoved(force) {
      if (this._quiet && !force) return;
      // While auto-pace is on it owns the queue: re-arm it here rather than
      // reading anything directly, so a hand-skip keeps the pacing going.
      if (FR.pace.running) return FR.pace.resync();
      if (FR.settings.speech.enabled && FR.speech.supported()) {
        FR.speech.speak(this.activeText());
      }
    },

    // rebuild the reading units after the sentence/paragraph toggle
    rebuildUnits() {
      if (!FR.pdf.blocks.length) return;
      FR.pdf.buildUnits(S.sentenceMode ? "sentence" : "paragraph");
      this.quietly(() => {
        FR.text.render(FR.pdf.paragraphs);
        if (this.paperRendered) FR.paper.mount();
      });
    },

    applySettings() {
      document.documentElement.setAttribute("data-theme", S.theme);
      FR.$("#theme-select").value = S.theme;
      FR.$("#font-family").value = S.fontFamily;
      FR.$("#wpm").value = S.wpm;
      FR.$("#wpm-val").textContent = S.wpm + " wpm";
      FR.text.applyTypography();

      FR.$("#tb-bionic").classList.toggle("is-active", S.bionic);
      FR.$("#tb-spotlight").classList.toggle("is-active", S.spotlight);
      FR.$("#tb-ruler").classList.toggle("is-active", S.ruler);
      FR.$("#tb-sentence").classList.toggle("is-active", S.sentenceMode);
      FR.$("#reader").classList.toggle("spotlight-on", S.spotlight);
      FR.$("#reading-ruler").hidden = !S.ruler;
    },

    init() {
      /* ---- onboarding ---- */
      if (!FR.store.get("onboarded", false)) FR.$("#onboarding").hidden = false;
      FR.$("#onboarding-start").addEventListener("click", () => {
        FR.$("#onboarding").hidden = true;
        if (FR.$("#onboarding-hide").checked) FR.store.set("onboarded", true);
      });

      const last = FR.store.get("lastDoc", null);
      if (last) {
        const rh = FR.$("#resume-hint");
        rh.hidden = false;
        rh.textContent = `Last time you were reading “${last.name}”. Open it again to pick up where you left off.`;
      }

      /* ---- file input + drag/drop ---- */
      FR.$("#open-pdf").addEventListener("click", () => FR.$("#file-input").click());
      FR.$("#file-input").addEventListener("change", (e) => {
        if (e.target.files[0]) this.openFile(e.target.files[0]);
      });
      const reader = FR.$("#reader");
      ["dragenter", "dragover"].forEach((ev) =>
        reader.addEventListener(ev, (e) => { e.preventDefault(); reader.classList.add("drag-over"); }));
      ["dragleave", "drop"].forEach((ev) =>
        reader.addEventListener(ev, (e) => { e.preventDefault(); reader.classList.remove("drag-over"); }));
      reader.addEventListener("drop", (e) => {
        const f = e.dataTransfer.files[0];
        if (f) this.openFile(f);
      });

      /* ---- view + panels ---- */
      FR.$("#view-text").addEventListener("click", () => this.setView("text"));
      FR.$("#view-page").addEventListener("click", () => this.setView("page"));
      FR.$("#toggle-left").addEventListener("click", () => this.togglePanel("left"));
      FR.$("#toggle-right").addEventListener("click", () => this.togglePanel("right"));

      /* ---- toolbar toggles ---- */
      const flip = (key, cls, extra) => {
        S[key] = !S[key];
        FR.saveSettings();
        if (cls) FR.$(cls).classList.toggle("is-active", S[key]);
        if (extra) extra(S[key]);
      };
      FR.$("#tb-bionic").addEventListener("click", (e) => {
        if (e.currentTarget.hasAttribute("disabled")) return;
        flip("bionic", "#tb-bionic", () => FR.text.repaintAll());
      });
      FR.$("#tb-spotlight").addEventListener("click", () =>
        flip("spotlight", "#tb-spotlight", (on) => {
          FR.$("#reader").classList.toggle("spotlight-on", on);
          FR.paper.toggleSpotlight(on);
        }));
      FR.$("#tb-ruler").addEventListener("click", () =>
        flip("ruler", "#tb-ruler", (on) => (FR.$("#reading-ruler").hidden = !on)));
      FR.$("#tb-sentence").addEventListener("click", () =>
        flip("sentenceMode", "#tb-sentence", () => this.rebuildUnits()));

      FR.$("#tb-autoscroll").addEventListener("click", () => FR.pace.toggle());
      FR.$("#wpm").addEventListener("input", (e) => {
        S.wpm = +e.target.value;
        FR.$("#wpm-val").textContent = S.wpm + " wpm";
        FR.saveSettings();
      });

      /* ---- highlight / note, acting on whichever view is showing ---- */
      FR.$("#spot-hl").addEventListener("click", () => FR.text.toggleHighlight(this.activeIndex()));
      FR.$("#spot-note").addEventListener("click", () => FR.text.addNote(this.activeIndex()));

      /* ---- typography (Clean text mode) ---- */
      const bumpFont = (d) => {
        S.fontSize = Math.min(30, Math.max(14, S.fontSize + d));
        FR.saveSettings();
        FR.text.applyTypography();
      };
      FR.$("#font-inc").addEventListener("click", (e) => !e.currentTarget.hasAttribute("disabled") && bumpFont(1));
      FR.$("#font-dec").addEventListener("click", (e) => !e.currentTarget.hasAttribute("disabled") && bumpFont(-1));
      FR.$("#font-family").addEventListener("change", (e) => { S.fontFamily = e.target.value; FR.saveSettings(); FR.text.applyTypography(); });
      FR.$("#theme-select").addEventListener("change", (e) => {
        S.theme = e.target.value; FR.saveSettings();
        document.documentElement.setAttribute("data-theme", S.theme);
      });

      /* ---- shared paragraph nav ---- */
      FR.$("#para-next").addEventListener("click", () => this.nav(1));
      FR.$("#para-prev").addEventListener("click", () => this.nav(-1));

      /* ---- selection popup (works in both modes) ---- */
      const popup = FR.$("#sel-popup");
      FR.$("#reader-scroll").addEventListener("mouseup", () => {
        setTimeout(() => {
          const sel = window.getSelection();
          const text = String(sel).trim();
          if (text.length < 8) { popup.hidden = true; return; }
          const rect = sel.getRangeAt(0).getBoundingClientRect();
          popup.style.left = Math.max(8, rect.left + rect.width / 2 - 70) + "px";
          popup.style.top = Math.max(8, rect.top - 46) + "px";
          popup.hidden = false;
          popup._text = text;
        }, 10);
      });
      document.addEventListener("mousedown", (e) => {
        if (!popup.contains(e.target)) popup.hidden = true;
      });
      FR.$("#sel-quote").addEventListener("click", () => {
        const note = prompt("Optional note for this quote:", "");
        FR.doc.data.quotes.push({ text: popup._text, note: note || "" });
        FR.doc.save();
        FR.session.renderNotes();
        this.setPanel("right", true);
        popup.hidden = true;
        FR.toast("Quote saved.");
      });
      FR.$("#sel-explain").addEventListener("click", () => {
        FR.ai.explainSelection(popup._text);
        popup.hidden = true;
      });

      /* ---- keyboard shortcuts ---- */
      document.addEventListener("keydown", (e) => {
        const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName);
        if (e.key === "Escape") {
          FR.$("#sel-popup").hidden = true;
          if (!FR.$("#onboarding").hidden) FR.$("#onboarding").hidden = true;
        }
        if (typing) return;
        switch (e.key) {
          /* Arrows pace by hand, space starts and stops the pacer. The two do
             not fight: a manual move while pacing skips ahead and keeps going,
             so space is the only thing that stops it. */
          case " ":
            e.preventDefault(); FR.pace.toggle(); break;
          case "ArrowRight":
            e.preventDefault(); this.nav(1, e.shiftKey); break;
          case "ArrowLeft":
            e.preventDefault(); this.nav(-1, e.shiftKey); break;
          case "ArrowDown": e.preventDefault(); this.nav(1, true); break;
          case "ArrowUp": e.preventDefault(); this.nav(-1, true); break;
          case "b": FR.$("#tb-bionic").click(); break;
          case "f": FR.$("#tb-spotlight").click(); break;
          case "r": FR.$("#tb-ruler").click(); break;
          case "t": FR.timer.toggle(); break;
          case "s": FR.$("#tb-speak").click(); break;
          case "h": FR.$("#spot-hl").click(); break;
          case "n": FR.$("#spot-note").click(); break;
          case "p": FR.pace.toggle(); break;
          case "d": e.preventDefault(); FR.$("#park-input").focus(); break;
          case "1": this.setView("page"); break;
          case "2": this.setView("text"); break;
          case "+": case "=": FR.$("#font-inc").click(); break;
          case "-": FR.$("#font-dec").click(); break;
          case "F2": e.preventDefault(); this.togglePanel("left"); break;
          case "F4": e.preventDefault(); this.togglePanel("right"); break;
        }
      });

      /* ---- keep the paper overlay aligned whenever the reader changes size ----
         A window resize is not the only cause: opening or closing a side panel
         narrows the reader too, which rescales the page under the spotlight. */
      let rz;
      const relayout = () => {
        clearTimeout(rz);
        rz = setTimeout(() => {
          if (this.viewMode === "page" && this.paperRendered) FR.paper.layout();
        }, 120);
      };
      window.addEventListener("resize", relayout);
      if (window.ResizeObserver) {
        new ResizeObserver(relayout).observe(FR.$("#reader-scroll"));
      }

      /* ---- boot ---- */
      this.applySettings();
      this.applyModeChips();
      FR.pace.paint();
      FR.text.ruler.bind();
      FR.timer.init();
      FR.session.init();
      FR.speech.init();
      FR.sidecar.init();
      FR.ai.init();
      FR.$(".layout").classList.add("right-collapsed");
    },
  };

  document.addEventListener("DOMContentLoaded", () => FR.app.init());
})();
