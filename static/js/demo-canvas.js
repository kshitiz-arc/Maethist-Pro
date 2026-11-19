// The homepage demo window, made real.
//
// It used to be a picture with a row of buttons that did nothing. Now the
// tools work: the arrow drags A, B or C and the construction follows (the
// circle stays the triangle's circumcircle, the altitude stays perpendicular
// to BC, the right-angle mark stays at its foot), and Pen, Line, Circle and
// Triangle draw on the paper. Nothing leaves the page and nothing is saved:
// it is a taste of the canvas, and the real one is one click away.
(() => {
  "use strict";

  const svg = document.getElementById("geometrySvg");
  if (!svg) return;
  const NS = "http://www.w3.org/2000/svg";
  const $ = (id) => document.getElementById(id);
  const ink = $("demoInk");
  const hint = $("demoHint");
  const clearBtn = $("demoClear");
  const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)");

  const START = { A: { x: 250, y: 65 }, B: { x: 120, y: 285 }, C: { x: 380, y: 285 } };
  let pts = { A: { ...START.A }, B: { ...START.B }, C: { ...START.C } };
  const BOUNDS = { minX: 14, maxX: 486, minY: 14, maxY: 406 };
  const HINTS = {
    select: "Drag A, B or C, or the whole triangle. The circle and the altitude follow.",
    pen: "Write anywhere on the paper.",
    line: "Drag to draw a line.",
    circle: "Drag from the centre outward.",
    triangle: "Drag to draw a triangle."
  };

  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
  const sub = (p, q) => ({ x: p.x - q.x, y: p.y - q.y });
  const add = (p, q) => ({ x: p.x + q.x, y: p.y + q.y });
  const mul = (p, k) => ({ x: p.x * k, y: p.y * k });
  const len = (p) => Math.hypot(p.x, p.y);
  const set = (el, attrs) => { if (el) Object.entries(attrs).forEach(([k, v]) => el.setAttribute(k, typeof v === "number" ? v.toFixed(2) : v)); };

  function currentTool() {
    return document.querySelector(".nb-window .tool.selected")?.dataset.tool || "select";
  }

  // ---------- the live construction ----------

  function circumcircle(a, b, c) {
    const d = 2 * (a.x * (b.y - c.y) + b.x * (c.y - a.y) + c.x * (a.y - b.y));
    if (Math.abs(d) < 1e-6) return null;
    const a2 = a.x * a.x + a.y * a.y;
    const b2 = b.x * b.x + b.y * b.y;
    const c2 = c.x * c.x + c.y * c.y;
    const x = (a2 * (b.y - c.y) + b2 * (c.y - a.y) + c2 * (a.y - b.y)) / d;
    const y = (a2 * (c.x - b.x) + b2 * (a.x - c.x) + c2 * (b.x - a.x)) / d;
    return { x, y, r: Math.hypot(a.x - x, a.y - y) };
  }

  function update() {
    const { A, B, C } = pts;
    set($("gAB"), { x1: A.x, y1: A.y, x2: B.x, y2: B.y });
    set($("gAC"), { x1: A.x, y1: A.y, x2: C.x, y2: C.y });
    set($("gBC"), { x1: B.x, y1: B.y, x2: C.x, y2: C.y });

    const circle = circumcircle(A, B, C);
    const ring = $("gCircle");
    if (circle && circle.r < 2000) {
      ring.style.display = "";
      set(ring, { cx: circle.x, cy: circle.y, r: circle.r });
    } else {
      ring.style.display = "none";
    }

    // The foot of the altitude from A onto BC.
    const bc = sub(C, B);
    const t = ((A.x - B.x) * bc.x + (A.y - B.y) * bc.y) / Math.max(1e-6, bc.x * bc.x + bc.y * bc.y);
    const F = add(B, mul(bc, t));
    set($("gAlt"), { x1: A.x, y1: A.y, x2: F.x, y2: F.y });
    // Past B or past C, the foot is on BC produced: draw that part, dashed,
    // so the altitude meets a line rather than stopping in mid-air.
    const ext = $("gExt");
    if (ext) {
      const outside = t < 0 || t > 1;
      ext.style.display = outside ? "" : "none";
      if (outside) {
        const from = t < 0 ? B : C;
        const u0 = mul(bc, 1 / Math.max(1e-6, len(bc)));
        const beyond = mul(u0, t < 0 ? -10 : 10);
        set(ext, { x1: from.x, y1: from.y, x2: F.x + beyond.x, y2: F.y + beyond.y });
      }
    }

    // The right-angle mark: a small square at F, along BC and up toward A.
    const u = mul(bc, 1 / Math.max(1e-6, len(bc)));
    const up = sub(A, F);
    const v = len(up) > 1e-6 ? mul(up, 1 / len(up)) : { x: -u.y, y: u.x };
    const s = Math.min(22, len(up) * 0.4);
    const toward = t < 0.5 ? 1 : -1;
    const p1 = add(F, mul(v, s));
    const p2 = add(p1, mul(u, s * toward));
    const p3 = add(F, mul(u, s * toward));
    const mark = $("gRight");
    mark.style.display = s > 3 ? "" : "none";
    set(mark, { d: `M${p1.x.toFixed(1)} ${p1.y.toFixed(1)} L${p2.x.toFixed(1)} ${p2.y.toFixed(1)} L${p3.x.toFixed(1)} ${p3.y.toFixed(1)}` });

    // The red arc from B to C, bowed toward A like the original drawing.
    const M = mul(add(B, C), 0.5);
    const Q = add(M, mul(sub(A, F), 0.82));
    set($("gArc"), { d: `M${B.x.toFixed(1)} ${B.y.toFixed(1)} Q${Q.x.toFixed(1)} ${Q.y.toFixed(1)} ${C.x.toFixed(1)} ${C.y.toFixed(1)}` });

    // Points and their labels, each label pushed away from the middle.
    const G = mul(add(add(A, B), C), 1 / 3);
    ["A", "B", "C"].forEach((name) => {
      const p = pts[name];
      set(svg.querySelector(`[data-pt="${name}"]`), { cx: p.x, cy: p.y });
      const away = sub(p, G);
      const n = len(away) > 1e-6 ? mul(away, 1 / len(away)) : { x: 0, y: -1 };
      set(svg.querySelector(`[data-label="${name}"]`), { x: p.x + n.x * 24 - 5, y: p.y + n.y * 24 + 5 });
    });
  }

  // ---------- pointer to paper ----------

  function toSvg(event) {
    const m = svg.getScreenCTM();
    if (!m) return { x: 0, y: 0 };
    const p = new DOMPoint(event.clientX, event.clientY).matrixTransform(m.inverse());
    return { x: p.x, y: p.y };
  }

  function nearestPoint(p) {
    let best = null;
    let bestD = 22;
    Object.entries(pts).forEach(([name, q]) => {
      const d = Math.hypot(p.x - q.x, p.y - q.y);
      if (d < bestD) { best = name; bestD = d; }
    });
    return best;
  }

  // Inside the triangle, or on one of its sides: grabbing the shape itself
  // moves all three corners together.
  function onTriangle(p) {
    const { A, B, C } = pts;
    const side = (u, v, w) => (w.x - v.x) * (u.y - v.y) - (w.y - v.y) * (u.x - v.x);
    const d1 = side(p, A, B);
    const d2 = side(p, B, C);
    const d3 = side(p, C, A);
    const inside = !((d1 < 0 || d2 < 0 || d3 < 0) && (d1 > 0 || d2 > 0 || d3 > 0));
    if (inside) return true;
    const near = (a, b) => {
      const ab = { x: b.x - a.x, y: b.y - a.y };
      const t = clamp(((p.x - a.x) * ab.x + (p.y - a.y) * ab.y) / (ab.x * ab.x + ab.y * ab.y || 1), 0, 1);
      return Math.hypot(p.x - (a.x + ab.x * t), p.y - (a.y + ab.y * t)) < 14;
    };
    return near(A, B) || near(B, C) || near(C, A);
  }

  function el(tag, cls, attrs) {
    const node = document.createElementNS(NS, tag);
    node.setAttribute("class", cls);
    set(node, attrs || {});
    ink.appendChild(node);
    return node;
  }

  let action = null;

  function begin(event) {
    if (event.button !== undefined && event.button !== 0) return;
    const tool = currentTool();
    const p = toSvg(event);
    if (tool === "select") {
      // A grab during the intro ends it at once, so nothing animates under
      // the finger.
      svg.classList.remove("is-drawing");
      const name = nearestPoint(p);
      if (name) action = { tool, name };
      else if (onTriangle(p)) action = { tool, whole: true, from: p, start: { A: { ...pts.A }, B: { ...pts.B }, C: { ...pts.C } } };
      else return;
      svg.classList.add("is-dragging");
    } else if (tool === "pen") {
      action = { tool, points: [p], node: el("path", "geo ink-stroke", { d: `M${p.x.toFixed(1)} ${p.y.toFixed(1)}` }) };
    } else if (tool === "line") {
      action = { tool, from: p, node: el("line", "geo ink-shape", { x1: p.x, y1: p.y, x2: p.x, y2: p.y }) };
    } else if (tool === "circle") {
      action = { tool, from: p, node: el("circle", "geo ink-shape", { cx: p.x, cy: p.y, r: 0 }) };
    } else if (tool === "triangle") {
      action = { tool, from: p, node: el("path", "geo ink-shape", { d: "" }) };
    } else {
      return;
    }
    event.preventDefault();
    svg.setPointerCapture?.(event.pointerId);
    clearBtn && (clearBtn.hidden = false);
  }

  function move(event) {
    if (!action) {
      if (currentTool() === "select") {
        const at = toSvg(event);
        const overPoint = !!nearestPoint(at);
        svg.classList.toggle("is-over-point", overPoint);
        svg.classList.toggle("is-over-shape", !overPoint && onTriangle(at));
      }
      return;
    }
    const p = toSvg(event);
    const q = { x: clamp(p.x, BOUNDS.minX, BOUNDS.maxX), y: clamp(p.y, BOUNDS.minY, BOUNDS.maxY) };
    if (action.tool === "select" && action.whole) {
      // The whole triangle, kept inside the paper as one piece.
      const s = action.start;
      let dx = p.x - action.from.x;
      let dy = p.y - action.from.y;
      const xs = [s.A.x, s.B.x, s.C.x];
      const ys = [s.A.y, s.B.y, s.C.y];
      dx = clamp(dx, BOUNDS.minX - Math.min(...xs), BOUNDS.maxX - Math.max(...xs));
      dy = clamp(dy, BOUNDS.minY - Math.min(...ys), BOUNDS.maxY - Math.max(...ys));
      pts = {
        A: { x: s.A.x + dx, y: s.A.y + dy },
        B: { x: s.B.x + dx, y: s.B.y + dy },
        C: { x: s.C.x + dx, y: s.C.y + dy }
      };
      update();
    } else if (action.tool === "select") {
      pts[action.name] = q;
      update();
    } else if (action.tool === "pen") {
      const last = action.points[action.points.length - 1];
      if (Math.hypot(q.x - last.x, q.y - last.y) < 1.5) return;
      action.points.push(q);
      // Midpoint quadratics, smooth without a library. Each move appends one
      // segment to the settled part rather than rebuilding the whole stroke.
      const pp = action.points;
      const n = pp.length;
      if (n >= 3) {
        const c = pp[n - 2];
        const mx = (c.x + q.x) / 2;
        const my = (c.y + q.y) / 2;
        action.settled = (action.settled || `M${pp[0].x.toFixed(1)} ${pp[0].y.toFixed(1)}`) +
          ` Q${c.x.toFixed(1)} ${c.y.toFixed(1)} ${mx.toFixed(1)} ${my.toFixed(1)}`;
      }
      const base = action.settled || `M${pp[0].x.toFixed(1)} ${pp[0].y.toFixed(1)}`;
      action.node.setAttribute("d", `${base} L${q.x.toFixed(1)} ${q.y.toFixed(1)}`);
    } else if (action.tool === "line") {
      set(action.node, { x2: q.x, y2: q.y });
    } else if (action.tool === "circle") {
      set(action.node, { r: Math.hypot(q.x - action.from.x, q.y - action.from.y) });
    } else if (action.tool === "triangle") {
      const a = action.from;
      const left = Math.min(a.x, q.x);
      const right = Math.max(a.x, q.x);
      const top = Math.min(a.y, q.y);
      const bottom = Math.max(a.y, q.y);
      action.node.setAttribute("d", `M${((left + right) / 2).toFixed(1)} ${top.toFixed(1)} L${right.toFixed(1)} ${bottom.toFixed(1)} L${left.toFixed(1)} ${bottom.toFixed(1)} Z`);
    }
  }

  function end() {
    if (!action) return;
    // A tap with a shape tool leaves nothing behind rather than a dot.
    if (action.tool !== "select" && action.tool !== "pen") {
      const box = action.node.getBBox();
      if (box.width < 4 && box.height < 4) action.node.remove();
    }
    action = null;
    svg.classList.remove("is-dragging");
  }

  function clearAll() {
    ink.replaceChildren();
    pts = { A: { ...START.A }, B: { ...START.B }, C: { ...START.C } };
    update();
    if (clearBtn) clearBtn.hidden = true;
  }

  // ---------- tools, keys, hint ----------

  function syncTool() {
    const tool = currentTool();
    svg.dataset.tool = tool;
    // Only drawing tools claim the touch; the arrow lets a phone scroll the page.
    svg.style.touchAction = tool === "select" ? "pan-y" : "none";
    if (hint) hint.textContent = HINTS[tool] || "";
  }

  document.querySelectorAll(".nb-window .tool").forEach((button) => {
    button.addEventListener("click", () => window.setTimeout(syncTool, 0));
  });

  // The points can be moved from the keyboard too.
  svg.querySelectorAll("[data-pt]").forEach((node) => {
    node.setAttribute("tabindex", "0");
    node.setAttribute("role", "button");
    node.setAttribute("aria-label", `Point ${node.dataset.pt}. Arrow keys move it.`);
    node.addEventListener("keydown", (event) => {
      const step = event.shiftKey ? 20 : 6;
      const delta = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] }[event.key];
      if (!delta) return;
      event.preventDefault();
      const p = pts[node.dataset.pt];
      pts[node.dataset.pt] = { x: clamp(p.x + delta[0], BOUNDS.minX, BOUNDS.maxX), y: clamp(p.y + delta[1], BOUNDS.minY, BOUNDS.maxY) };
      update();
      if (clearBtn) clearBtn.hidden = false;
    });
  });

  svg.addEventListener("pointerdown", begin);
  svg.addEventListener("pointermove", move);
  svg.addEventListener("pointerup", end);
  svg.addEventListener("pointercancel", end);
  clearBtn?.addEventListener("click", clearAll);

  // Points wobble once on arrival so the first-time visitor sees they are handles.
  if (!reduceMotion.matches) {
    window.setTimeout(() => svg.classList.add("is-inviting"), 3600);
    window.setTimeout(() => svg.classList.remove("is-inviting"), 5200);
  }

  syncTool();
  update();

  window.Inkyscib = window.Inkyscib || {};
  window.Inkyscib.Demo = { points: () => JSON.parse(JSON.stringify(pts)), clear: clearAll, update };
})();
