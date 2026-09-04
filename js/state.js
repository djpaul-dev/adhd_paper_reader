/* ============================================================
   state.js — shared namespace, storage, tiny helpers
   ============================================================ */
window.FR = window.FR || {};

FR.$ = (sel, root = document) => root.querySelector(sel);
FR.$$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

FR.el = (tag, props = {}, kids = []) => {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === "class") node.className = v;
    else if (k === "text") node.textContent = v;
    else if (k === "html") node.innerHTML = v;
    else if (k.startsWith("on") && typeof v === "function") node.addEventListener(k.slice(2), v);
    else if (v !== null && v !== undefined && v !== false) node.setAttribute(k, v);
  }
  for (const kid of [].concat(kids)) if (kid) node.append(kid);
  return node;
};

FR.escape = (s) =>
  String(s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

FR.todayKey = () => new Date().toISOString().slice(0, 10);

FR.toast = (() => {
  let t;
  return (msg, ms = 2200) => {
    const box = FR.$("#toast");
    box.textContent = msg;
    box.hidden = false;
    clearTimeout(t);
    t = setTimeout(() => (box.hidden = true), ms);
  };
})();

/* ---------- storage ---------- */
const NS = "focusreader:";
FR.store = {
  get(key, fallback) {
    try {
      const raw = localStorage.getItem(NS + key);
      return raw === null ? fallback : JSON.parse(raw);
    } catch {
      return fallback;
    }
  },
  set(key, value) {
    try {
      localStorage.setItem(NS + key, JSON.stringify(value));
    } catch (e) {
      console.warn("storage failed", e);
    }
  },
  remove(key) {
    try { localStorage.removeItem(NS + key); } catch {}
  },
};

/* ---------- per-document record ----------
   Keyed by name + byte size so reopening the same file restores work.  */
FR.doc = {
  key: null,
  data: null,
  open(file) {
    this.key = `doc:${file.name}:${file.size}`;
    const defaults = {
      name: file.name,
      goal: "",
      sectionsDone: {}, // sectionId -> true
      highlights: [],   // { para, note }
      quotes: [],       // { text, note }
      lastPara: 0,
    };
    this.data = Object.assign(defaults, FR.store.get(this.key, {}));
    FR.store.set("lastDoc", { name: file.name });
    return this.data;
  },
  save() {
    if (this.key) FR.store.set(this.key, this.data);
  },
};

/* ---------- global settings ---------- */
FR.settings = Object.assign(
  {
    theme: "sepia",
    fontFamily: "hyper",
    fontSize: 20,
    bionic: false,
    spotlight: true,
    ruler: false,
    sentenceMode: true, // step a sentence at a time, not a whole paragraph
    wpm: 220,
    timer: { focus: 25, short: 5, long: 20, chime: true },
    speech: { enabled: false, voice: "", rate: 1 },
    // parser: off = built-in browser parser | local = service on this machine
    //         cloud = GPU service (uploads the PDF)
    sidecar: {
      mode: "off",
      localUrl: "http://127.0.0.1:8077",
      cloudUrl: "",
      timeoutMs: 900000,
    },
  },
  FR.store.get("settings", {})
);
FR.settings.timer = Object.assign({ focus: 25, short: 5, long: 20, chime: true }, FR.settings.timer);
FR.settings.speech = Object.assign({ enabled: false, voice: "", rate: 1 }, FR.settings.speech);
FR.settings.sidecar = Object.assign(
  { mode: "off", localUrl: "http://127.0.0.1:8077", cloudUrl: "", timeoutMs: 900000 },
  FR.settings.sidecar
);
{
  // migrate the older { enabled, url } shape
  const s = FR.settings.sidecar;
  if (s.url !== undefined) {
    const remote = !/^https?:\/\/(localhost|127\.0\.0\.1)/i.test(s.url || "");
    if (remote && s.url) s.cloudUrl = s.url;
    else if (s.url) s.localUrl = s.url;
    if (s.mode === "off") s.mode = s.enabled ? (remote ? "cloud" : "local") : "off";
    delete s.url;
    delete s.enabled;
  }
  // a cold parse of a long paper runs past two minutes
  if (s.timeoutMs <= 120000) s.timeoutMs = 900000;
}
FR.saveSettings = () => FR.store.set("settings", FR.settings);

/* ---------- daily stats ---------- */
FR.stats = FR.store.get("stats", {}); // dateKey -> { minutes, sessions }
FR.addFocusMinutes = (min) => {
  const k = FR.todayKey();
  FR.stats[k] = FR.stats[k] || { minutes: 0, sessions: 0 };
  FR.stats[k].minutes += min;
  FR.store.set("stats", FR.stats);
};
FR.addCompletedSession = () => {
  const k = FR.todayKey();
  FR.stats[k] = FR.stats[k] || { minutes: 0, sessions: 0 };
  FR.stats[k].sessions += 1;
  FR.store.set("stats", FR.stats);
};
FR.currentStreak = () => {
  let streak = 0;
  const d = new Date();
  for (;;) {
    const key = d.toISOString().slice(0, 10);
    const rec = FR.stats[key];
    if (rec && rec.minutes > 0) {
      streak++;
      d.setDate(d.getDate() - 1);
    } else if (key === FR.todayKey()) {
      // today not counted yet — keep looking back from yesterday
      d.setDate(d.getDate() - 1);
    } else {
      break;
    }
  }
  return streak;
};
