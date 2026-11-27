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
//   x² = 9          ->  x = -3 or x = 3      (2.9.4: a small digit written
//   2.5 x 4 =       ->  = 10                  raised is a power, a dot low
//   y = x² - 4      ->  Draw graph            between digits is a point)
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
  // How far from the last stroke (in line heights) other ink is looked at.
  const NEAR_LINES = 3;
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
    // A power sits above the band: a small stroke just right of a symbol on
    // the line, up in that symbol's top third (2.9.4).
    const raisedOver = (k, m) => k !== m && !(m.h < m.w * 0.4) && !(k.h < k.w * 0.4) &&
      k.h < m.h * 1.3 && k.maxY > m.minY - H * 0.8 &&
      k.minX > m.maxX - H * 0.3 && k.minX < m.maxX + H * 1.3 &&
      k.maxY < m.cy && k.cy < m.minY + m.h * 0.3;
    // When the last stroke is a power, the line is the one it is raised over.
    let lastStroke = strokes[strokes.length - 1];
    for (let hop = 0; hop < 3; hop += 1) {
      const under = strokes.find((m) => raisedOver(lastStroke, m));
      if (!under) break;
      lastStroke = under;
    }
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
    const raised = new Set();
    grew = true;
    while (grew) {
      grew = false;
      for (const k of strokes) {
        if (inLine.has(k)) continue;
        // Raised over a symbol on the line, or another stroke of a raised
        // symbol (the upright of a small 4).
        const partOf = (r) => raised.has(r) && Math.min(r.maxX, k.maxX) >= Math.max(r.minX, k.minX) - 1 &&
          Math.min(r.maxY, k.maxY) > Math.max(r.minY, k.minY);
        if ([...inLine].some((m) => raisedOver(k, m) || partOf(m))) { inLine.add(k); raised.add(k); grew = true; }
      }
    }
    // Left to right from the last stroke, while the gaps stay under a few
    // symbols wide: other writing further along the same row is not this line.
    const row = [...inLine].sort((a, b) => a.minX - b.minX);
    const at = row.indexOf(lastStroke);
    const gap = Math.max(H * 2.5, 24);
    let lo = at, hi = at;
    let left = lastStroke.minX, right = lastStroke.maxX;
    let moved = true;
    while (moved) {
      moved = false;
      for (let i = 0; i < row.length; i += 1) {
        if (i >= lo && i <= hi) continue;
        const k = row[i];
        if (k.maxX >= left - gap && k.minX <= right + gap) {
          lo = Math.min(lo, i); hi = Math.max(hi, i);
          left = Math.min(left, k.minX); right = Math.max(right, k.maxX);
          moved = true;
        }
      }
    }
    const chain = new Set(row.filter((k) => k.maxX >= left && k.minX <= right));
    return strokes.filter((k) => chain.has(k));
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
    if (ks.length === 1 && isOneStrokeY(ks[0], H)) return "y";
    if (ks.length === 2) {
      const [a, b] = ks;
      if (flat(a) && flat(b) && Math.abs(a.cy - b.cy) > Math.max(a.h, b.h) + 2) return "=";
      if ((upright(a) && flat(b)) || (upright(b) && flat(a))) return "+";
      if (isTwoStrokeY(a, b, H)) return "y";
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
  // The line is read again on every pause, but its earlier symbols have not
  // changed, so each one's reading is kept against its strokes' points
  // (2.10.2). The key includes every stroke's ends and length, so a stroke
  // that is moved or edited in place is simply read afresh.
  const digitCache = new WeakMap();
  const digitKey = (ks) => ks.map((k) => `${k.points.length}:${k.first.x},${k.first.y}:${k.last.x},${k.last.y}`).join("|");

  function readDigit(ks) {
    const owner = ks[0].points;
    const key = digitKey(ks);
    let seen = digitCache.get(owner);
    if (seen && seen.has(key)) return seen.get(key);
    const result = readDigitFresh(ks);
    if (!seen) { seen = new Map(); digitCache.set(owner, seen); }
    if (seen.size > 8) seen.clear();
    seen.set(key, result);
    return result;
  }

  function readDigitFresh(ks) {
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
      // A clear winner as drawn needs no stretching (2.10.2: a third of the work).
      if (stretch === 1 && r && r.margin > 0.12) return r.digit;
    }
    return best && best.digit !== "1" ? best.digit : null;
  }

  // The largest change of heading (degrees) across any 15% of a stroke's
  // length either side of a point, on the stroke resampled evenly by length.
  function sharpestTurn(points) {
    const n = 40;
    const lens = [0];
    for (let i = 1; i < points.length; i += 1) lens.push(lens[i - 1] + Math.hypot(points[i].x - points[i - 1].x, points[i].y - points[i - 1].y));
    const total = lens[lens.length - 1];
    if (!(total > 0)) return 0;
    const even = [];
    let j = 0;
    for (let k = 0; k < n; k += 1) {
      const at = (total * k) / (n - 1);
      while (j < lens.length - 2 && lens[j + 1] < at) j += 1;
      const span = lens[j + 1] - lens[j] || 1;
      const t = Math.min(1, Math.max(0, (at - lens[j]) / span));
      const a = points[j];
      const b = points[Math.min(points.length - 1, j + 1)];
      even.push({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
    }
    const w = 6;
    let worst = 0;
    for (let i = w; i < n - w; i += 1) {
      const h1 = Math.atan2(even[i].y - even[i - w].y, even[i].x - even[i - w].x);
      const h2 = Math.atan2(even[i + w].y - even[i].y, even[i + w].x - even[i].x);
      let d = Math.abs(h2 - h1);
      if (d > Math.PI) d = 2 * Math.PI - d;
      worst = Math.max(worst, (d * 180) / Math.PI);
    }
    return worst;
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
    // A bow bends evenly; a narrow 7 has one sharp corner where its bar meets
    // its leg, and read as ")" (2.10.1). Along the stroke, by length, compare
    // the heading of the stretch before each point with the one after it: a
    // half circle turns about 30 degrees across that window, a 7 well over 90.
    if (sharpestTurn(k.points) > 80) return false;
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

  // y in two strokes: a short arm like a \ that meets the middle of a long
  // one like a /, which runs on below it. An x's arms are equal and cross.
  function isTwoStrokeY(a, b, H) {
    const len = (k) => Math.hypot(k.w, k.h);
    const [arm, stem] = len(a) < len(b) ? [a, b] : [b, a];
    if (!arm.straight || !stem.straight) return false;
    if (len(arm) > len(stem) * 0.75 || stem.h < H * 0.6) return false;
    if (!(slope(stem) < 0 && stem.w > stem.h * 0.15)) return false;
    if (!(slope(arm) > 0 && arm.w > arm.h * 0.3)) return false;
    if (Math.abs(arm.minY - stem.minY) > stem.h * 0.3) return false;
    if (stem.maxY - arm.maxY < stem.h * 0.3) return false;
    // The arm's lower end touches the stem, about halfway down.
    const foot = arm.first.y > arm.last.y ? arm.first : arm.last;
    const dx = stem.last.x - stem.first.x;
    const dy = stem.last.y - stem.first.y;
    const off = Math.abs(dx * (stem.first.y - foot.y) - (stem.first.x - foot.x) * dy) / (Math.hypot(dx, dy) || 1);
    if (off > len(stem) * 0.2) return false;
    const down = (foot.y - stem.minY) / (stem.h || 1);
    return down > 0.2 && down < 0.7;
  }

  // y in one stroke: down into a v, back up to the top, then a long tail down
  // and to the left. A one-stroke 4 starts right of its corner, and its last
  // leg drops straight.
  function isOneStrokeY(k, H) {
    if (k.h < H * 0.6 || k.points.length < 8) return false;
    const pts = k.points;
    const n = pts.length;
    let iC = Math.floor(n * 0.25);
    for (let i = iC; i < Math.floor(n * 0.8); i += 1) if (pts[i].y < pts[iC].y) iC = i;
    let iB = 0;
    for (let i = 0; i < iC; i += 1) if (pts[i].y > pts[iB].y) iB = i;
    const A = pts[0], B = pts[iB], C = pts[iC], D = pts[n - 1];
    const at = (p) => (p.y - k.minY) / (k.h || 1);
    if (at(A) > 0.25 || at(C) > 0.25 || at(B) < 0.25 || at(B) > 0.7 || at(D) < 0.85) return false;
    if (!(C.x > A.x + k.w * 0.25 && B.x > A.x && B.x < C.x && D.x < C.x - k.w * 0.1)) return false;
    // The tail only goes down.
    for (let i = iC + 2; i < n; i += 1) if (pts[i].y < pts[i - 2].y - k.h * 0.06) return false;
    return true;
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
    const isDot = (g) => g.strokes.length === 1 && Math.max(g.maxX - g.minX, g.maxY - g.minY) < H * 0.24;
    const items = [];
    for (const g of groups) {
      const sym = isDot(g) ? "." : classify(g, H);
      if (!sym) return null;
      items.push({ ...g, sym });
    }
    // A dot is a decimal point only low between two digits.
    const digit = (it) => it && /^[0-9]$/.test(it.sym);
    for (let i = 0; i < items.length; i += 1) {
      if (items[i].sym !== ".") continue;
      const prev = items[i - 1];
      const dotCy = (items[i].minY + items[i].maxY) / 2;
      if (!digit(prev) || !digit(items[i + 1]) || dotCy < prev.minY + (prev.maxY - prev.minY) * 0.65) return null;
    }
    // Powers: a digit or x whose bottom sits above the middle of the symbol
    // before it, and whose middle is up in that symbol's top third, is raised.
    let text = "";
    let base = null;
    let raised = [];
    const flush = () => {
      if (raised.length) text += "^" + (raised.length > 1 ? "(" + raised.join("") + ")" : raised[0]);
      raised = [];
    };
    for (const it of items) {
      if (base && /^[0-9x]$/.test(it.sym) && /^[0-9x)]$/.test(base.sym)) {
        const bh = base.maxY - base.minY;
        const up = it.maxY < (base.minY + base.maxY) / 2 && (it.minY + it.maxY) / 2 < base.minY + bh * 0.3;
        if (up) { raised.push(it.sym); continue; }
      }
      flush();
      text += it.sym;
      base = it;
    }
    flush();
    const box = {
      minX: Math.min(...line.map((k) => k.minX)), maxX: Math.max(...line.map((k) => k.maxX)),
      minY: Math.min(...line.map((k) => k.minY)), maxY: Math.max(...line.map((k) => k.maxY))
    };
    return { text, box };
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
      return power();
    };
    // a^b binds tighter than a minus in front (-x^2 is -(x^2)) and runs
    // right to left (2^3^2 is 2^9).
    const power = () => {
      const b = factor();
      if (!b || peek() !== "^") return b;
      i += 1;
      const e = peek() === "-" ? (i += 1, (() => { const g = power(); return g && ((x) => -g(x)); })()) : power();
      if (!e) return null;
      return (x) => Math.pow(b(x), e(x));
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
      const m = /^[0-9]+(\.[0-9]+)?/.exec(t.slice(i));
      if (m) { i += m[0].length; const v = Number(m[0]); return () => v; }
      return null;
    };
    const f = expr();
    return f && i === t.length ? f : null;
  }

  const near = (a, b) => Math.abs(a - b) < 1e-9 * Math.max(1, Math.abs(a), Math.abs(b));

  // A number as a person would write it: whole, a small fraction, or (when
  // the question was asked in decimals) a decimal.
  function show(n, decimal = false) {
    if (!Number.isFinite(n)) return null;
    if (near(n, Math.round(n))) return String(Math.round(n));
    if (decimal) return String(+n.toFixed(6));
    for (let d = 2; d <= 12; d += 1) {
      const top = n * d;
      if (near(top, Math.round(top))) return `${Math.round(top)}/${d}`;
    }
    return String(+n.toFixed(4));
  }

  const SUPER = { 0: "⁰", 1: "¹", 2: "²", 3: "³", 4: "⁴", 5: "⁵", 6: "⁶", 7: "⁷", 8: "⁸", 9: "⁹", x: "ˣ", "-": "⁻", "+": "⁺", "(": "⁽", ")": "⁾" };
  const sup = (s) => [...s].map((c) => SUPER[c] || c).join("");

  const pretty = (text) => text
    .replace(/\^\(([^()]*)\)/g, (_, e) => sup(e)).replace(/\^([0-9x])/g, (_, e) => sup(e))
    .replace(/\*/g, " × ").replace(/\//g, " ÷ ").replace(/([+\-=])/g, " $1 ")
    .replace(/\s+/g, " ").replace(/^ - /, "-").trim();

  // The real roots of h on [-R, R]: sign changes, bisected, and touching
  // roots (x - 1)² found as minima of |h| that reach zero.
  function realRoots(h, R, tol) {
    const N = 4000;
    const out = [];
    const add = (r) => {
      if (!(Math.abs(h(r)) <= tol)) return;
      if (!out.some((q) => Math.abs(q - r) < 1e-6 * Math.max(1, Math.abs(r)))) out.push(r);
    };
    const bisect = (a, b) => {
      let fa = h(a);
      for (let k = 0; k < 80; k += 1) {
        const m = (a + b) / 2;
        const fm = h(m);
        if (fm === 0) return m;
        if ((fa < 0) === (fm < 0)) { a = m; fa = fm; } else b = m;
      }
      return (a + b) / 2;
    };
    const xs = Array.from({ length: N + 1 }, (_, k) => -R + (2 * R * k) / N);
    const ys = xs.map(h);
    for (let k = 0; k <= N; k += 1) {
      if (!Number.isFinite(ys[k])) continue;
      if (ys[k] === 0) { add(xs[k]); continue; }
      if (k < N && Number.isFinite(ys[k + 1]) && ys[k + 1] !== 0 && (ys[k] < 0) !== (ys[k + 1] < 0)) add(bisect(xs[k], xs[k + 1]));
      if (k > 0 && k < N && Number.isFinite(ys[k - 1]) && Number.isFinite(ys[k + 1]) &&
          Math.abs(ys[k]) < Math.abs(ys[k - 1]) && Math.abs(ys[k]) < Math.abs(ys[k + 1]) &&
          (ys[k] < 0) === (ys[k - 1] < 0) && (ys[k] < 0) === (ys[k + 1] < 0)) {
        let a = xs[k - 1];
        let b = xs[k + 1];
        for (let j = 0; j < 100; j += 1) {
          const m1 = a + (b - a) / 3;
          const m2 = b - (b - a) / 3;
          if (Math.abs(h(m1)) < Math.abs(h(m2))) b = m2; else a = m1;
        }
        add((a + b) / 2);
      }
    }
    // Snap to a whole number or a small fraction when that is exact.
    return out.map((r) => {
      for (let d = 1; d <= 12; d += 1) {
        const c = Math.round(r * d) / d;
        if (Math.abs(c - r) < 1e-5 * Math.max(1, Math.abs(r)) && Math.abs(h(c)) <= tol) return c;
      }
      return r;
    }).sort((p, q) => p - q);
  }

  function sayRoots(rs, decimal) {
    if (!rs.length || rs.length > 4) return null;
    const exact = rs.every((r) => {
      const s = show(r, decimal);
      return s && s.length < 7 && near(Number(s.includes("/") ? s.split("/")[0] / s.split("/")[1] : s), r);
    });
    const each = rs.map((r) => (exact ? show(r, decimal) : (+r.toFixed(3)).toString()));
    const eq = exact ? "=" : "≈";
    if (each.length === 1) return `x ${eq} ${each[0]}`;
    if (each.length === 2) return `x ${eq} ${each[0]} or x ${eq} ${each[1]}`;
    return `x ${eq} ${each.slice(0, -1).join(", ")} or ${each[each.length - 1]}`;
  }

  // The polynomial's degree from its finite differences at 0..7 (null when it
  // is not a polynomial of degree 6 or less), and its coefficient bound.
  function polynomial(h) {
    const v = Array.from({ length: 8 }, (_, k) => h(k));
    if (v.some((y) => !Number.isFinite(y))) return null;
    const scale = Math.max(1, ...v.map(Math.abs));
    let row = v;
    for (let d = 0; d < 7; d += 1) {
      const next = row.slice(1).map((y, k) => y - row[k]);
      if (next.every((y) => Math.abs(y) < 1e-9 * scale)) {
        // Coefficients by Newton's forward differences, then Cauchy's bound.
        const coeffs = newtonToPower(v.slice(0, d + 1));
        const lead = coeffs[d] || 1;
        const R = 1 + Math.max(0, ...coeffs.slice(0, d).map((c) => Math.abs(c / lead)));
        return { degree: d, R: Math.min(1e4, R), scale };
      }
      row = next;
    }
    return null;
  }

  // Power-basis coefficients of the polynomial through (k, v[k]), k = 0..n.
  function newtonToPower(v) {
    const n = v.length;
    const diffs = [];
    let row = v.slice();
    for (let k = 0; k < n; k += 1) { diffs.push(row[0]); row = row.slice(1).map((y, j) => y - row[j]); }
    // sum_k diffs[k] * C(x, k), with C(x, k) = x(x-1)...(x-k+1)/k!
    let result = new Array(n).fill(0);
    let basis = [1];
    let fact = 1;
    for (let k = 0; k < n; k += 1) {
      if (k > 0) {
        fact *= k;
        const nextBasis = new Array(basis.length + 1).fill(0);
        basis.forEach((c, j) => { nextBasis[j + 1] += c; nextBasis[j] -= c * (k - 1); });
        basis = nextBasis;
      }
      basis.forEach((c, j) => { result[j] += (diffs[k] * c) / fact; });
    }
    return result;
  }

  /** What to say about a line of maths, or null when there is nothing to say. */
  function answer(text) {
    if (!text || !text.includes("=")) return null;
    const parts = text.split("=");
    if (parts.length !== 2) return null;
    let [left, right] = parts;
    if (!left) return null;
    const decimal = text.includes(".");

    // "3x4=" asks for an answer, so an x between digits is a times sign.
    const asTimes = (side) => side.replace(/(?<=[0-9)])x(?=[0-9(.])/g, "*");

    // y = (something in x) is a graph, offered rather than drawn.
    if (right === "y" && !left.includes("y")) [left, right] = [right, left];
    if (left === "y") {
      if (!right || right.includes("y")) return null;
      const f = compile(right);
      if (!f) return null;
      return { kind: "graph", say: `y = ${pretty(right)}`, f, expr: right };
    }
    if (text.includes("y")) return null;

    if (!right) {
      const f = compile(asTimes(left));
      if (!f || /x/.test(asTimes(left))) return null;
      const v = f(0);
      const shown = show(v, decimal);
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
      if (near(a, b) || (decimal && Math.abs(a - b) < 1e-9 * Math.max(1, Math.abs(a)))) return { kind: "right", say: "Correct" };
      return { kind: "wrong", say: `Not quite: ${pretty(left)} = ${show(a, decimal)}` };
    }

    // An equation in x. "x = 4" on its own says nothing new.
    if (/^x$/.test(left) && !/x/.test(right)) return null;
    const f = compile(left);
    const g = compile(right);
    if (!f || !g) return null;
    const h = (x) => f(x) - g(x);
    const v = [0, 1, 2, 3, 4].map(h);
    const finite = v.every(Number.isFinite);
    const d1 = v.slice(1).map((y, k) => y - v[k]);
    const d2 = d1.slice(1).map((y, k) => y - d1[k]);
    const d3 = d2.slice(1).map((y, k) => y - d2[k]);
    const flat = (arr) => arr.every((y) => Math.abs(y) < 1e-9 * Math.max(1, ...v.map(Math.abs)));
    if (finite && flat(d2)) {
      const m = d1[0];
      if (Math.abs(m) < 1e-12) return near(v[0], 0) ? { kind: "solve", say: "True for every x" } : { kind: "solve", say: "No x makes this true" };
      const x0 = -v[0] / m;
      const root = show(x0, decimal);
      if (root === null) return null;
      return { kind: "solve", say: root.includes("/") ? `x = ${root} ≈ ${+x0.toFixed(3)}` : `x = ${root}` };
    }
    if (finite && flat(d3)) {
      const a = d2[0] / 2;
      const b = d1[0] - a;
      const c = v[0];
      const disc = b * b - 4 * a * c;
      if (disc < -1e-9) return { kind: "solve", say: "No real x" };
      const r = Math.sqrt(Math.max(0, disc));
      const x1 = (-b - r) / (2 * a);
      const x2 = (-b + r) / (2 * a);
      if (near(x1, x2)) return { kind: "solve", say: `x = ${show(x1, decimal)}` };
      const [lo, hi] = [x1, x2].sort((p, q) => p - q);
      if (near(lo, Math.round(lo)) && near(hi, Math.round(hi)) || (show(lo, decimal) || "").length < 6) {
        return { kind: "solve", say: `x = ${show(lo, decimal)} or x = ${show(hi, decimal)}` };
      }
      return { kind: "solve", say: `x ≈ ${lo.toFixed(3)} or x ≈ ${hi.toFixed(3)}` };
    }
    // Higher powers (2.9.4): a cubic, a quartic, up to x⁶, found numerically
    // inside the bound every root must lie in. Not a polynomial (1/x, a power
    // of x): searched on [-100, 100] and only answered when roots are found.
    const poly = polynomial(h);
    const R = poly ? poly.R : 100;
    const tol = 1e-8 * (poly ? poly.scale : Math.max(1, ...v.filter(Number.isFinite).map(Math.abs)));
    const rs = realRoots(h, R + 1e-9, tol);
    if (!rs.length) return poly ? { kind: "solve", say: "No real x" } : null;
    const said = sayRoots(rs, decimal);
    return said ? { kind: "solve", say: said } : null;
  }

  // ---------- watching the pen ----------

  let lastPath = null;
  let pauseTimer = 0;
  let chip = null;
  let chipTimer = 0;
  let lastSaid = "";
  let pending = null;

  function track() {
    const st = s();
    if (!st || st.currentTool !== "pen") return;
    const path = st.paths?.[st.paths.length - 1];
    if (!path || path.tool !== "pen" || !Array.isArray(path.points) || path.points.length < 2) return;
    lastPath = path;
  }

  const readable = (p) => p && p.tool === "pen" && !p.mathGraph &&
    Array.isArray(p.points) && p.points.length >= 2;

  // The ink around the last stroke, wherever it came from. Until 2.10.1 only
  // strokes written within 8 seconds of each other were read together, so a
  // pause to think before the "=" lost the start of the line and nothing was
  // answered. Now the page itself is read: pen strokes at the last stroke's
  // height, and sameLine and the left-to-right chain below pick the line.
  function strokesNear(last, paths) {
    const box = info(last.points);
    const h = Math.max(10, box.h, box.w);
    const top = box.minY - h * NEAR_LINES;
    const bottom = box.maxY + h * NEAR_LINES;
    const near = [];
    for (let i = paths.length - 1, seen = 0; i >= 0 && seen < 600; i -= 1) {
      const p = paths[i];
      if (p === last || !readable(p)) continue;
      seen += 1;
      let minY = Infinity, maxY = -Infinity;
      for (const q of p.points) { if (q.y < minY) minY = q.y; if (q.y > maxY) maxY = q.y; }
      if (maxY >= top && minY <= bottom) near.unshift(p.points);
    }
    return [...near, last.points];
  }

  function consider() {
    if (!enabled()) return;
    const st = s();
    // The last stroke must still be on the page (an undo or an erase takes it out).
    if (!readable(lastPath) || !(st?.paths || []).includes(lastPath)) return;
    const read = readLine(strokesNear(lastPath, st.paths));
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
      <button type="button" class="im-act" hidden>Draw graph</button>
      <button type="button" class="im-close" aria-label="Dismiss">&times;</button>`;
    chip.querySelector(".im-close").addEventListener("click", hideChip);
    chip.querySelector(".im-act").addEventListener("click", () => {
      if (pending) drawGraph(pending.said, pending.read);
      hideChip();
    });
    document.body.appendChild(chip);
  }

  function showChip(said, read) {
    if (!chip) buildChip();
    chip.dataset.kind = said.kind;
    chip.dataset.read = read.text;
    chip.querySelector(".im-mark").textContent = said.kind === "right" ? "✓" : said.kind === "wrong" ? "✗" : "";
    chip.querySelector(".im-say").textContent = said.say;
    chip.querySelector(".im-act").hidden = said.kind !== "graph";
    pending = said.kind === "graph" ? { said, read } : null;
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

  // ---------- a graph, drawn in ink (2.9.4) ----------
  //
  // "Draw graph" puts real pen strokes on the page under the line: axes, ticks,
  // numbers written in strokes, and the curve. They are ordinary ink, so they
  // save, export, erase and select like anything written, and one undo takes
  // the whole graph back off.

  const GL = (x0, y0, x1, y1) => [[x0, y0], [x1, y1]];
  const GA = (cx, cy, rx, ry, a, b, n = 14) => Array.from({ length: n + 1 }, (_, k) => {
    const t = a + ((b - a) * k) / n;
    return [cx + Math.cos(t) * rx, cy + Math.sin(t) * ry];
  });
  const PI = Math.PI;
  // A small hand for numbers, in a unit box, y down.
  const FONT = {
    0: [GA(0.5, 0.5, 0.42, 0.5, 0, 2 * PI, 18)],
    1: [[[0.25, 0.2], [0.55, 0], [0.55, 1]]],
    2: [[...GA(0.5, 0.3, 0.4, 0.3, PI, 2 * PI, 10), [0.08, 1], [0.92, 1]]],
    3: [[...GA(0.48, 0.26, 0.36, 0.26, -0.85 * PI, 0.5 * PI, 10), ...GA(0.48, 0.74, 0.4, 0.26, -0.5 * PI, 0.85 * PI, 10)]],
    4: [[[0.7, 1], [0.7, 0], [0.05, 0.68], [0.95, 0.68]]],
    5: [[[0.85, 0], [0.22, 0], [0.18, 0.44], ...GA(0.48, 0.7, 0.4, 0.3, -0.62 * PI, 0.85 * PI, 10)]],
    6: [[[0.78, 0.02], ...GA(0.5, 0.7, 0.38, 0.3, PI * 1.05, PI * 3.05, 14)]],
    7: [[[0.08, 0], [0.92, 0], [0.38, 1]]],
    8: [[...GA(0.5, 0.26, 0.32, 0.26, -PI / 2, 1.5 * PI, 12), ...GA(0.5, 0.74, 0.4, 0.26, -PI / 2, -2.5 * PI, 12)]],
    9: [[...GA(0.5, 0.3, 0.38, 0.3, 0, -2 * PI, 14), [0.88, 0.3], [0.74, 1]]],
    "-": [GL(0.1, 0.55, 0.8, 0.55)],
    ".": [GL(0.45, 0.94, 0.5, 1)],
    x: [GL(0.1, 0.4, 0.9, 1), GL(0.9, 0.4, 0.1, 1)],
    y: [GL(0.1, 0.4, 0.5, 0.75), GL(0.9, 0.4, 0.2, 1.3)]
  };

  function niceStep(span) {
    const raw = span / 6;
    const p = Math.pow(10, Math.floor(Math.log10(raw)));
    const m = raw / p;
    return (m < 1.5 ? 1 : m < 3.5 ? 2 : m < 7.5 ? 5 : 10) * p;
  }

  const label = (v) => String(+v.toFixed(6));

  /** The window and strokes of the graph of f (world units), or null. */
  function graphStrokes(f, at, width) {
    // x: -5..5, widened to show any root within 20.
    let x0 = -5, x1 = 5;
    for (const r of realRoots(f, 20, 1e-7)) { x0 = Math.min(x0, Math.floor(r) - 1); x1 = Math.max(x1, Math.ceil(r) + 1); }
    const N = 400;
    const sample = () => Array.from({ length: N + 1 }, (_, k) => { const x = x0 + ((x1 - x0) * k) / N; return { x, y: f(x) }; });
    let pts = sample();
    const ys = pts.map((p) => p.y).filter(Number.isFinite).sort((a, b) => a - b);
    if (ys.length < N * 0.3) return null;
    // A pole (1/x) would flatten everything else, so trim the far 5%.
    let y0 = ys[Math.floor(ys.length * 0.05)];
    let y1 = ys[Math.ceil(ys.length * 0.95) - 1];
    if (ys.length === N + 1) { y0 = ys[0]; y1 = ys[ys.length - 1]; }
    if (Math.abs(y1 - y0) < 1e-9) { y0 -= 5; y1 += 5; }
    y0 = Math.min(y0, 0); y1 = Math.max(y1, 0);
    const pad = (y1 - y0) * 0.08;
    y0 -= pad; y1 += pad;
    const W = width;
    const Hh = width * 0.75;
    let sx = W / (x1 - x0);
    let sy = Hh / (y1 - y0);
    // The same scale both ways when that fits, so slopes look like slopes.
    if (sy / sx > 0.25 && sy / sx < 4) {
      const s = Math.min(sx, sy);
      const growX = (W / s - (x1 - x0)) / 2;
      const growY = (Hh / s - (y1 - y0)) / 2;
      x0 -= growX; x1 += growX; y0 -= growY; y1 += growY;
      sx = sy = s;
      pts = sample();
    }
    const X = (x) => at.x + (x - x0) * sx;
    const Y = (y) => at.y + (y1 - y) * sy;
    const axes = [];
    const curve = [];
    const text = [];
    // Axes with an arrowhead on each positive end.
    const ah = W * 0.025;
    axes.push([[X(x0), Y(0)], [X(x1), Y(0)]], [[X(x1) - ah, Y(0) - ah * 0.7], [X(x1), Y(0)], [X(x1) - ah, Y(0) + ah * 0.7]]);
    axes.push([[X(0), Y(y0)], [X(0), Y(y1)]], [[X(0) - ah * 0.7, Y(y1) + ah], [X(0), Y(y1)], [X(0) + ah * 0.7, Y(y1) + ah]]);
    // Ticks and numbers.
    const lh = Hh * 0.05;
    const word = (str, x, y, align) => {
      const cw = lh * 0.62;
      const total = str.length * cw + (str.length - 1) * lh * 0.18;
      let cx = align === "right" ? x - total : align === "center" ? x - total / 2 : x;
      for (const ch of str) {
        for (const stroke of FONT[ch] || []) text.push(stroke.map(([u, v]) => [cx + u * cw, y + v * lh]));
        cx += cw + lh * 0.18;
      }
    };
    const tick = W * 0.012;
    const stepX = niceStep(x1 - x0);
    for (let v = Math.ceil(x0 / stepX) * stepX; v < x1 - stepX * 0.3; v += stepX) {
      if (Math.abs(v) < stepX * 1e-6) continue;
      axes.push([[X(v), Y(0) - tick], [X(v), Y(0) + tick]]);
      word(label(v), X(v), Y(0) + tick + lh * 0.4, "center");
    }
    const stepY = niceStep(y1 - y0);
    for (let v = Math.ceil(y0 / stepY) * stepY; v < y1 - stepY * 0.3; v += stepY) {
      if (Math.abs(v) < stepY * 1e-6) continue;
      axes.push([[X(0) - tick, Y(v)], [X(0) + tick, Y(v)]]);
      word(label(v), X(0) - tick - lh * 0.4, Y(v) - lh / 2, "right");
    }
    word("x", X(x1) - lh * 0.4, Y(0) - lh * 1.9, "right");
    word("y", X(0) + lh * 0.7, Y(y1) - lh * 0.2, "left");
    // The curve, broken where it leaves the window or jumps (an asymptote).
    let run = [];
    const end = () => { if (run.length > 1) curve.push(run); run = []; };
    for (const p of pts) {
      const inside = Number.isFinite(p.y) && p.y >= y0 && p.y <= y1;
      if (!inside) { end(); continue; }
      const q = [X(p.x), Y(p.y)];
      const prev = run[run.length - 1];
      if (prev && Math.abs(q[1] - prev[1]) > Hh * 0.5) end();
      run.push(q);
    }
    end();
    if (!curve.length) return null;
    return { axes, curve, text, box: { x0, x1, y0, y1 }, size: { w: W, h: Hh } };
  }

  function drawGraph(said, read) {
    const st = s();
    if (!st?.paths || typeof said?.f !== "function") return null;
    const scale = st.transform?.scale || 1;
    const lineH = Math.max(10, read.box.maxY - read.box.minY);
    const width = Math.max(340 / scale, (read.box.maxX - read.box.minX) * 1.1);
    const at = { x: read.box.minX, y: read.box.maxY + lineH * 0.9 };
    const g = graphStrokes(said.f, at, width);
    if (!g) return null;
    if (typeof window.commitHistory === "function") window.commitHistory();
    const pen = st.toolSettings?.pen || {};
    const ink = pen.color || (document.documentElement.dataset.theme === "light" ? "#1b1b18" : "#ffffff");
    const id = "g" + Date.now().toString(36);
    const make = (pts, size, color) => ({
      tool: "pen", size, color, penStyle: "default", timestamp: Date.now(), mathGraph: id,
      points: pts.map(([x, y]) => ({ x, y, pressure: 0.5 }))
    });
    const added = [
      ...g.axes.map((p) => make(p, 1.5, "#8a8f98")),
      ...g.text.map((p) => make(p, 1.2, "#8a8f98")),
      ...g.curve.map((p) => make(p, Math.max(2.5, pen.size || 3), ink))
    ];
    st.paths.push(...added);
    if (typeof window.invalidateCanvasDrawingCache === "function") window.invalidateCanvasDrawingCache();
    if (typeof window.render === "function") window.render();
    if (typeof window.saveDrawing === "function") window.saveDrawing();
    return { id, paths: added.length, box: g.box };
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
  document.addEventListener("toolChanged", () => { lastPath = null; });

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

  window.Inkyscib.InkMath = { readLine, answer, compile, consider, drawGraph, graphStrokes, realRoots, PAUSE_MS };
})();
