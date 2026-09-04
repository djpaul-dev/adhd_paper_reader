/* ============================================================
   ai.js — OPTIONAL. Plain-language help via the Anthropic API.
   The API key is kept in localStorage on this device only.
   Paper text is sent to Anthropic when you press one of the buttons.
   ============================================================ */
(function () {
  const KEY = "anthropicKey";
  const getKey = () => FR.store.get(KEY, "");
  const model = () => FR.$("#ai-model").value;

  function showTools(has) {
    FR.$("#ai-locked").hidden = has;
    FR.$("#ai-tools").hidden = !has;
  }

  async function ask(system, user) {
    const key = getKey();
    if (!key) return FR.toast("Add an API key first.");
    const out = FR.$("#ai-output");
    out.textContent = "Thinking…";
    try {
      const res = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": key,
          "anthropic-version": "2023-06-01",
          "anthropic-dangerous-direct-browser-access": "true",
        },
        body: JSON.stringify({
          model: model(),
          max_tokens: 1024,
          system,
          messages: [{ role: "user", content: user }],
        }),
      });
      if (!res.ok) {
        const t = await res.text();
        out.textContent = `Request failed (${res.status}).\n${t.slice(0, 300)}`;
        return;
      }
      const data = await res.json();
      out.textContent = (data.content || []).map((c) => c.text || "").join("\n").trim() || "(no reply)";
    } catch (e) {
      out.textContent = "Network error: " + e.message +
        "\n\nBrowsers may block this call unless the key/account allows direct browser access.";
    }
  }

  function paperText(limit = 14000) {
    return FR.pdf.paragraphs.map((p) => (p.heading ? "\n## " : "") + p.text).join("\n\n").slice(0, limit);
  }
  function currentSectionText(limit = 8000) {
    const secs = FR.pdf.sections || [];
    const cur = FR.app.activeIndex();
    let startPara = 0, endPara = FR.pdf.paragraphs.length;
    for (let i = 0; i < secs.length; i++) {
      if (secs[i].para <= cur) { startPara = secs[i].para; endPara = secs[i + 1] ? secs[i + 1].para : endPara; }
    }
    return FR.pdf.paragraphs.slice(startPara, endPara).map((p) => p.text).join("\n\n").slice(0, limit);
  }

  const SYS =
    "You help a reader with ADHD get through a research paper. Be concrete and brief. " +
    "Use short paragraphs and bullet points. Lead with the single most important takeaway. " +
    "Plain language, define jargon in passing, no filler, no preamble.";

  FR.ai = {
    init() {
      if (getKey()) {
        showTools(true);
        FR.$("#ai-model").value = FR.store.get("anthropicModel", "claude-haiku-4-5-20251001");
      }
      FR.$("#ai-save-key").addEventListener("click", () => {
        const v = FR.$("#ai-key").value.trim();
        if (!v) return FR.toast("Paste a key first.");
        FR.store.set(KEY, v);
        FR.store.set("anthropicModel", model());
        FR.$("#ai-key").value = "";
        showTools(true);
        FR.toast("Key saved on this device.");
      });
      FR.$("#ai-model").addEventListener("change", () => FR.store.set("anthropicModel", model()));
      FR.$("#ai-forget").addEventListener("click", () => {
        FR.store.remove(KEY);
        showTools(false);
        FR.$("#ai-output").textContent = "";
        FR.toast("Key removed.");
      });

      FR.$("#ai-tldr").addEventListener("click", () => {
        if (!FR.pdf.doc) return FR.toast("Open a paper first.");
        const goal = FR.doc.data.goal ? `The reader's goal: "${FR.doc.data.goal}". ` : "";
        ask(SYS,
          goal +
          "Give a TL;DR of this paper in ~150 words: the problem, what they did, the main result with numbers if stated, and the biggest caveat. Then 3 bullets: 'Read closely if…', 'Skim if…', 'Skip if…'.\n\n" +
          paperText());
      });
      FR.$("#ai-section").addEventListener("click", () => {
        if (!FR.pdf.doc) return FR.toast("Open a paper first.");
        ask(SYS, "Summarise this section in 4-6 bullets, then one sentence on why it matters for the paper's argument.\n\n" + currentSectionText());
      });
      FR.$("#ai-explain").addEventListener("click", () => {
        const sel = String(window.getSelection() || "").trim() || FR.ai._lastSelection || "";
        if (!sel) return FR.toast("Select some text in the paper first.");
        ask(SYS, "Explain this passage simply, as if to a smart undergrad. Note any hidden assumptions.\n\nPASSAGE:\n" + sel);
      });
    },
    explainSelection(text) {
      this._lastSelection = text;
      FR.app.setPanel("right", true);
      ask(SYS, "Explain this passage simply, as if to a smart undergrad. Note any hidden assumptions.\n\nPASSAGE:\n" + text);
    },
  };
})();
