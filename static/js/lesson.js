// Lesson replay (2.9.1): record a lesson as you write it, with your voice if
// you like, and play it back stroke by stroke in time with what you said.
//
// A teacher explains a topic once; every student can watch it again, at
// 1x, 1.5x or 2x, as often as they need.
//
// Recording keeps three things: the page as it was when you pressed Record
// (the baseline), every stroke added after that with the time of each point
// (points already carry their pointer-event time), and when any stroke left
// the page (an undo or an erase). Audio, if you allowed the microphone, is a
// MediaRecorder track. All of it is saved on this device, in the IndexedDB
// database inkyscib_lessons. Nothing is uploaded.
//
// Playback happens in the editor itself, so every stroke is drawn by the real
// renderer: the canvas shows the lesson's ink in place of the page's while
// the player is open. Saving is paused and the canvas does not take input
// meanwhile, and closing the player puts the page back exactly.
(() => {
  "use strict";

  const DB_NAME = "inkyscib_lessons";
  const STORE = "lessons";
  const POLL_MS = 200;
  const SPEEDS = [1, 1.5, 2];

  const s = () => window.appState;
  const icon = (ref) => { try { return window.Inkyscib?.Icon?.svg?.(ref) || ""; } catch (_) { return ""; } };
  const notify = (m, tone) => window.Inkyscib?.notify?.(m, { tone: tone || "success" });
  const clone = (v) => (typeof structuredClone === "function" ? structuredClone(v) : JSON.parse(JSON.stringify(v)));

  // ---------- storage ----------

  function db() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => req.result.createObjectStore(STORE, { keyPath: "id" });
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  async function tx(mode, fn) {
    const d = await db();
    return new Promise((resolve, reject) => {
      const t = d.transaction(STORE, mode);
      const out = fn(t.objectStore(STORE));
      t.oncomplete = () => { d.close(); resolve(out && "result" in out ? out.result : undefined); };
      t.onerror = () => { d.close(); reject(t.error); };
    });
  }
  const saveLesson = (lesson) => tx("readwrite", (st) => st.put(lesson));
  const listLessons = () => tx("readonly", (st) => st.getAll());
  const deleteLesson = (id) => tx("readwrite", (st) => st.delete(id));

  // ---------- recording ----------

  let rec = null;

  function fmt(ms) {
    const total = Math.max(0, Math.round(ms / 1000));
    return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
  }

  async function startRecording({ voice = true } = {}) {
    if (rec || play) return false;
    const st = s();
    if (!st) return false;
    let stream = null;
    let recorder = null;
    const chunks = [];
    if (voice && navigator.mediaDevices?.getUserMedia && typeof MediaRecorder !== "undefined") {
      try {
        stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        recorder = new MediaRecorder(stream);
        recorder.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };
        recorder.start(1000);
      } catch (_) {
        stream = null;
        recorder = null;
        notify("Recording the ink only: the microphone was not available.", "muted");
      }
    }
    const ids = new WeakMap();
    let next = 0;
    const idOf = (p) => { if (!ids.has(p)) ids.set(p, ++next); return ids.get(p); };
    const baseline = (st.paths || []).map((p) => ({ id: idOf(p), path: clone(p) }));
    rec = {
      t0: performance.now(),
      wall0: Date.now(),
      stream, recorder, chunks,
      ids, idOf,
      baseline,
      seen: new Set((st.paths || []).map(idOf)),
      live: new Map((st.paths || []).map((p) => [idOf(p), p])),
      removed: [],
      added: new Map(),
      timer: window.setInterval(poll, POLL_MS)
    };
    document.body.classList.add("lesson-recording");
    showRecPill();
    return true;
  }

  // Four times a second: which strokes arrived, which left. A stroke's own
  // point times are used for drawing it; this only dates arrivals and exits.
  function poll() {
    if (!rec) return;
    const now = performance.now() - rec.t0;
    const paths = s()?.paths || [];
    const present = new Set();
    for (const p of paths) {
      const id = rec.idOf(p);
      present.add(id);
      if (!rec.seen.has(id)) {
        rec.seen.add(id);
        rec.added.set(id, { at: now, ref: p });
      }
      rec.live.set(id, p);
    }
    for (const [id] of rec.live) {
      if (!present.has(id)) {
        rec.live.delete(id);
        rec.removed.push({ id, at: now });
      }
    }
    const pill = document.getElementById("lessonRecPill");
    if (pill) pill.querySelector(".lesson-rec-time").textContent = fmt(now);
  }

  function timed(path, at, t0) {
    // Each point's time relative to the start. Write assist's tidy resamples a
    // stroke on lift, and resampled points carry no time of their own, so the
    // gaps are filled by spreading time along the stroke's length, from its
    // first known moment to when it arrived. A stroke with no times at all
    // (a shape, a construction) appears whole at the moment it arrived.
    const c = clone(path);
    const pts = Array.isArray(c.points) ? c.points : [];
    const known = [];
    pts.forEach((p, i) => {
      const t = path.points?.[i]?.time;
      if (Number.isFinite(t)) known.push({ i, t: t - t0 });
    });
    if (!pts.length) return { start: at, path: c };
    if (!known.length) {
      pts.forEach((p) => { p.lt = at; });
      return { start: at, path: c };
    }
    // Arc length at each point, to share time out by distance drawn.
    const len = [0];
    for (let i = 1; i < pts.length; i += 1) {
      len.push(len[i - 1] + Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y));
    }
    const total = len[len.length - 1] || 1;
    const first = Math.max(0, known[0].t);
    const lastKnown = known[known.length - 1];
    // Arrival is dated by the poll, up to POLL_MS after the lift.
    const end = known.length > 1 && lastKnown.i === pts.length - 1 ? lastKnown.t : Math.max(first + 60, at - POLL_MS / 2);
    pts.forEach((p, i) => {
      const exact = known.find((k) => k.i === i);
      p.lt = exact && known.length > pts.length * 0.8 ? Math.max(0, exact.t) : first + (end - first) * (len[i] / total);
    });
    return { start: first, path: c };
  }

  async function stopRecording({ save = true } = {}) {
    if (!rec) return null;
    poll();
    window.clearInterval(rec.timer);
    const r = rec;
    rec = null;
    document.body.classList.remove("lesson-recording");
    hideRecPill();
    const duration = performance.now() - r.t0;
    let audio = null;
    if (r.recorder) {
      await new Promise((resolve) => {
        r.recorder.onstop = resolve;
        try { r.recorder.stop(); } catch (_) { resolve(); }
      });
      audio = r.chunks.length ? new Blob(r.chunks, { type: r.recorder.mimeType || "audio/webm" }) : null;
    }
    r.stream?.getTracks().forEach((t) => t.stop());
    if (!save) return null;
    const strokes = [...r.added.entries()].map(([id, a]) => ({ id, ...timed(a.ref, a.at, r.t0) }));
    if (!strokes.length && !r.removed.length) {
      notify("Nothing was written, so no lesson was saved.", "muted");
      return null;
    }
    const when = new Date(r.wall0);
    const lesson = {
      id: "lesson-" + r.wall0,
      name: "Lesson, " + when.toLocaleDateString(undefined, { day: "numeric", month: "short" }) + ", " +
        when.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" }),
      createdAt: r.wall0,
      duration,
      baseline: r.baseline,
      strokes,
      removed: r.removed,
      audio
    };
    try {
      await saveLesson(lesson);
      notify(`Lesson saved (${fmt(duration)}). Find it under Tools, Lessons.`);
    } catch (_) {
      notify("The lesson could not be saved on this device.", "error");
      return null;
    }
    return lesson;
  }

  // ---------- the REC pill ----------

  function showRecPill() {
    let pill = document.getElementById("lessonRecPill");
    if (!pill) {
      pill = document.createElement("div");
      pill.id = "lessonRecPill";
      pill.className = "lesson-rec";
      pill.setAttribute("role", "status");
      pill.innerHTML = `<span class="lesson-rec-dot" aria-hidden="true"></span>
        <span class="lesson-rec-label">Recording</span><span class="lesson-rec-time">0:00</span>
        <button type="button" class="lesson-rec-stop">Stop and save</button>
        <button type="button" class="lesson-rec-cancel" aria-label="Discard this recording">${icon("lucide:x")}</button>`;
      pill.querySelector(".lesson-rec-stop").addEventListener("click", () => stopRecording());
      pill.querySelector(".lesson-rec-cancel").addEventListener("click", () => stopRecording({ save: false }));
      document.body.appendChild(pill);
    }
    pill.querySelector(".lesson-rec-voice")?.remove();
    pill.querySelector(".lesson-rec-label").textContent = rec?.recorder ? "Recording with voice" : "Recording ink";
    pill.hidden = false;
  }
  function hideRecPill() {
    const pill = document.getElementById("lessonRecPill");
    if (pill) pill.hidden = true;
  }

  // ---------- playback ----------

  let play = null;

  // What is on the page at time t: the baseline, less what left by t, plus
  // every stroke started by t, cut to the points drawn by t.
  function frameAt(lesson, t) {
    const gone = new Set(lesson.removed.filter((r) => r.at <= t).map((r) => r.id));
    const out = [];
    for (const b of lesson.baseline) if (!gone.has(b.id)) out.push(b.path);
    for (const k of lesson.strokes) {
      if (k.start > t || gone.has(k.id)) continue;
      const pts = k.path.points || [];
      const upto = pts.filter((p) => p.lt <= t);
      if (!upto.length) continue;
      out.push(upto.length === pts.length ? k.path : { ...k.path, points: upto });
    }
    return out;
  }

  function draw(paths) {
    const st = s();
    st.paths = paths;
    if (typeof window.invalidateCanvasDrawingCache === "function") window.invalidateCanvasDrawingCache();
    if (typeof window.render === "function") window.render();
  }

  async function openPlayer(lesson) {
    if (rec || play) return false;
    const st = s();
    // The page is saved as it is first, then nothing is written until the
    // player closes: storage.js's flushDrawingSave checks lessonPlayback, so
    // even a tab closed mid-lesson cannot save the lesson's ink as the page.
    try { await window.saveDrawing?.({ force: true }); } catch (_) { /* best effort */ }
    const original = st.paths;
    const saveDrawing = window.saveDrawing;
    st.lessonPlayback = true;
    window.saveDrawing = () => Promise.resolve(null);
    const audio = lesson.audio ? new Audio(URL.createObjectURL(lesson.audio)) : null;
    if (audio) audio.preload = "auto";
    play = {
      lesson, original, saveDrawing, audio,
      speed: 1, playing: false, t: 0, clockAt: 0, clockT: 0, raf: 0
    };
    document.body.classList.add("lesson-playing");
    buildPlayer();
    seek(0);
    start();
    return true;
  }

  function now() {
    if (!play) return 0;
    if (play.audio && !play.audio.paused && play.audio.currentTime * 1000 <= play.lesson.duration) return play.audio.currentTime * 1000;
    if (!play.playing) return play.t;
    return play.clockT + (performance.now() - play.clockAt) * play.speed;
  }

  function tick() {
    if (!play) return;
    const t = Math.min(now(), play.lesson.duration);
    if (Math.abs(t - play.drawnAt) > 15 || t === play.lesson.duration) {
      play.drawnAt = t;
      draw(frameAt(play.lesson, t));
    }
    play.t = t;
    syncPlayer();
    if (t >= play.lesson.duration) { pause(); return; }
    if (play.playing) play.raf = window.requestAnimationFrame(tick);
  }

  function start() {
    if (!play) return;
    if (play.t >= play.lesson.duration) seek(0);
    play.playing = true;
    play.clockAt = performance.now();
    play.clockT = play.t;
    if (play.audio) {
      play.audio.playbackRate = play.speed;
      play.audio.currentTime = play.t / 1000;
      play.audio.play().catch(() => {});
    }
    window.cancelAnimationFrame(play.raf);
    play.raf = window.requestAnimationFrame(tick);
    syncPlayer();
  }

  function pause() {
    if (!play) return;
    play.t = Math.min(now(), play.lesson.duration);
    play.playing = false;
    play.audio?.pause();
    window.cancelAnimationFrame(play.raf);
    syncPlayer();
  }

  function seek(t) {
    if (!play) return;
    play.t = Math.max(0, Math.min(t, play.lesson.duration));
    play.clockAt = performance.now();
    play.clockT = play.t;
    if (play.audio) { try { play.audio.currentTime = play.t / 1000; } catch (_) { /* not loaded yet */ } }
    play.drawnAt = -1;
    draw(frameAt(play.lesson, play.t));
    syncPlayer();
  }

  function setSpeed(speed) {
    if (!play) return;
    const wasPlaying = play.playing;
    if (wasPlaying) pause();
    play.speed = speed;
    if (play.audio) play.audio.playbackRate = speed;
    if (wasPlaying) start();
    syncPlayer();
  }

  function closePlayer() {
    if (!play) return;
    pause();
    const p = play;
    play = null;
    if (p.audio) { URL.revokeObjectURL(p.audio.src); p.audio.src = ""; }
    draw(p.original);
    s().lessonPlayback = false;
    window.saveDrawing = p.saveDrawing;
    document.body.classList.remove("lesson-playing");
    document.getElementById("lessonPlayer")?.remove();
    document.getElementById("lessonShield")?.remove();
  }

  function buildPlayer() {
    // A shield over the canvas: the lesson is for watching, and a stroke
    // drawn now would land in a borrowed page.
    const shield = document.createElement("div");
    shield.id = "lessonShield";
    shield.className = "lesson-shield";
    document.body.appendChild(shield);
    const bar = document.createElement("div");
    bar.id = "lessonPlayer";
    bar.className = "lesson-player";
    bar.setAttribute("role", "region");
    bar.setAttribute("aria-label", "Lesson player");
    bar.innerHTML = `
      <button type="button" class="lesson-play" aria-label="Play">${icon("lucide:play")}</button>
      <span class="lesson-time"><span class="lesson-now">0:00</span> / ${fmt(play.lesson.duration)}</span>
      <input type="range" class="lesson-scrub" min="0" max="${Math.round(play.lesson.duration)}" step="10" value="0" aria-label="Position in the lesson">
      <button type="button" class="lesson-speed" aria-label="Playback speed">1x</button>
      <button type="button" class="lesson-close" aria-label="Close the lesson">${icon("lucide:x")}</button>
      <span class="lesson-name"></span>`;
    bar.querySelector(".lesson-name").textContent = play.lesson.name + (play.lesson.audio ? "" : " (no voice)");
    bar.querySelector(".lesson-play").addEventListener("click", () => (play?.playing ? pause() : start()));
    bar.querySelector(".lesson-scrub").addEventListener("input", (e) => { const was = play.playing; pause(); seek(+e.target.value); if (was) start(); });
    bar.querySelector(".lesson-speed").addEventListener("click", () => {
      const i = SPEEDS.indexOf(play.speed);
      setSpeed(SPEEDS[(i + 1) % SPEEDS.length]);
    });
    bar.querySelector(".lesson-close").addEventListener("click", closePlayer);
    document.body.appendChild(bar);
  }

  function syncPlayer() {
    const bar = document.getElementById("lessonPlayer");
    if (!bar || !play) return;
    bar.querySelector(".lesson-now").textContent = fmt(play.t);
    const scrub = bar.querySelector(".lesson-scrub");
    if (document.activeElement !== scrub) scrub.value = Math.round(play.t);
    scrub.style.setProperty("--p", (play.t / Math.max(1, play.lesson.duration)) * 100 + "%");
    const btn = bar.querySelector(".lesson-play");
    btn.innerHTML = icon(play.playing ? "lucide:pause" : "lucide:play");
    btn.setAttribute("aria-label", play.playing ? "Pause" : "Play");
    bar.querySelector(".lesson-speed").textContent = play.speed + "x";
  }

  // ---------- the lessons sheet ----------

  async function openSheet() {
    closeSheet();
    const sheet = document.createElement("div");
    sheet.id = "lessonSheet";
    sheet.className = "lesson-sheet";
    sheet.setAttribute("role", "dialog");
    sheet.setAttribute("aria-modal", "true");
    sheet.setAttribute("aria-label", "Lessons");
    sheet.innerHTML = `<div class="lesson-card">
        <div class="lesson-head"><h2>Lessons</h2>
          <button type="button" class="lesson-sheet-close" aria-label="Close">${icon("lucide:x")}</button></div>
        <p class="lesson-intro">Record what you write, and your voice if you like, then play it back stroke by stroke. Lessons stay on this device.</p>
        <div class="lesson-actions">
          <button type="button" class="lesson-new" data-voice="on">${icon("lucide:volume-2")}<span>Record with voice</span></button>
          <button type="button" class="lesson-new" data-voice="off">${icon("lucide:circle")}<span>Record ink only</span></button>
        </div>
        <ul class="lesson-list" aria-label="Saved lessons"></ul>
      </div>`;
    sheet.addEventListener("click", (e) => { if (e.target === sheet) closeSheet(); });
    sheet.querySelector(".lesson-sheet-close").addEventListener("click", closeSheet);
    sheet.querySelectorAll(".lesson-new").forEach((b) => b.addEventListener("click", async () => {
      closeSheet();
      await startRecording({ voice: b.dataset.voice === "on" });
    }));
    document.body.appendChild(sheet);
    sheet.addEventListener("keydown", (e) => { if (e.key === "Escape") closeSheet(); });
    sheet.querySelector(".lesson-new").focus();
    await renderList();
  }

  async function renderList() {
    const list = document.querySelector("#lessonSheet .lesson-list");
    if (!list) return;
    let lessons = [];
    try { lessons = await listLessons(); } catch (_) { /* storage blocked */ }
    lessons.sort((a, b) => b.createdAt - a.createdAt);
    if (!lessons.length) {
      list.innerHTML = `<li class="lesson-empty">No lessons yet.</li>`;
      return;
    }
    list.innerHTML = "";
    for (const l of lessons) {
      const li = document.createElement("li");
      li.className = "lesson-item";
      li.innerHTML = `<button type="button" class="lesson-open">${icon("lucide:play")}<span class="lesson-item-name"></span>
          <span class="lesson-item-meta"></span></button>
        <button type="button" class="lesson-delete" aria-label="Delete this lesson">${icon("lucide:trash")}</button>`;
      li.querySelector(".lesson-item-name").textContent = l.name;
      li.querySelector(".lesson-item-meta").textContent = `${fmt(l.duration)} · ${l.strokes.length} strokes${l.audio ? " · voice" : ""}`;
      li.querySelector(".lesson-open").addEventListener("click", () => { closeSheet(); openPlayer(l); });
      li.querySelector(".lesson-delete").addEventListener("click", async () => {
        if (!window.confirm(`Delete "${l.name}"? This cannot be undone.`)) return;
        await deleteLesson(l.id);
        renderList();
      });
      list.appendChild(li);
    }
  }

  function closeSheet() { document.getElementById("lessonSheet")?.remove(); }

  // While a lesson plays, the keyboard drives the player and nothing else:
  // Ctrl+N or a tool letter must not act on a page that is only borrowed.
  document.addEventListener("keydown", (e) => {
    if (!play) return;
    const inPlayer = !!e.target?.closest?.("#lessonPlayer");
    const onScrub = !!e.target?.classList?.contains("lesson-scrub");
    if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); closePlayer(); return; }
    if (e.key === " " && !inPlayer) { e.preventDefault(); e.stopPropagation(); if (play.playing) pause(); else start(); return; }
    if ((e.key === "ArrowLeft" || e.key === "ArrowRight") && !onScrub) {
      e.preventDefault(); e.stopPropagation();
      seek(play.t + (e.key === "ArrowLeft" ? -5000 : 5000));
      return;
    }
    if (e.key === "Tab" || (inPlayer && (e.key === "Enter" || e.key === " " || onScrub))) return;
    e.preventDefault();
    e.stopPropagation();
  }, true);
  window.addEventListener("pagehide", () => { if (rec) stopRecording(); });

  window.Inkyscib = window.Inkyscib || {};
  window.Inkyscib.Lesson = {
    startRecording, stopRecording, openPlayer, closePlayer, openSheet,
    list: listLessons, remove: deleteLesson,
    recording: () => !!rec, playing: () => !!(play && play.playing), open: () => !!play,
    seek, pause, play: start, frameAt, DB_NAME
  };
})();
