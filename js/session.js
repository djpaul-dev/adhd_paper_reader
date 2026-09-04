/* ============================================================
   session.js — goal, section checklist, distraction parking lot,
   daily stats, notes panel rendering
   ============================================================ */
(function () {
  FR.session = {
    init() {
      // goal
      const goal = FR.$("#goal-input");
      goal.addEventListener("input", () => {
        if (FR.doc.data) { FR.doc.data.goal = goal.value; FR.doc.save(); }
      });

      // parking lot
      FR.$("#park-form").addEventListener("submit", (e) => {
        e.preventDefault();
        const input = FR.$("#park-input");
        const text = input.value.trim();
        if (!text) return;
        const lot = FR.store.get("parkingLot", []);
        lot.unshift({ text, at: Date.now(), done: false });
        FR.store.set("parkingLot", lot);
        input.value = "";
        this.renderParking();
      });
      FR.$("#park-clear").addEventListener("click", () => {
        if (confirm("Clear all parked thoughts?")) {
          FR.store.set("parkingLot", []);
          this.renderParking();
        }
      });

      this.renderParking();
      this.renderStats();
    },

    /* ---------- called when a document is opened ---------- */
    loadDoc() {
      FR.$("#goal-input").value = FR.doc.data.goal || "";
      this.renderSections();
      this.renderNotes();
    },

    /* ---------- sections / checklist ---------- */
    renderSections() {
      const ul = FR.$("#section-list");
      ul.innerHTML = "";
      const secs = FR.pdf.sections || [];
      if (!secs.length) {
        ul.append(FR.el("li", { class: "section-empty", text: "No sections detected in this PDF." }));
        this.updateProgress();
        return;
      }
      const done = FR.doc.data.sectionsDone || (FR.doc.data.sectionsDone = {});
      secs.forEach((s) => {
        const cb = FR.el("input", { type: "checkbox" });
        cb.checked = !!done[s.id];
        cb.addEventListener("click", (e) => {
          e.stopPropagation();
          done[s.id] = cb.checked;
          FR.doc.save();
          li.classList.toggle("done", cb.checked);
          this.updateProgress();
        });
        const title = FR.el("span", { class: "s-title", text: s.title });
        const li = FR.el("div", {
          class: "section-item lvl-" + s.level + (done[s.id] ? " done" : ""),
          "data-id": s.id,
          "data-para": s.para,
        }, [cb, title]);
        li.addEventListener("click", () => {
          if (FR.app.viewMode === "page") FR.paper.goToBlockNear(s.para);
          else FR.text.goToParaNear(s.para);
        });
        ul.append(li);
      });
      this.updateProgress();
    },

    updateProgress() {
      const secs = FR.pdf.sections || [];
      const done = FR.doc.data ? FR.doc.data.sectionsDone || {} : {};
      const n = secs.filter((s) => done[s.id]).length;
      FR.$("#progress-label").textContent = `${n} / ${secs.length}`;
      FR.$("#progress-bar").style.width = secs.length ? (n / secs.length) * 100 + "%" : "0%";
    },

    // highlight the section that contains the current paragraph
    markSectionByPara(globalI) {
      const secs = FR.pdf.sections || [];
      if (!secs.length) return;
      let currentId = null;
      for (const s of secs) if (s.para <= globalI) currentId = s.id;
      FR.$$("#section-list .section-item").forEach((li) => {
        li.classList.toggle("current", li.dataset.id === currentId);
      });
    },

    /* ---------- parking lot ---------- */
    renderParking() {
      const ul = FR.$("#park-list");
      const lot = FR.store.get("parkingLot", []);
      ul.innerHTML = "";
      lot.forEach((item, i) => {
        const cb = FR.el("input", { type: "checkbox" });
        cb.checked = item.done;
        cb.addEventListener("change", () => {
          lot[i].done = cb.checked;
          FR.store.set("parkingLot", lot);
          li.classList.toggle("done", cb.checked);
        });
        const when = new Date(item.at);
        const li = FR.el("li", { class: item.done ? "done" : "" }, [
          cb,
          FR.el("span", { text: item.text }),
          FR.el("time", { text: when.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) }),
        ]);
        ul.append(li);
      });
    },

    /* ---------- stats ---------- */
    renderStats() {
      const rec = FR.stats[FR.todayKey()] || { minutes: 0, sessions: 0 };
      FR.$("#stat-minutes").textContent = Math.round(rec.minutes);
      FR.$("#stat-sessions").textContent = rec.sessions;
      FR.$("#stat-streak").textContent = FR.currentStreak();
    },

    /* ---------- notes panel ---------- */
    renderNotes() {
      const box = FR.$("#notes-list");
      box.innerHTML = "";
      const d = FR.doc.data;
      if (!d || (!d.highlights.length && !d.quotes.length)) {
        box.append(FR.el("p", { class: "hint",
          html: "Use ★ and ✎ in the bottom bar to highlight the lit paragraph or attach a note — both views. Select any text on the page to save a quote." }));
        return;
      }
      d.highlights.forEach((h, i) => {
        const p = FR.pdf.paragraphs[h.para];
        const snippet = p ? p.text.slice(0, 140) + (p.text.length > 140 ? "…" : "") : "(paragraph)";
        const item = FR.el("div", { class: "note-item" }, [
          FR.el("button", { class: "link-btn note-del", text: "delete",
            onclick: (e) => { e.stopPropagation(); d.highlights.splice(i, 1); FR.doc.save(); FR.text.applyHighlights(); FR.paper.applyHighlights(); FR.session.renderNotes(); } }),
          FR.el("div", { class: "note-quote", text: "★ " + snippet }),
          h.note ? FR.el("div", { class: "note-text", text: h.note }) : null,
        ]);
        item.addEventListener("click", () => {
          if (FR.app.viewMode === "page") FR.paper.goToBlock(h.para);
          else FR.text.goToPara(h.para);
        });
        box.append(item);
      });
      d.quotes.forEach((q, i) => {
        const item = FR.el("div", { class: "note-item" }, [
          FR.el("button", { class: "link-btn note-del", text: "delete",
            onclick: (e) => { e.stopPropagation(); d.quotes.splice(i, 1); FR.doc.save(); FR.session.renderNotes(); } }),
          FR.el("div", { class: "note-quote", text: "“" + q.text + "”" }),
          q.note ? FR.el("div", { class: "note-text", text: q.note }) : null,
        ]);
        box.append(item);
      });
    },
  };
})();
