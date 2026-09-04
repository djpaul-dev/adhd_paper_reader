/* ============================================================
   speech.js — read the spotlighted paragraph aloud
   Uses the browser's built-in speech synthesis (no network, no key).
   Long text is spoken in sentence-sized chunks: Chrome silently
   truncates utterances longer than ~15 seconds.
   ============================================================ */
(function () {
  const synth = window.speechSynthesis;
  let voices = [];
  let gen = 0;       // generation token — invalidates callbacks after cancel()
  let speaking = false;

  const cfg = () => FR.settings.speech;

  function chunk(text, max = 220) {
    const out = [];
    const sentences = String(text)
      .replace(/\s+/g, " ")
      .trim()
      .match(/[^.!?]+[.!?]*\s*/g) || [text];
    let buf = "";
    for (const s of sentences) {
      if ((buf + s).length > max && buf) {
        out.push(buf.trim());
        buf = "";
      }
      // a single sentence longer than max: split on commas, then hard-split
      if (s.length > max) {
        if (buf) { out.push(buf.trim()); buf = ""; }
        let rest = s;
        while (rest.length > max) {
          let cut = rest.lastIndexOf(",", max);
          if (cut < max * 0.4) cut = rest.lastIndexOf(" ", max);
          if (cut < max * 0.4) cut = max;
          out.push(rest.slice(0, cut + 1).trim());
          rest = rest.slice(cut + 1);
        }
        buf = rest;
      } else {
        buf += s;
      }
    }
    if (buf.trim()) out.push(buf.trim());
    return out.filter(Boolean);
  }

  function pickVoice() {
    if (!voices.length) return null;
    const want = cfg().voice;
    return voices.find((v) => v.voiceURI === want) || voices.find((v) => v.default) || voices[0];
  }

  FR.speech = {
    supported() {
      return !!synth && typeof window.SpeechSynthesisUtterance === "function";
    },
    speaking() {
      return speaking;
    },

    speak(text, onend) {
      if (!this.supported() || !text) {
        onend && onend();
        return;
      }
      const my = ++gen;
      try { synth.cancel(); } catch {}
      const parts = chunk(text);
      const voice = pickVoice();
      speaking = true;
      FR.$("#paper-spotlight").classList.add("is-speaking");
      FR.$("#spot-speak").classList.add("is-on");

      let i = 0;
      const sayNext = () => {
        if (my !== gen) return;
        if (i >= parts.length) {
          speaking = false;
          FR.$("#paper-spotlight").classList.remove("is-speaking");
          FR.$("#spot-speak").classList.remove("is-on");
          onend && onend();
          return;
        }
        const u = new SpeechSynthesisUtterance(parts[i++]);
        if (voice) { u.voice = voice; u.lang = voice.lang; }
        u.rate = Math.min(2, Math.max(0.5, +cfg().rate || 1));
        u.onend = sayNext;
        u.onerror = (e) => {
          // "interrupted"/"canceled" just means we moved on deliberately
          if (my !== gen || e.error === "interrupted" || e.error === "canceled") return;
          console.warn("speech error", e.error);
          sayNext();
        };
        synth.speak(u);
      };
      sayNext();
    },

    cancel() {
      gen++;
      speaking = false;
      try { synth.cancel(); } catch {}
      const s = FR.$("#paper-spotlight");
      if (s) s.classList.remove("is-speaking");
      const b = FR.$("#spot-speak");
      if (b) b.classList.remove("is-on");
    },

    fillVoices() {
      const sel = FR.$("#voice-select");
      if (!sel) return;
      const all = synth.getVoices() || [];
      const isEn = (v) => /^en/i.test(v.lang);
      voices = all.filter(isEn).concat(all.filter((v) => !isEn(v))); // English first
      sel.innerHTML = "";
      voices.forEach((v) => {
        sel.append(FR.el("option", { value: v.voiceURI, text: `${v.name} (${v.lang})` }));
      });
      if (cfg().voice) sel.value = cfg().voice;
      if (!sel.value && voices.length) {
        const d = pickVoice();
        if (d) sel.value = d.voiceURI;
      }
      // some platforms expose no voice list; the default voice still speaks
      sel.hidden = voices.length === 0;
    },

    init() {
      const chip = FR.$("#tb-speak");
      if (!this.supported()) {
        chip.classList.add("is-disabled");
        chip.setAttribute("disabled", "");
        chip.title = "This browser has no speech synthesis";
        return;
      }
      this.fillVoices();
      if ("onvoiceschanged" in synth) {
        synth.addEventListener("voiceschanged", () => this.fillVoices());
      }

      FR.$("#voice-select").addEventListener("change", (e) => {
        cfg().voice = e.target.value;
        FR.saveSettings();
      });
      const rate = FR.$("#speech-rate");
      rate.value = cfg().rate;
      FR.$("#speech-rate-val").textContent = (+cfg().rate).toFixed(2).replace(/0$/, "") + "×";
      rate.addEventListener("input", (e) => {
        cfg().rate = +e.target.value;
        FR.$("#speech-rate-val").textContent = (+cfg().rate).toFixed(2).replace(/0$/, "") + "×";
        FR.saveSettings();
      });

      // "Read aloud" mode toggle
      chip.addEventListener("click", () => {
        cfg().enabled = !cfg().enabled;
        FR.saveSettings();
        this.applyChip();
        if (cfg().enabled) FR.app.onSpotlightMoved(true);
        else this.cancel();
      });

      // one-shot: speak the current paragraph now (or stop)
      FR.$("#spot-speak").addEventListener("click", () => {
        // during auto-pace, re-read through the pacer so it still advances after
        if (FR.pace.running) return FR.pace.resync();
        if (speaking) return this.cancel();
        this.speak(FR.app.activeText());
      });

      this.applyChip();
      window.addEventListener("beforeunload", () => this.cancel());
    },

    applyChip() {
      const on = cfg().enabled && this.supported();
      FR.$("#tb-speak").classList.toggle("is-active", on);
      FR.$("#speech-controls").hidden = !on;
      // when the voice paces the reading, words-per-minute is meaningless
      FR.$("#wpm-label").hidden = on;
    },
  };
})();
