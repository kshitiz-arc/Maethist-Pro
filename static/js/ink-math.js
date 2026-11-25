// Maths that answers back (2.9.0).
//
// Write a line of maths with the pen and pause: if it reads cleanly, a chip
// at the end of the line answers it.
//
//   12 + 7 =        ->  = 19
//   5 + 3 = 9       ->  not quite: 5 + 3 = 8
//   6 x 4 = 24      ->  correct
//   2x + 3 = 11     ->  x = 4
//   x(x - 5) = -6   ->  x = 2 or x = 3
//
// All of it runs here, offline, in a few milliseconds: no model, no server.
// The line is split into symbols, the clear-cut ones (- = + x / and the
// division sign) are read by their geometry, digits and brackets by the $P
// matcher in ink-recognize.js, and the result is parsed and solved.
//
// It stays quiet unless it is sure. Every symbol on the line must be read,
// the line must parse as maths, and there must be something to say (an "="
// to answer or check). A line of words never parses, so it never shows.
(() => {
  "use strict";

  const PAUSE_MS = 900;
  const BURST_GAP_MS = 8000;
  const CHIP_MS = 12000;

  const s = () => window.appState;
  const enabled = () => s()?.toolSettings?.pen?.mathAnswers !== false;

  // ---------- strokes ----------

  function info(points) {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const p of points) {
      if (p.x < minX) minX = p.x;
      if (p.x > maxX) maxX = p.x;
      if (p.y < minY) minY = p.y;
      if (p.y > maxY) maxY = p.y;
    }
    const first = points[0];
    const last = points[points.length - 1];
    // How far the stroke strays from the chord between its ends.
    const chord = Math.hypot(last.x - first.x, last.y - first.y) || 1;
    let bend = 0;
    let bendSign = 0;
    let bendAt = 0;
    points.forEach((p, index) => {
      const d = ((last.x - first.x) * (first.y - p.y) - (first.x - p.x) * (last.y - first.y)) / chord;
      if (Math.abs(d) > Math.abs(bend)) { bend = d; bendSign = Math.sign(d); bendAt = index / Math.max(1, points.length - 1); }
    });
    return {
      points, minX, minY, maxX, maxY,
      w: maxX - minX, h: maxY - minY,
      cx: (minX + maxX) / 2, cy: (minY + maxY) / 2,
      first, last, chord,
      straight: Math.abs(bend) / chord < 0.12,
      bend: bend / chord, bendSign, bendAt
    };
  }

  const median = (values) => {
    if (!values.length) return 0;
    const v = [...values].sort((a, b) => a - b);
    return v[Math.floor(v.length / 2)];
  };

  // The strokes on the same line as the last one: grow a band outward from it
  // by vertical overlap, so a line of writing is taken and the line above or
  // below is not.
  function sameLine(strokes) {
    if (!strokes.length) return [];
    const tall = strokes.filter((k) => k.h > k.w * 0.6);
    const H = median((tall.length ? tall : strokes).map((k) => Math.max(k.h, k.w)));
    const lastStroke = strokes[strokes.length - 1];
    let top = lastStroke.cy - H * 0.7;
    let bottom = lastStroke.cy + H * 0.7;
    const inLine = new Set([lastStroke]);
    let grew = true;
    while (grew) {
      grew = false;
      for (const k of strokes) {
        if (inLine.has(k)) continue;
        if (k.cy >= top && k.cy <= bottom) {
          inLine.add(k);
          top = Math.min(top, k.cy - H * 0.5);
          bottom = Math.max(bottom, k.cy + H * 0.5);
          grew = true;
        }
      }
    }
    return strokes.filter((k) => inLine.has(k));
  }

  // Strokes that overlap left-to-right belong to one symbol: the two bars of
  // an =, the arms of a + or an x, the dots of a division sign.
  function groupSymbols(strokes) {
    const sorted = [...strokes].sort((a, b) => a.minX - b.minX);
    const groups = [];
    for (const k of sorted) {
      const g = groups[groups.length - 1];
      if (g) {
        const overlap = Math.min(g.maxX, k.maxX) - Math.max(g.minX, k.minX);
        const narrow = Math.max(1, Math.min(g.maxX - g.minX, k.w));
        // Or the thinner one sits inside the other's span: the upright of a +
        // has almost no width of its own, so it overlaps nothing.
        const gCx = (g.minX + g.maxX) / 2;
        const inside = (k.w < (g.maxX - g.minX) && k.cx > g.minX && k.cx < g.maxX) ||
          ((g.maxX - g.minX) < k.w && gCx > k.minX && gCx < k.maxX);
        if (overlap > narrow * 0.35 || inside) {
          g.strokes.push(k);
          g.minX = Math.min(g.minX, k.minX);
          g.maxX = Math.max(g.maxX, k.maxX);
          g.minY = Math.min(g.minY, k.minY);
          g.maxY = Math.max(g.maxY, k.maxY);
          continue;
        }
      }
      groups.push({ strokes: [k], minX: k.minX, maxX: k.maxX, minY: k.minY, maxY: k.maxY });
    }
    return groups;
  }

  // ---------- one symbol ----------

  const slope = (k) => (k.last.y - k.first.y) / ((k.last.x - k.first.x) || 1e-6);

  function classify(group, H) {
    const ks = group.strokes;
    const flat = (k) => k.straight && k.h < Math.max(3, k.w * 0.32) && k.w > H * 0.22;
    const dot = (k) => Math.max(k.w, k.h) < H * 0.24;
    const diagonal = (k, rising) => k.straight && k.w > k.h * 0.35 && k.h > k.w * 0.35 &&
      ((slope(k) < 0) === rising);
    const upright = (k) => k.straight && k.h > k.w * 2.2;

    if (ks.length === 1) {
      const k = ks[0];
      if (flat(k)) return "-";
      if (dot(k)) return null;
      if (diagonal(k, true) && k.h > H * 0.5 && k.w < k.h * 1.2 && k.w > k.h * 0.4) return "/";
    }
    if (ks.length === 2) {
      const [a, b] = ks;
      if (flat(a) && flat(b) && Math.abs(a.cy - b.cy) > Math.max(a.h, b.h) + 2) return "=";
      if ((upright(a) && flat(b)) || (upright(b) && flat(a))) return "+";
      if ((diagonal(a, true) && diagonal(b, false)) || (diagonal(a, false) && diagonal(b, true))) return "x";
    }
    if (ks.length === 3) {
      const bar = ks.find(flat);
      const dots = ks.filter((k) => k !== bar && dot(k));
      if (bar && dots.length === 2 && dots.some((d) => d.cy < bar.cy) && dots.some((d) => d.cy > bar.cy)) return "÷";
    }
    if (ks.length === 1 && isBracket(ks[0], H)) return bracketSide(ks[0]);
    return readDigit(ks);
  }

  // Handwritten digits run narrower than the reader's templates, so each is
  // also tried stretched sideways, and the most confident reading wins. A 1
  // reads best as drawn, so it is never stretched into something else.
  function readDigit(ks) {
    const R = window.Inkyscib?.InkRecognize;
    if (!R?.recognizeDigit) return null;
    const minX = Math.min(...ks.map((k) => k.minX));
    const maxX = Math.max(...ks.map((k) => k.maxX));
    const cx = (minX + maxX) / 2;
    let best = null;
    for (const stretch of [1, 1.3, 1.6]) {
      const runs = ks.map((k) => k.points.map((p) => ({ x: cx + (p.x - cx) * stretch, y: p.y })));
      const r = R.recognizeDigit(runs);
      if (r && (!best || r.score > best.score)) best = r;
      if (stretch === 1 && r && r.digit === "1") return "1";
    }
    return best && best.digit !== "1" ? best.digit : null;
  }

  // A bracket is one smooth bow: tall, narrow, curved, and turning back
  // sideways only once. A 3 or a 5 turns back several times.
  function isBracket(k, H) {
    if (k.h < H * 0.6 || k.w > k.h * 0.55 || Math.abs(k.bend) < 0.07) return false;
    // A bracket bows most in its middle; a 1's only bend is its flag, at an end.
    if (k.bendAt < 0.3 || k.bendAt > 0.7) return false;
    // And it is curved all along: a quarter of the way in from each end it is
    // still well off the chord. A smoothed 1 is straight but for its flag.
    const pts0 = k.points;
    const off = (p) => Math.abs((k.last.x - k.first.x) * (k.first.y - p.y) - (k.first.x - p.x) * (k.last.y - k.first.y)) / k.chord;
    const q1 = off(pts0[Math.floor(pts0.length * 0.25)]);
    const q3 = off(pts0[Math.floor(pts0.length * 0.75)]);
    const peak = Math.abs(k.bend) * k.chord;
    if (Math.min(q1, q3) < peak * 0.45) return false;
    let turns = 0;
    let dir = 0;
    const pts = k.points;
    // Coarse steps, and sideways moves under an eighth of the width ignored:
    // a narrow bracket's tremble is not a turn.
    const step = Math.max(1, Math.floor(pts.length / 8));
    for (let i = step; i < pts.length; i += step) {
      const dx = pts[i].x - pts[i - step].x;
      if (Math.abs(dx) < Math.max(1, k.w * 0.12)) continue;
      const d = Math.sign(dx);
      if (dir && d !== dir) turns += 1;
      dir = d;
    }
    return turns <= 1;
  }

  // Which way the bow faces: its middle sits left of its ends for "(".
  function bracketSide(k) {
    const mid = k.points[Math.floor(k.points.length / 2)];
    return mid.x < (k.first.x + k.last.x) / 2 ? "(" : ")";
  }

  /** The text of a line of strokes (point arrays), or null if any symbol is unclear. */
  function readLine(pointRuns) {
    const strokes = pointRuns.filter((p) => p && p.length >= 2).map(info);
    if (strokes.length < 2) return null;
    const line = sameLine(strokes);
    const groups = groupSymbols(line);
    const tall = groups.filter((g) => (g.maxY - g.minY) > (g.maxX - g.minX) * 0.8);
    const H = median((tall.length ? tall : groups).map((g) => g.maxY - g.minY)) || 20;
    const symbols = [];
    for (const g of groups) {
      const sym = classify(g, H);
      if (!sym) return null;
      symbols.push(sym);
    }
    const box = {
      minX: Math.min(...line.map((k) => k.minX)), maxX: Math.max(...line.map((k) => k.maxX)),
      minY: Math.min(...line.map((k) => k.minY)), maxY: Math.max(...line.map((k) => k.maxY))
    };
    return { text: symbols.join(""), box };
  }

  // ---------- maths ----------

  // A small recursive-descent parser over + - * / ( ), numbers and x, with
  // implicit multiplication (2x, 3(x+1), (x-1)(x+2)). Returns f(x).
  function compile(src) {
    const t = src.replace(/÷/g, "/").replace(/×/g, "*");
    let i = 0;
    const peek = () => t[i];
    const expr = () => {
      let f = term();
      while (peek() === "+" || peek() === "-") {
        const op = t[i++];
        const g = term();
        if (!g) return null;
        const a = f;
        f = op === "+" ? (x) => a(x) + g(x) : (x) => a(x) - g(x);
      }
      return f;
    };
    const startsFactor = (c) => c !== undefined && /[0-9x(]/.test(c);
    const term = () => {
      let f = unary();
      if (!f) return null;
      for (;;) {
        const c = peek();
        if (c === "*" || c === "/") {
          i += 1;
          const g = unary();
          if (!g) return null;
          const a = f;
          f = c === "*" ? (x) => a(x) * g(x) : (x) => a(x) / g(x);
        } else if (startsFactor(c)) {
          const g = unary();
          if (!g) return null;
          const a = f;
          f = (x) => a(x) * g(x);
        } else return f;
      }
    };
    const unary = () => {
      if (peek() === "-") { i += 1; const g = unary(); return g && ((x) => -g(x)); }
      return factor();
    };
    const factor = () => {
      const c = peek();
      if (c === "(") {
        i += 1;
        const f = expr();
        if (!f || peek() !== ")") return null;
        i += 1;
        return f;
      }
      if (c === "x") { i += 1; return (x) => x; }
      const m = /^[0-9]+/.exec(t.slice(i));
      if (m) { i += m[0].length; const v = Number(m[0]); return () => v; }
      return null;
    };
    const f = expr();
    return f && i === t.length ? f : null;
  }

  const near = (a, b) => Math.abs(a - b) < 1e-9 * Math.max(1, Math.abs(a), Math.abs(b));

  function show(n) {
    if (!Number.isFinite(n)) return null;
    if (near(n, Math.round(n))) return String(Math.round(n));
    for (let d = 2; d <= 12; d += 1) {
      const top = n * d;
      if (near(top, Math.round(top))) return `${Math.round(top)}/${d}`;
    }
    return String(+n.toFixed(4));
  }

  const pretty = (text) => text.replace(/\*/g, " × ").replace(/\//g, " ÷ ").replace(/([+\-=])/g, " $1 ")
    .replace(/\s+/g, " ").replace(/^ - /, "-").trim();

  /** What to say about a line of maths, or null when there is nothing to say. */
  function answer(text) {
    if (!text || !text.includes("=")) return null;
    const parts = text.split("=");
    if (parts.length !== 2) return null;
    let [left, right] = parts;
    if (!left) return null;

    // "3x4=" asks for an answer, so an x between digits is a times sign.
    const asTimes = (side) => side.replace(/(?<=[0-9)])x(?=[0-9(])/g, "*");

    if (!right) {
      const f = compile(asTimes(left));
      if (!f || /x/.test(asTimes(left))) return null;
      const v = f(0);
      const shown = show(v);
      if (shown === null) return null;
      const say = shown.includes("/") ? `= ${shown} = ${+v.toFixed(4)}` : `= ${shown}`;
      return { kind: "value", value: shown, say };
    }

    const numeric = !/x/.test(asTimes(left)) && !/x/.test(asTimes(right));
    if (numeric) {
      left = asTimes(left);
      right = asTimes(right);
      const f = compile(left);
      const g = compile(right);
      if (!f || !g) return null;
      const a = f(0);
      const b = g(0);
      if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
      if (near(a, b)) return { kind: "right", say: "Correct" };
      return { kind: "wrong", say: `Not quite: ${pretty(left)} = ${show(a)}` };
    }

    // An equation in x. "x = 4" on its own says nothing new.
    if (/^x$/.test(left) && !/x/.test(right)) return null;
    const f = compile(left);
    const g = compile(right);
    if (!f || !g) return null;
    const h = (x) => f(x) - g(x);
    const v = [0, 1, 2, 3, 4].map(h);
    if (v.some((y) => !Number.isFinite(y))) return null;
    const d1 = v.slice(1).map((y, k) => y - v[k]);
    const d2 = d1.slice(1).map((y, k) => y - d1[k]);
    const d3 = d2.slice(1).map((y, k) => y - d2[k]);
    const flat = (arr) => arr.every((y) => Math.abs(y) < 1e-9);
    if (flat(d2)) {
      const m = d1[0];
      if (Math.abs(m) < 1e-12) return near(v[0], 0) ? { kind: "solve", say: "True for every x" } : { kind: "solve", say: "No x makes this true" };
      const x0 = -v[0] / m;
      const root = show(x0);
      if (root === null) return null;
      return { kind: "solve", say: root.includes("/") ? `x = ${root} ≈ ${+x0.toFixed(3)}` : `x = ${root}` };
    }
    if (flat(d3)) {
      const a = d2[0] / 2;
      const b = d1[0] - a;
      const c = v[0];
      const disc = b * b - 4 * a * c;
      if (disc < -1e-9) return { kind: "solve", say: "No real x" };
      const r = Math.sqrt(Math.max(0, disc));
      const x1 = (-b - r) / (2 * a);
      const x2 = (-b + r) / (2 * a);
      if (near(x1, x2)) return { kind: "solve", say: `x = ${show(x1)}` };
      const [lo, hi] = [x1, x2].sort((p, q) => p - q);
      if (near(lo, Math.round(lo)) && near(hi, Math.round(hi)) || (show(lo) || "").length < 6) {
        return { kind: "solve", say: `x = ${show(lo)} or x = ${show(hi)}` };
      }
      return { kind: "solve", say: `x ≈ ${lo.toFixed(3)} or x ≈ ${hi.toFixed(3)}` };
    }
    return null;
  }

  // ---------- watching the pen ----------

  let recent = [];
  let pauseTimer = 0;
  let chip = null;
  let chipTimer = 0;
  let lastSaid = "";

  function track() {
    const st = s();
    if (!st || st.currentTool !== "pen") return;
    const path = st.paths?.[st.paths.length - 1];
    if (!path || path.tool !== "pen" || !Array.isArray(path.points) || path.points.length < 2) return;
    const now = Date.now();
    if (recent.length && now - recent[recent.length - 1].at > BURST_GAP_MS) recent = [];
    if (!recent.some((r) => r.path === path)) recent.push({ path, at: now });
    recent = recent.slice(-40);
  }

  function consider() {
    if (!enabled()) return;
    const st = s();
    // Strokes still on the page (an undo or an erase takes them out).
    const live = new Set(st?.paths || []);
    recent = recent.filter((r) => live.has(r.path));
    if (recent.length < 2) return;
    const read = readLine(recent.map((r) => r.path.points));
    if (!read) return;
    const said = answer(read.text);
    if (!said) return;
    const key = read.text + "|" + said.say;
    if (key === lastSaid && chip && !chip.hidden) return;
    lastSaid = key;
    showChip(said, read);
  }

  function toScreen(p) {
    const t = s()?.transform || { scale: 1, offsetX: 0, offsetY: 0 };
    const canvas = document.getElementById("drawingCanvas");
    const r = canvas ? canvas.getBoundingClientRect() : { left: 0, top: 0 };
    return { x: r.left + p.x * (t.scale || 1) + (t.offsetX || 0), y: r.top + p.y * (t.scale || 1) + (t.offsetY || 0) };
  }

  function buildChip() {
    chip = document.createElement("div");
    chip.className = "im-chip";
    chip.id = "inkMathChip";
    chip.hidden = true;
    chip.setAttribute("role", "status");
    chip.setAttribute("aria-live", "polite");
    chip.innerHTML = `<span class="im-mark" aria-hidden="true"></span><span class="im-say"></span>
      <button type="button" class="im-close" aria-label="Dismiss">&times;</button>`;
    chip.querySelector(".im-close").addEventListener("click", hideChip);
    document.body.appendChild(chip);
  }

  function showChip(said, read) {
    if (!chip) buildChip();
    chip.dataset.kind = said.kind;
    chip.dataset.read = read.text;
    chip.querySelector(".im-mark").textContent = said.kind === "right" ? "✓" : said.kind === "wrong" ? "✗" : "";
    chip.querySelector(".im-say").textContent = said.say;
    const end = toScreen({ x: read.box.maxX, y: (read.box.minY + read.box.maxY) / 2 });
    chip.hidden = false;
    const w = chip.offsetWidth || 160;
    const x = Math.min(window.innerWidth - w - 12, end.x + 24);
    const y = Math.max(70, Math.min(window.innerHeight - 60, end.y - chip.offsetHeight / 2));
    chip.style.left = x + "px";
    chip.style.top = y + "px";
    chip.classList.remove("is-in");
    void chip.offsetWidth;
    chip.classList.add("is-in");
    window.clearTimeout(chipTimer);
    chipTimer = window.setTimeout(hideChip, CHIP_MS);
  }

  function hideChip() {
    window.clearTimeout(chipTimer);
    if (chip) chip.hidden = true;
  }

  document.addEventListener("pointerdown", (event) => {
    if (event.target?.id === "drawingCanvas") window.clearTimeout(pauseTimer);
  }, true);
  document.addEventListener("pointerup", (event) => {
    if (event.target?.id !== "drawingCanvas") return;
    // After the canvas has committed (and write assist tidied) the stroke.
    window.setTimeout(() => {
      track();
      window.clearTimeout(pauseTimer);
      pauseTimer = window.setTimeout(consider, PAUSE_MS);
    }, 30);
  });
  document.addEventListener("toolChanged", () => { recent = []; });

  // ---------- the pen panel switch ----------

  function syncButtons() {
    const on = enabled();
    document.querySelectorAll("[data-math-answers]").forEach((b) => {
      const active = (b.dataset.mathAnswers === "on") === on;
      b.classList.toggle("active", active);
      b.setAttribute("aria-pressed", active ? "true" : "false");
    });
  }

  function start() {
    document.querySelectorAll("[data-math-answers]").forEach((b) => b.addEventListener("click", () => {
      const pen = s()?.toolSettings?.pen;
      if (!pen) return;
      pen.mathAnswers = b.dataset.mathAnswers === "on";
      if (!pen.mathAnswers) hideChip();
      syncButtons();
      if (typeof window.savePreferences === "function") window.savePreferences();
    }));
    syncButtons();
    window.setTimeout(syncButtons, 500);
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start, { once: true });
  else start();

  window.Inkyscib = window.Inkyscib || {};
  window.Inkyscib.InkMath = { readLine, answer, compile, consider, PAUSE_MS };
})();
