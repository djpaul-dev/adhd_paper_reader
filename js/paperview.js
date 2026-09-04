/* ============================================================
   paperview.js — focus aids on the ORIGINAL rendered pages
   The paper's layout (columns, figures, maths, fonts) is left
   completely untouched. A spotlight frames the lines holding the
   current sentence, and tight marks show the sentence's real
   extent, so the highlight and the narration stay in step.
   ============================================================ */
(function () {
  const host = () => FR.$("#paper-view");
  const spot = () => FR.$("#paper-spotlight");

  let active = 0; // index into FR.pdf.units
  let wired = false;

  const unit = (i) => FR.pdf.units[i];

  FR.paper = {
    /* called after FR.pdf.renderPaper() has populated #paper-view */
    mount() {
      if (!wired) {
        host().addEventListener("click", (e) => {
          if (String(window.getSelection()).trim().length > 1) return; // allow selection
          const el = e.target.closest("[data-blk]");
          if (!el) return;
          this.goToBlockAt(+el.dataset.blk, e.clientY);
        });
        wired = true;
      }

      const d = FR.doc.data;
      if (d && d.lastPara) active = FR.pdf.unitAt(d.lastPara, d.lastUnitInBlock || 0);
      else active = this.firstBodyUnit();

      this.layout();
      this.toggleSpotlight(FR.settings.spotlight);
    },

    // skip the title / author block on a paper opened for the first time
    firstBodyUnit() {
      const i = FR.pdf.units.findIndex(
        (u) => FR.pdf.blocks[u.block].text.split(/\s+/).length >= 25
      );
      return i < 0 ? 0 : i;
    },

    // the reader can change width (a side panel opening, a window resize);
    // rescale the text layers and re-place the spotlight to match
    layout() {
      FR.$$(".paper-page", host()).forEach((pe) => {
        const base = +pe.dataset.baseW || pe.clientWidth;
        pe.style.setProperty("--fit", (pe.clientWidth / base).toFixed(4));
      });
      this.applyHighlights();
      this.refreshSpotlight(false);
    },

    rectOf(i) {
      const u = unit(i);
      const b = u && FR.pdf.blocks[u.block];
      if (!b || !b.pageEl) return null;
      const pw = b.pageEl.clientWidth;
      const ph = b.pageEl.clientHeight;
      return {
        left: b.pageEl.offsetLeft + u.box.x * pw,
        top: b.pageEl.offsetTop + u.box.y * ph,
        width: u.box.w * pw,
        height: u.box.h * ph,
      };
    },

    refreshSpotlight(doScroll = true) {
      const units = FR.pdf.units;
      if (!units.length) return;
      active = Math.max(0, Math.min(active, units.length - 1));
      const u = units[active];
      const b = FR.pdf.blocks[u.block];

      const r = this.rectOf(active);
      const s = spot();
      if (r && FR.settings.spotlight) {
        // tight vertically so the frame doesn't clip the neighbouring line
        const padX = 8, padY = 2;
        s.hidden = false;
        s.style.left = r.left - padX + "px";
        s.style.top = r.top - padY + "px";
        s.style.width = r.width + padX * 2 + "px";
        s.style.height = r.height + padY * 2 + "px";
      } else {
        s.hidden = true;
      }

      this.renderMarks(u, b);

      FR.pdf.blocks.forEach((blk) => blk.hitEl && blk.hitEl.classList.remove("is-active"));
      if (b && b.hitEl) b.hitEl.classList.add("is-active");

      FR.app.showPosition(active);
      if (FR.doc.data) {
        FR.doc.data.lastPara = u.block;
        FR.doc.data.lastUnitInBlock = u.nth;
        FR.doc.save();
      }
      FR.session.markSectionByPara(u.block);

      if (doScroll) {
        if (r) {
          const sc = FR.$("#reader-scroll");
          const top = r.top + r.height / 2 - sc.clientHeight / 2;
          sc.scrollTo({ top: Math.max(0, top), behavior: "smooth" });
        }
        FR.app.onSpotlightMoved();
      }
    },

    // tight rectangles over the sentence itself: partial first line,
    // whole middle lines, partial last line
    renderMarks(u, b) {
      FR.$$(".sent-mark", host()).forEach((n) => n.remove());
      if (!b || !b.pageEl || !u.marks || u.marks.length < 1) return;
      if (u.of <= 1) return; // whole paragraph is the unit — the frame says it all
      u.marks.forEach((m) => {
        const el = FR.el("div", { class: "sent-mark" });
        el.style.left = m.x * 100 + "%";
        el.style.top = m.y * 100 + "%";
        el.style.width = m.w * 100 + "%";
        el.style.height = m.h * 100 + "%";
        b.pageEl.append(el);
      });
    },

    next() { if (active < FR.pdf.units.length - 1) { active++; this.refreshSpotlight(); } },
    prev() { if (active > 0) { active--; this.refreshSpotlight(); } },

    nextBlock() {
      const cur = unit(active);
      if (!cur) return;
      const i = FR.pdf.units.findIndex((u) => u.block > cur.block);
      active = i < 0 ? FR.pdf.units.length - 1 : i;
      this.refreshSpotlight();
    },
    prevBlock() {
      const units = FR.pdf.units;
      const cur = unit(active);
      if (!cur) return;
      const firstOfCur = units.findIndex((u) => u.block === cur.block);
      if (active > firstOfCur) active = firstOfCur; // rewind to the start of this one
      else if (firstOfCur > 0) {
        const prevBlk = units[firstOfCur - 1].block;
        active = units.findIndex((u) => u.block === prevBlk);
      } else active = 0;
      this.refreshSpotlight();
    },

    goToBlock(blockIndex) {
      active = FR.pdf.firstUnitOfBlock(blockIndex);
      this.refreshSpotlight();
    },
    goToBlockNear(blockIndex) { this.goToBlock(blockIndex); },

    // click inside a paragraph lands on the sentence nearest that point
    goToBlockAt(blockIndex, clientY) {
      const b = FR.pdf.blocks[blockIndex];
      let best = FR.pdf.firstUnitOfBlock(blockIndex);
      if (b && b.pageEl && clientY != null) {
        const top = b.pageEl.getBoundingClientRect().top;
        const rel = (clientY - top) / b.pageEl.clientHeight;
        let bestD = Infinity;
        FR.pdf.units.forEach((u, i) => {
          if (u.block !== blockIndex) return;
          const mid = u.box.y + u.box.h / 2;
          const d = Math.abs(mid - rel);
          if (d < bestD) { bestD = d; best = i; }
        });
      }
      active = best;
      this.refreshSpotlight();
    },

    activeUnitIndex() { return active; },
    activeGlobalIndex() { return unit(active) ? unit(active).block : 0; },
    atEnd() { return active >= FR.pdf.units.length - 1; },

    toggleSpotlight(on) {
      host().classList.toggle("spotlight-on", on);
      if (!on) spot().hidden = true;
      else this.refreshSpotlight(false);
    },

    /* ---- highlights: translucent rectangles over the paragraph ---- */
    applyHighlights() {
      FR.$$(".pg-hl", host()).forEach((n) => n.remove());
      FR.pdf.blocks.forEach((b) => b.hitEl && b.hitEl.classList.remove("has-note"));
      const hs = (FR.doc.data && FR.doc.data.highlights) || [];
      hs.forEach((h) => {
        const b = FR.pdf.blocks[h.para];
        if (!b || !b.pageEl) return;
        const box = FR.el("div", { class: "pg-hl" });
        box.style.left = b.box.x * 100 + "%";
        box.style.top = b.box.y * 100 + "%";
        box.style.width = b.box.w * 100 + "%";
        box.style.height = b.box.h * 100 + "%";
        if (h.note) box.title = h.note;
        b.pageEl.append(box);
        if (h.note && b.hitEl) b.hitEl.classList.add("has-note");
      });
    },
  };
})();
