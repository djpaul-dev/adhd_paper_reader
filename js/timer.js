/* ============================================================
   timer.js — Pomodoro-style focus blocks with real breaks
   ============================================================ */
(function () {
  let remaining = 0;       // seconds
  let phase = "focus";     // focus | short | long
  let running = false;
  let tickHandle = null;
  let completedInCycle = 0; // focus blocks done since last long break

  const cfg = () => FR.settings.timer;

  function fmt(s) {
    const m = Math.floor(s / 60);
    const r = Math.floor(s % 60);
    return `${m}:${String(r).padStart(2, "0")}`;
  }

  function chime(kind) {
    if (!cfg().chime) return;
    try {
      const AC = window.AudioContext || window.webkitAudioContext;
      const ac = new AC();
      const notes = kind === "focus" ? [523, 659, 784] : [784, 523];
      notes.forEach((f, i) => {
        const o = ac.createOscillator();
        const g = ac.createGain();
        o.type = "sine";
        o.frequency.value = f;
        o.connect(g);
        g.connect(ac.destination);
        const t0 = ac.currentTime + i * 0.18;
        g.gain.setValueAtTime(0.0001, t0);
        g.gain.exponentialRampToValueAtTime(0.25, t0 + 0.03);
        g.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.5);
        o.start(t0);
        o.stop(t0 + 0.55);
      });
      setTimeout(() => ac.close(), 1500);
    } catch {}
  }

  function notify(title, body) {
    if (window.Notification && Notification.permission === "granted") {
      try { new Notification(title, { body, silent: true }); } catch {}
    }
  }

  function render() {
    FR.$("#timer-display").textContent = fmt(remaining);
    FR.$("#timer-phase").textContent =
      phase === "focus" ? "Focus" : phase === "long" ? "Long break" : "Break";
    FR.$("#timer-toggle").textContent = running ? "Pause" : remaining ? "Resume" : "Start";
    FR.$(".focus-timer").classList.toggle("is-running", running);

    const dots = FR.$("#timer-dots");
    dots.innerHTML = "";
    for (let i = 0; i < 4; i++) {
      dots.append(FR.el("i", { class: i < completedInCycle ? "done" : "" }));
    }
    document.title =
      (running ? `${fmt(remaining)} · ` : "") + "Focus Reader";
  }

  function loadPhase(next) {
    phase = next;
    const mins = next === "focus" ? cfg().focus : next === "long" ? cfg().long : cfg().short;
    remaining = mins * 60;
    render();
  }

  function tick() {
    remaining -= 1;
    if (remaining <= 0) {
      remaining = 0;
      finishPhase();
    }
    render();
  }

  function finishPhase() {
    stop();
    if (phase === "focus") {
      FR.addFocusMinutes(cfg().focus);
      FR.addCompletedSession();
      completedInCycle += 1;
      FR.session.renderStats();
      const long = completedInCycle >= 4;
      if (long) completedInCycle = 0;
      chime("break");
      notify("Focus block done", "Time for a break. Stand up and look away.");
      openBreak(long ? "long" : "short");
    } else {
      chime("focus");
      notify("Break over", "Re-read your goal, then start the next block.");
      loadPhase("focus");
      FR.$("#break-overlay").hidden = true;
    }
  }

  /* ---- break overlay ---- */
  let breakInt = null;
  function openBreak(kind) {
    loadPhase(kind === "long" ? "long" : "short");
    const ov = FR.$("#break-overlay");
    FR.$("#break-title").textContent = kind === "long" ? "Long break — you earned it" : "Break time";
    FR.$("#break-copy").textContent =
      kind === "long"
        ? "Walk around for a few minutes. Get away from the screen entirely."
        : "Stand up. Look at something 20 feet away for 20 seconds. Drink water.";
    ov.hidden = false;
    start(); // count the break down automatically
    clearInterval(breakInt);
    breakInt = setInterval(() => {
      FR.$("#break-count").textContent = fmt(remaining);
      if (!running || remaining <= 0) clearInterval(breakInt);
    }, 250);
    FR.$("#break-count").textContent = fmt(remaining);
  }

  /* ---- controls ---- */
  function start() {
    if (running) return;
    if (!remaining) loadPhase(phase);
    running = true;
    if (window.Notification && Notification.permission === "default") {
      Notification.requestPermission().catch(() => {});
    }
    tickHandle = setInterval(tick, 1000);
    render();
  }
  function stop() {
    running = false;
    clearInterval(tickHandle);
    render();
  }
  function toggle() { running ? stop() : start(); }
  function reset() {
    stop();
    loadPhase("focus"); // cycle dot progress is kept on purpose
  }

  FR.timer = {
    init() {
      loadPhase("focus");
      FR.$("#timer-toggle").addEventListener("click", toggle);
      FR.$("#timer-reset").addEventListener("click", reset);

      const bind = (id, key) =>
        FR.$(id).addEventListener("change", (e) => {
          cfg()[key] = Math.max(1, +e.target.value || 1);
          FR.saveSettings();
          if (!running) loadPhase(phase);
        });
      bind("#set-focus", "focus");
      bind("#set-short", "short");
      bind("#set-long", "long");
      FR.$("#set-chime").addEventListener("change", (e) => {
        cfg().chime = e.target.checked; FR.saveSettings();
      });

      FR.$("#set-focus").value = cfg().focus;
      FR.$("#set-short").value = cfg().short;
      FR.$("#set-long").value = cfg().long;
      FR.$("#set-chime").checked = cfg().chime;

      FR.$("#break-skip").addEventListener("click", () => {
        stop(); clearInterval(breakInt);
        FR.$("#break-overlay").hidden = true;
        loadPhase("focus");
      });
      FR.$("#break-extend").addEventListener("click", () => {
        remaining += 5 * 60; render();
        FR.$("#break-count").textContent = fmt(remaining);
      });
      render();
    },
    toggle,
    isRunning: () => running,
  };
})();
