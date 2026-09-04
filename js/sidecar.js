/* ============================================================
   sidecar.js — where the paper gets parsed

   Three choices, and the reader always says which one it used:

     off    the built-in browser parser. Instant, no setup, guesses
            the layout from page geometry.
     local  a layout model running on this machine. Minutes per paper
            on CPU, and nothing leaves the computer.
     cloud  the same model on a GPU. Seconds per paper — but the PDF
            is uploaded to be parsed, so it is never the default and
            never silent.

   If the chosen service is unreachable, slow, or returns a layout that
   does not match the file, the reader falls back to the built-in parser
   and says so rather than pretending.
   ============================================================ */
(function () {
  const cfg = () => FR.settings.sidecar;

  const withTimeout = (ms) => {
    const c = new AbortController();
    const t = setTimeout(() => c.abort(), ms);
    return { signal: c.signal, done: () => clearTimeout(t) };
  };

  FR.sidecar = {
    status: "off", // off | checking | starting | loading | ready | timeout | down

    mode() {
      return cfg().mode || "off";
    },
    enabled() {
      return this.mode() !== "off" && !!this.url();
    },
    url() {
      return (this.mode() === "cloud" ? cfg().cloudUrl : cfg().localUrl) || "";
    },
    isRemote() {
      return this.mode() === "cloud";
    },
    host() {
      try {
        return new URL(this.url()).hostname;
      } catch {
        return this.url();
      }
    },

    // A remote endpoint may be cold-starting a container; 2s is a local budget.
    async health(timeoutMs) {
      if (!this.url()) return null;
      const t = withTimeout(timeoutMs || (this.isRemote() ? 15000 : 2500));
      try {
        const res = await fetch(this.url().replace(/\/+$/, "") + "/health", {
          signal: t.signal,
        });
        if (!res.ok) return null;
        return await res.json();
      } catch {
        return null;
      } finally {
        t.done();
      }
    },

    async parse(file) {
      if (!this.enabled()) return null;
      this.setStatus("loading");
      /* A cold parse runs for minutes. Poll the service for real page progress
         — "page 4 of 11" says how much longer; a bare timer does not. Falls
         back to elapsed seconds if the service reports no page count. */
      const began = Date.now();
      const secs = () => Math.round((Date.now() - began) / 1000);
      const paint = (text) => {
        const el = FR.$("#sidecar-status");
        if (el && this.status === "loading") el.textContent = text;
      };
      paint("reading the paper… 0s");
      clearInterval(this._tick);
      let polling = false;
      this._tick = setInterval(async () => {
        if (this.status !== "loading" || polling) return;
        polling = true;
        try {
          const h = await this.health(4000);
          const pr = h && h.progress;
          const mine = pr && pr.file === (file.name || "paper.pdf");
          if (mine && pr.total > 1) {
            const pct = Math.round((pr.done / pr.total) * 100);
            paint(`reading page ${pr.done + 1} of ${pr.total} — ${pct}% · ${secs()}s`);
            FR.$("#sidecar-bar").hidden = false;
            FR.$("#sidecar-bar-fill").style.width = pct + "%";
          } else if (pr && !mine) {
            // the service is busy with a different document; ours is queued
            paint(`waiting — the parser is busy with ${pr.file} · ${secs()}s`);
          } else {
            paint(`reading the paper… ${secs()}s`);
          }
        } catch {
          paint(`reading the paper… ${secs()}s`);
        } finally {
          polling = false;
        }
      }, 1500);

      const body = new FormData();
      body.append("file", file, file.name || "paper.pdf");
      const t = withTimeout(cfg().timeoutMs || 900000);
      try {
        const res = await fetch(this.url().replace(/\/+$/, "") + "/parse", {
          method: "POST",
          body,
          signal: t.signal,
        });
        if (!res.ok) {
          const detail = (await res.text()).slice(0, 200);
          console.warn("sidecar /parse failed", res.status, detail);
          this.setStatus("down");
          return null;
        }
        const data = await res.json();
        this.setStatus("ready");
        return data;
      } catch (e) {
        const abort = e.name === "AbortError";
        console.warn("sidecar parse failed", e.message);
        this.setStatus(abort ? "timeout" : "down");
        return null;
      } finally {
        clearInterval(this._tick);
        const bar = FR.$("#sidecar-bar");
        if (bar) bar.hidden = true;
        t.done();
      }
    },

    setStatus(s) {
      this.status = s;
      const el = FR.$("#sidecar-status");
      if (!el) return;
      el.textContent = {
        off: "off — using the built-in parser",
        checking: "checking…",
        starting: "starting up — loading models…",
        loading: "reading the paper…",
        ready: this.isRemote() ? `connected to ${this.host()}` : "connected (on this machine)",
        timeout: "took too long — using the built-in parser",
        down: "not reachable — using the built-in parser",
      }[s];
      el.className = "hint sidecar-status is-" + s;
      this.showRemoteWarning();
    },

    // a standing, unmissable note whenever the parser is not on this machine
    showRemoteWarning() {
      const w = FR.$("#sidecar-remote");
      if (!w) return;
      const remote = this.enabled() && this.isRemote();
      w.hidden = !remote;
      if (remote) {
        w.textContent = `Papers are uploaded to ${this.host()} to be parsed. They do not stay on this machine.`;
      }
    },

    async probe() {
      if (!this.enabled()) return this.setStatus("off");
      // a parse already in flight is proof enough that it is reachable
      if (this.status === "loading") return;
      this.setStatus("checking");
      const h = await this.health();
      if (!h) return this.setStatus("down");
      if (h.state === "loading") return this.setStatus("starting");
      if (!h.docling) {
        this.setStatus("down");
        const el = FR.$("#sidecar-status");
        if (el) el.textContent = "service up, but its parser failed to load: " + (h.detail || "");
        return;
      }
      this.setStatus("ready");
    },

    /* Choose where parsing happens and re-read the open paper straight away —
       no need to find the file again. */
    async setMode(mode) {
      if (mode === "cloud" && !cfg().cloudUrl) {
        this.syncControls();
        FR.toast("Add the GPU service URL first (Where it runs → GPU URL).", 6000);
        FR.$("#sidecar-where").open = true;
        FR.$("#sidecar-cloud-url").focus();
        return;
      }
      cfg().mode = mode;
      FR.saveSettings();
      this.syncControls();
      await this.probe();
      if (mode !== "off" && this.status !== "ready" && this.status !== "starting") {
        FR.toast(
          mode === "local"
            ? "Not running. Start it with:  cd sidecar && .venv/bin/python server.py"
            : "The GPU service did not answer. Check the URL, or deploy with:  modal deploy sidecar/modal_app.py",
          8000
        );
      }
      if (FR.app.lastFile) await FR.app.reparse();
      else this.showBadge();
    },

    // keep every control showing the same truth
    syncControls() {
      const mode = this.mode();
      FR.$$('input[name="parser-mode"]').forEach((r) => (r.checked = r.value === mode));
      const local = FR.$("#sidecar-local-url");
      const cloud = FR.$("#sidecar-cloud-url");
      if (local && document.activeElement !== local) local.value = cfg().localUrl || "";
      if (cloud && document.activeElement !== cloud) cloud.value = cfg().cloudUrl || "";
      this.showRemoteWarning();
    },

    init() {
      FR.$$('input[name="parser-mode"]').forEach((radio) =>
        radio.addEventListener("change", () => radio.checked && this.setMode(radio.value))
      );
      const bind = (sel, key) => {
        const el = FR.$(sel);
        el.addEventListener("change", () => {
          cfg()[key] = el.value.trim();
          FR.saveSettings();
          this.syncControls();
          this.probe();
        });
      };
      bind("#sidecar-local-url", "localUrl");
      bind("#sidecar-cloud-url", "cloudUrl");

      FR.$("#sidecar-recheck").addEventListener("click", () => this.probe());
      FR.$("#sidecar-reparse").addEventListener("click", () => FR.app.reparse());

      /* The badge by the document title is the one-click switch: it flips
         between the built-in parser and whichever service you last chose. */
      FR.$("#parser-pill").addEventListener("click", () => {
        if (this.mode() !== "off") {
          this._last = this.mode();
          return this.setMode("off");
        }
        this.setMode(this._last || (cfg().cloudUrl ? "cloud" : "local"));
      });

      this.syncControls();
      this.probe();
    },

    /* The badge by the document title: which parser produced what you are
       reading, and a one-click switch. It must never quietly claim the
       accurate parser ran when it did not. */
    showBadge() {
      const pill = FR.$("#parser-pill");
      this.syncControls(); // panel and badge must never disagree
      if (!FR.pdf.doc) {
        pill.hidden = true;
        return;
      }
      pill.hidden = false;
      const viaModel = FR.pdf.source !== "geometry";
      const wanted = this.enabled();

      if (viaModel) {
        const remote = this.isRemote();
        pill.textContent = remote ? "☁ accurate" : "✓ accurate";
        pill.className = "pill pill-model";
        pill.title =
          `Structure from the ${FR.pdf.source} parser — ${Math.round(FR.pdf.coverage * 100)}% of the page text matched.\n` +
          (remote ? `This paper was uploaded to ${this.host()} to be parsed.\n` : "Parsed on this machine.\n") +
          `Click to switch back to the built-in parser.`;
      } else if (wanted) {
        // asked for, but did not happen — say so rather than degrade silently
        pill.textContent = "⚠ built-in";
        pill.className = "pill pill-warn";
        pill.title =
          `The accurate parser was requested but ${FR.pdf.sourceReason || "was unavailable"}, ` +
          `so this was read with the built-in parser.\nStart it with:  cd sidecar && .venv/bin/python server.py\n` +
          `Click to turn the request off.`;
      } else {
        pill.textContent = "built-in";
        pill.className = "pill pill-muted";
        pill.title =
          "Read with the built-in browser parser — fast, no setup, but it guesses the layout from page geometry.\n" +
          "Click to use the local accurate parser instead.";
      }
    },
  };
})();
