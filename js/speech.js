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
  // Ceiling for the speed slider. The Web Speech spec allows 0.1–10, but most
  // engines quietly stop getting faster well before that — Windows SAPI voices
  // map onto a coarse scale that tops out around 3x, and Chrome's network-backed
  // "Google ..." voices are synthesised at a fixed rate and ignore the setting
  // outright. Slider travel that changes nothing reads as a broken control, so
  // this stays at a value voices actually honour.
  const MAX_RATE = 2;
  const fmtRate = (r) => (Math.round(+r * 100) / 100).toString().replace(/\.0+$/, "") + "×";

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
      // Chrome processes cancel() asynchronously: a speak() issued in the same
      // tick lands while the queue is still draining and gets dropped on the
      // floor — silently, with no error event. Only wait when there is actually
      // something to cancel, so the common case stays instant.
      const wasBusy = speaking || synth.speaking || synth.pending;
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
        u.rate = Math.min(MAX_RATE, Math.max(0.5, +cfg().rate || 1));
        u.onend = sayNext;
        u.onerror = (e) => {
          // "interrupted"/"canceled" just means we moved on deliberately
          if (my !== gen || e.error === "interrupted" || e.error === "canceled") return;
          console.warn("speech error", e.error);
          sayNext();
        };
        synth.speak(u);
      };
      if (wasBusy) setTimeout(sayNext, 80);
      else sayNext();
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
      rate.max = MAX_RATE;
      // via setRate so a rate saved under an older, higher cap is pulled back
      // into range instead of leaving the slider and the label disagreeing
      this.setRate(cfg().rate, false);
      // While dragging, only the label moves. Restarting the utterance on every
      // "input" tick would cancel-and-respeak dozens of times a second and the
      // voice would just stall. "change" fires once, on release (and once per
      // press for the keyboard arrows), which is where the new rate is applied.
      rate.addEventListener("input", (e) => this.setRate(+e.target.value, false));
      rate.addEventListener("change", (e) => this.setRate(+e.target.value, true));

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

    /* Changing speed mid-sentence should take effect now, not at the next one —
       otherwise it feels broken on a long paragraph. Re-speak from the top of
       the current sentence at the new rate. */
    setRate(r, apply = true) {
      cfg().rate = Math.round(Math.min(MAX_RATE, Math.max(0.5, r)) * 100) / 100;
      FR.saveSettings();
      FR.$("#speech-rate").value = cfg().rate;
      this.showRate();
      // An utterance's rate is fixed once it starts, so the only way to hear the
      // change now rather than at the next sentence is to re-speak this one.
      if (!apply) return;
      if (FR.pace.running) FR.pace.resync();
      else if (speaking) this.speak(FR.app.activeText());
    },

    showRate() {
      FR.$("#speech-rate-val").textContent = fmtRate(cfg().rate);
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
