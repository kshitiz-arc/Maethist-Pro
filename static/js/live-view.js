// The live class board, the class's side (2.10.0): /live/<code>.
//
// Follows a teacher's page as it is written. Asks the server what changed
// since the version it last saw (a few times a second while the tab is
// shown, every few seconds while it is hidden), keeps the strokes by id, and
// draws them with the editor's own drawing code, fitted to the part of the
// page the teacher is looking at. Read only: nothing is sent back.
(() => {
  "use strict";

  const code = document.body.dataset.code || "";

  // ---------- joining by code ----------
  const join = document.getElementById("liveJoin");
  if (join) {
    const input = document.getElementById("liveCodeInput");
    input.addEventListener("input", () => {
      input.value = input.value.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 6);
    });
    join.addEventListener("submit", (e) => {
      e.preventDefault();
      const value = input.value.trim().toUpperCase();
      if (/^[A-Z2-9]{6}$/.test(value)) window.location.assign("/live/" + value);
    });
    input.focus();
    return;
  }
  if (!code) return;

  const canvas = document.getElementById("liveCanvas");
  const ctx = canvas.getContext("2d");
  const status = document.getElementById("liveStatus");
  const empty = document.getElementById("liveEmpty");
  const save = document.getElementById("liveSave");

  // The drawing code reads a few settings from the editor's state; a quiet
  // stand-in keeps it happy without the editor.
  window.appState = window.appState || {
    paths: [], transform: { scale: 1, offsetX: 0, offsetY: 0 },
    toolSettings: new Proxy({}, { get: () => ({ size: 2 }) })
  };

  const board = { v: 0, order: [], paths: new Map(), live: null, view: null, bg: null, theme: null, ended: false };
  let dirty = true;
  let ready = false;

  function say(state, text) {
    status.dataset.state = state;
    status.querySelector(".lv-say").textContent = text;
  }

  // ---------- framing ----------
  // The camera frames the ink in the teacher's view (at least about a third of
  // that view, so a first word is not blown up to fill a phone), and eases
  // toward it as the writing grows. A student can pinch, drag or scroll to
  // look closer; "Follow teacher" hands the camera back.
  const TOP = 64;
  let cam = null;      // the world rect on screen now
  let manual = null;   // { s, ox, oy } while the student has taken over

  function inkBounds(clip) {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    const add = (path) => {
      for (const p of path?.points || []) {
        if (clip && (p.x < clip.x || p.x > clip.x + clip.w || p.y < clip.y || p.y > clip.y + clip.h)) continue;
        if (p.x < minX) minX = p.x;
        if (p.x > maxX) maxX = p.x;
        if (p.y < minY) minY = p.y;
        if (p.y > maxY) maxY = p.y;
      }
    };
    board.paths.forEach(add);
    add(board.live);
    if (!Number.isFinite(minX)) return null;
    return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
  }

  function target() {
    const view = board.view;
    const ink = inkBounds(view);
    if (!ink) return view || { x: 0, y: 0, w: window.innerWidth, h: window.innerHeight };
    const pad = Math.max(24, Math.max(ink.w, ink.h) * 0.08);
    let r = { x: ink.x - pad, y: ink.y - pad, w: ink.w + pad * 2, h: ink.h + pad * 2 };
    if (view) {
      const minW = view.w * 0.3;
      const minH = view.h * 0.3;
      if (r.w < minW) { r.x -= (minW - r.w) / 2; r.w = minW; }
      if (r.h < minH) { r.y -= (minH - r.h) / 2; r.h = minH; }
    }
    return r;
  }

  function fit() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2.5);
    const w = window.innerWidth;
    const h = window.innerHeight;
    if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
      canvas.style.width = w + "px";
      canvas.style.height = h + "px";
    }
    if (manual) return { dpr, ...manual, w, h };
    const goal = target();
    if (!cam) cam = { ...goal };
    let moving = false;
    for (const k of ["x", "y", "w", "h"]) {
      const d = goal[k] - cam[k];
      if (Math.abs(d) > Math.max(0.5, Math.abs(goal.w) * 0.001)) { cam[k] += d * (reduced ? 1 : 0.22); moving = true; }
      else cam[k] = goal[k];
    }
    if (moving) dirty = true;
    const s = Math.min(w / cam.w, (h - TOP) / cam.h) * 0.98;
    const ox = (w - cam.w * s) / 2 - cam.x * s;
    const oy = TOP + (h - TOP - cam.h * s) / 2 - cam.y * s;
    return { dpr, s, ox, oy, w, h };
  }
  const reduced = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;

  // Pinch, drag and wheel.
  const follow = document.getElementById("liveFollow");
  function takeOver() {
    if (!manual) {
      const t = fit();
      manual = { s: t.s, ox: t.ox, oy: t.oy };
      follow.hidden = false;
    }
  }
  function zoomAt(x, y, k) {
    takeOver();
    const s2 = Math.min(40, Math.max(0.02, manual.s * k));
    const f = s2 / manual.s;
    manual = { s: s2, ox: x - (x - manual.ox) * f, oy: y - (y - manual.oy) * f };
    dirty = true;
  }
  follow.addEventListener("click", () => {
    manual = null;
    follow.hidden = true;
    dirty = true;
  });
  const pointers = new Map();
  let pinch = null;
  canvas.addEventListener("pointerdown", (e) => {
    canvas.setPointerCapture?.(e.pointerId);
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointers.size === 2) {
      const [a, b] = [...pointers.values()];
      pinch = { d: Math.hypot(a.x - b.x, a.y - b.y), cx: (a.x + b.x) / 2, cy: (a.y + b.y) / 2 };
    }
  });
  canvas.addEventListener("pointermove", (e) => {
    const prev = pointers.get(e.pointerId);
    if (!prev) return;
    const now = { x: e.clientX, y: e.clientY };
    pointers.set(e.pointerId, now);
    if (pointers.size === 1) {
      if (Math.hypot(now.x - prev.x, now.y - prev.y) < 0.5) return;
      takeOver();
      manual.ox += now.x - prev.x;
      manual.oy += now.y - prev.y;
      dirty = true;
    } else if (pointers.size === 2 && pinch) {
      const [a, b] = [...pointers.values()];
      const d = Math.hypot(a.x - b.x, a.y - b.y);
      const cx = (a.x + b.x) / 2;
      const cy = (a.y + b.y) / 2;
      zoomAt(cx, cy, d / (pinch.d || d));
      manual.ox += cx - pinch.cx;
      manual.oy += cy - pinch.cy;
      pinch = { d, cx, cy };
    }
  });
  const lift = (e) => { pointers.delete(e.pointerId); if (pointers.size < 2) pinch = null; };
  canvas.addEventListener("pointerup", lift);
  canvas.addEventListener("pointercancel", lift);
  canvas.addEventListener("wheel", (e) => {
    e.preventDefault();
    zoomAt(e.clientX, e.clientY, Math.exp(-e.deltaY * 0.0015));
  }, { passive: false });

  function draw(target, t, withBackground) {
    const c = target.getContext("2d");
    c.setTransform(1, 0, 0, 1, 0, 0);
    c.clearRect(0, 0, target.width, target.height);
    if (withBackground) {
      c.fillStyle = board.bg || getComputedStyle(document.body).backgroundColor;
      c.fillRect(0, 0, target.width, target.height);
    }
    if (!ready) return;
    c.setTransform(t.dpr * t.s, 0, 0, t.dpr * t.s, t.dpr * t.ox, t.dpr * t.oy);
    window.appState.transform = { scale: t.s, offsetX: t.ox, offsetY: t.oy };
    const drawPath = window.drawInkyscibPathForExport;
    for (const id of board.order) {
      const path = board.paths.get(id);
      if (!path) continue;
      try { drawPath(c, path); } catch (_) { /* one odd stroke never blanks the board */ }
      c.globalCompositeOperation = "source-over";
      c.globalAlpha = 1;
    }
    if (board.live) {
      try { drawPath(c, board.live); } catch (_) { /* as above */ }
    }
  }

  function frame() {
    if (dirty) {
      dirty = false;
      draw(canvas, fit(), false);
    }
    window.requestAnimationFrame(frame);
  }

  window.addEventListener("resize", () => { dirty = true; });

  // ---------- following ----------
  function apply(data) {
    if (Array.isArray(data.order)) board.order = data.order;
    for (const [id, path] of Object.entries(data.set || {})) board.paths.set(id, path);
    const keep = new Set(board.order);
    for (const id of [...board.paths.keys()]) if (!keep.has(id)) board.paths.delete(id);
    if ("live" in data) board.live = data.live;
    board.view = data.view || null;
    if (data.bg && /^(#[0-9a-fA-F]{3,8}|rgba?\([0-9., ]+\))$/.test(data.bg)) {
      board.bg = data.bg;
      document.body.style.backgroundColor = data.bg;
    }
    if (data.theme === "light" || data.theme === "dark") document.documentElement.dataset.theme = data.theme;
    board.v = data.v;
    board.ended = !!data.ended;
    empty.hidden = board.ended || board.order.length > 0 || !!board.live;
    save.disabled = board.order.length === 0;
    dirty = true;
  }

  let misses = 0;
  async function poll() {
    let wait = document.hidden ? 4000 : 350;
    try {
      const response = await fetch(`/api/live/${code}?since=${board.v}`, { cache: "no-store" });
      if (response.status === 404) {
        say("gone", board.v ? "This board has closed" : "No board has this code");
        empty.hidden = true;
        return; // stop
      }
      if (response.status === 200) apply(await response.json());
      misses = 0;
      if (board.ended) {
        say("ended", "Class ended");
        empty.hidden = true;
        return; // stop
      }
      say("live", "Live");
    } catch (_) {
      misses += 1;
      say("offline", "Reconnecting");
      wait = Math.min(8000, 700 * misses);
    }
    window.setTimeout(poll, wait);
  }
  document.addEventListener("visibilitychange", () => { if (!document.hidden) dirty = true; });

  // ---------- saving a picture ----------
  save.addEventListener("click", () => {
    const out = document.createElement("canvas");
    out.width = canvas.width;
    out.height = canvas.height;
    draw(out, fit(), true);
    out.toBlob((blob) => {
      if (!blob) return;
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = `maethist-live-${code}.png`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      window.setTimeout(() => URL.revokeObjectURL(a.href), 2000);
    }, "image/png");
  });

  // ---------- the editor's drawing code ----------
  async function loadRenderers() {
    let urls = [];
    try { urls = JSON.parse(document.getElementById("liveRenderers").textContent); } catch (_) { /* none */ }
    for (const src of urls) {
      await new Promise((resolve) => {
        const s = document.createElement("script");
        s.src = src;
        s.onload = resolve;
        s.onerror = resolve;
        document.body.appendChild(s);
      });
    }
    ready = typeof window.drawInkyscibPathForExport === "function";
    dirty = true;
  }

  window.Inkyscib = window.Inkyscib || {};
  window.Inkyscib.LiveView = { board, redraw: () => { dirty = true; }, camera: () => fit(), following: () => !manual };

  window.requestAnimationFrame(frame);
  loadRenderers().then(poll);
})();
