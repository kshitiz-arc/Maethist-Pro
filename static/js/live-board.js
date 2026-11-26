// The live class board, the teacher's side (2.10.0).
//
// Tools > Live board starts a board: a six-letter code and a QR code that
// open /live/<code>, where the class follows this page as it is written. No
// accounts. Only this tab holds the key that writes to the board.
//
// While it is on, a few times a second, the strokes that changed (by a cheap
// signature per stroke), the stroke being written, the part of the page in
// view and the page colour are sent to this site's server (live_board.py),
// which keeps them in memory and drops them when the board ends. Imported
// PDF pages and slides are not sent; ink, lines, shapes, constructions,
// tiles and pictures are.
(() => {
  "use strict";

  const TICK_MS = 220;
  const SESSION_KEY = "inkyscib_live";

  const s = () => window.appState;
  const icon = (name) => window.Inkyscib?.Icon?.svg?.(name) || "";

  let board = null; // { code, key }
  let timer = 0;
  let inFlight = false;
  let failures = 0;
  const ids = new WeakMap();
  let sent = new Map(); // id -> signature last sent
  let sentOrder = "";
  let sentLive = "";
  let sentView = "";
  let sentLook = "";

  // ---------- what a stroke is, for sending ----------

  function newId() {
    const a = "abcdefghijkmnpqrstuvwxyz23456789";
    let out = "";
    for (let i = 0; i < 10; i += 1) out += a[Math.floor(Math.random() * a.length)];
    return out;
  }

  function idOf(path) {
    let id = ids.get(path);
    if (!id) { id = newId(); ids.set(path, id); }
    return id;
  }

  // Caches and timings stay home: keys starting with "_", point times.
  const strip = (key, value) => (key.startsWith("_") || key === "time" || key === "lt" ? undefined : value);
  const wire = (path) => JSON.parse(JSON.stringify(path, strip));

  // Changes in place (a move, an erase cut, a new label) show in the ends,
  // the middle and the counts; a small path is simply compared whole.
  function signature(path) {
    const pts = Array.isArray(path.points) ? path.points : [];
    if (pts.length < 40 && !path.src) return JSON.stringify(path, strip);
    const at = (p) => (p ? `${p.x},${p.y}` : "");
    return [path.tool, path.color, path.size, path.opacity, pts.length, at(pts[0]), at(pts[pts.length >> 1]), at(pts[pts.length - 1]),
      path.erasers?.length || 0, path.componentPoints?.length || 0, path.src ? path.src.length : 0,
      path.rotation, path.width, path.height, path.x, path.y].join("|");
  }

  const shared = (path) => path && !path.firstRunDemo && Array.isArray(path.points);

  function view() {
    const st = s();
    const c = document.getElementById("drawingCanvas");
    const t = st?.transform || { scale: 1, offsetX: 0, offsetY: 0 };
    const w = c?.clientWidth || window.innerWidth;
    const h = c?.clientHeight || window.innerHeight;
    const k = t.scale || 1;
    return { x: -(t.offsetX || 0) / k, y: -(t.offsetY || 0) / k, w: w / k, h: h / k };
  }

  function look() {
    const theme = window.Inkyscib?.CanvasTheme?.get?.();
    return {
      bg: theme?.ground || getComputedStyle(document.body).backgroundColor,
      theme: document.documentElement.dataset.theme === "light" ? "light" : "dark"
    };
  }

  // ---------- the sync loop ----------

  async function tick() {
    if (!board || inFlight) return;
    const st = s();
    if (!st || st.lessonPlayback) return;
    const paths = (st.paths || []).filter(shared);
    const order = paths.map(idOf);
    const body = {};
    const set = {};
    const next = new Map();
    for (let i = 0; i < paths.length; i += 1) {
      const sig = signature(paths[i]);
      next.set(order[i], sig);
      if (sent.get(order[i]) !== sig) set[order[i]] = wire(paths[i]);
    }
    if (Object.keys(set).length) body.set = set;
    const orderKey = order.join(",");
    if (orderKey !== sentOrder) body.order = order;
    const current = st.isDrawing && shared(st.currentPath) ? st.currentPath : null;
    const liveKey = current ? signature(current) : "";
    if (liveKey !== sentLive) body.live = current ? wire(current) : null;
    const v = view();
    const viewKey = [v.x, v.y, v.w, v.h].map((n) => Math.round(n)).join(",");
    if (viewKey !== sentView) body.view = v;
    const l = look();
    const lookKey = l.bg + l.theme;
    if (lookKey !== sentLook) Object.assign(body, l);
    if (!Object.keys(body).length) return;

    inFlight = true;
    try {
      const response = await fetch(`/api/live/${board.code}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Live-Key": board.key },
        body: JSON.stringify(body)
      });
      if (response.status === 404 || response.status === 403 || response.status === 410) {
        stop({ quiet: true });
        window.Inkyscib?.notify?.("The live board has closed.");
        return;
      }
      if (!response.ok) throw new Error(String(response.status));
      sent = next;
      sentOrder = orderKey;
      sentLive = liveKey;
      sentView = viewKey;
      sentLook = lookKey;
      failures = 0;
      setPill("live");
    } catch (_) {
      failures += 1;
      if (failures >= 3) setPill("offline");
    } finally {
      inFlight = false;
    }
  }

  function begin(b) {
    board = b;
    sent = new Map();
    sentOrder = sentLive = sentView = sentLook = "";
    window.clearInterval(timer);
    timer = window.setInterval(tick, TICK_MS);
    try { sessionStorage.setItem(SESSION_KEY, JSON.stringify(b)); } catch (_) { /* private mode */ }
    showPill();
    tick();
  }

  async function start() {
    if (board) return board;
    const response = await fetch("/api/live", { method: "POST" });
    if (!response.ok) {
      let message = "The live board could not start. Check your connection and try again.";
      try { message = (await response.json()).error || message; } catch (_) { /* keep */ }
      throw new Error(message);
    }
    const b = await response.json();
    begin(b);
    return b;
  }

  async function stop({ quiet = false } = {}) {
    const b = board;
    board = null;
    window.clearInterval(timer);
    try { sessionStorage.removeItem(SESSION_KEY); } catch (_) { /* private mode */ }
    hidePill();
    if (b && !quiet) {
      try {
        await fetch(`/api/live/${b.code}`, { method: "DELETE", headers: { "X-Live-Key": b.key } });
      } catch (_) { /* it expires on its own */ }
    }
  }

  const joinUrl = (b) => `${window.location.origin}/live/${b.code}`;

  // ---------- the Live pill ----------

  function showPill() {
    let pill = document.getElementById("livePill");
    if (!pill) {
      pill = document.createElement("div");
      pill.id = "livePill";
      pill.className = "live-pill";
      pill.setAttribute("role", "status");
      pill.innerHTML = `<span class="live-dot" aria-hidden="true"></span>
        <span class="live-label">Live</span><span class="live-code"></span>
        <button type="button" class="live-show">Show code</button>
        <button type="button" class="live-end">End</button>`;
      pill.querySelector(".live-show").addEventListener("click", () => openSheet());
      pill.querySelector(".live-end").addEventListener("click", () => stop());
      document.body.appendChild(pill);
    }
    pill.querySelector(".live-code").textContent = board.code;
    pill.hidden = false;
    setPill("live");
  }

  function setPill(state) {
    const pill = document.getElementById("livePill");
    if (!pill) return;
    pill.dataset.state = state;
    pill.querySelector(".live-label").textContent = state === "offline" ? "Reconnecting" : "Live";
  }

  function hidePill() {
    const pill = document.getElementById("livePill");
    if (pill) pill.hidden = true;
    closeSheet();
  }

  // ---------- the sheet ----------

  function closeSheet() {
    document.getElementById("liveSheet")?.remove();
  }

  function openSheet() {
    closeSheet();
    const sheet = document.createElement("div");
    sheet.id = "liveSheet";
    sheet.className = "lesson-sheet live-sheet";
    sheet.setAttribute("role", "dialog");
    sheet.setAttribute("aria-modal", "true");
    sheet.setAttribute("aria-label", "Live board");
    sheet.innerHTML = `<div class="lesson-card live-card">
        <div class="lesson-head"><h2>Live board</h2>
          <button type="button" class="lesson-sheet-close" aria-label="Close">${icon("lucide:x")}</button></div>
        <div class="live-body"></div>
      </div>`;
    sheet.addEventListener("click", (e) => { if (e.target === sheet) closeSheet(); });
    sheet.addEventListener("keydown", (e) => { if (e.key === "Escape") closeSheet(); });
    sheet.querySelector(".lesson-sheet-close").addEventListener("click", closeSheet);
    document.body.appendChild(sheet);
    render(sheet.querySelector(".live-body"));
  }

  function render(body) {
    if (!board) {
      body.innerHTML = `<p class="lesson-intro">Your class follows this page live, on their phones or laptops: they scan a code or type six letters. Nobody needs an account.</p>
        <ul class="live-facts">
          <li>While the board is on, your ink goes through this site's server to the class. It is kept in memory only, and deleted when you end the board.</li>
          <li>Ink, lines, shapes, constructions, tiles and pictures are shared. Imported PDF pages and slides are not, yet.</li>
        </ul>
        <button type="button" class="live-start">${icon("lucide:presentation")}<span>Start live board</span></button>
        <p class="live-error" role="alert" hidden></p>`;
      const go = body.querySelector(".live-start");
      go.addEventListener("click", async () => {
        go.disabled = true;
        try {
          await start();
          render(body);
        } catch (error) {
          const p = body.querySelector(".live-error");
          p.textContent = error.message;
          p.hidden = false;
          go.disabled = false;
        }
      });
      go.focus();
      return;
    }
    const url = joinUrl(board);
    body.innerHTML = `<div class="live-join">
        <img class="live-qr" src="/api/live/${board.code}/qr.svg" alt="QR code that opens ${url}" width="220" height="220">
        <div class="live-join-text">
          <p class="live-step">Scan with a camera, or open</p>
          <p class="live-url"><span>${window.location.host}/live/</span></p>
          <p class="live-big-code" aria-label="Code ${board.code.split("").join(" ")}">${board.code}</p>
          <button type="button" class="live-copy">${icon("lucide:copy")}<span>Copy link</span></button>
        </div>
      </div>
      <p class="lesson-intro">The class sees what you see: the board follows your scrolling and zoom. Close this and teach.</p>
      <div class="live-actions">
        <button type="button" class="live-done">Back to the page</button>
        <button type="button" class="live-stop">End live board</button>
      </div>`;
    body.querySelector(".live-copy").addEventListener("click", async (e) => {
      const button = e.currentTarget;
      try {
        await navigator.clipboard.writeText(url);
        button.querySelector("span").textContent = "Copied";
      } catch (_) {
        button.querySelector("span").textContent = url;
      }
    });
    body.querySelector(".live-done").addEventListener("click", closeSheet);
    body.querySelector(".live-stop").addEventListener("click", () => stop());
    body.querySelector(".live-done").focus();
  }

  // A reload in the same tab carries on with the same board.
  function resume() {
    let saved = null;
    try { saved = JSON.parse(sessionStorage.getItem(SESSION_KEY) || "null"); } catch (_) { /* none */ }
    if (saved && /^[A-Z2-9]{6}$/.test(saved.code || "") && typeof saved.key === "string") begin(saved);
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", () => window.setTimeout(resume, 600), { once: true });
  else window.setTimeout(resume, 600);

  window.Inkyscib = window.Inkyscib || {};
  window.Inkyscib.LiveBoard = { openSheet, start, stop, tick, current: () => board, TICK_MS };
})();
