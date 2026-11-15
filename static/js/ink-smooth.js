// Write assist, on lift: turn the raw samples of a finished stroke into smooth ink.
//
// The live filter in events.js is causal - at each sample it only has the
// past - so it can steady a hand only by lagging behind it. Measured before
// this module existed, "natural" trailed the nib by ~9.7px, ended strokes
// ~11px short of where the pen lifted, and cut curves until the ink sat
// further from the intended line than no assist at all (RMS 1.63 against 0.82
// raw). See docs/superpowers/specs/2026-09-14-editor-feedback-design.md,
// section 7, and tests/test_ink_smoothing.py.
//
// Once the pen lifts the whole stroke exists, so it can be smoothed with a
// symmetric kernel that has no lag at all. The rules:
//
//   - Smooth in arc-length space, weighting each sample by the length of line
//     it stands for, so slow and fast writing get the same strength.
//   - Measure that arc length along a de-jittered copy of the stroke. Jitter
//     makes a raw polyline longer than the line it traces, which shrank the
//     kernel exactly where the hand shook most.
//   - Keep corners. A v, a z or a 4 is made of them. Corners are found on the
//     de-jittered copy, where a tremor's tiny reversals are gone but a real
//     change of direction is not, and the kernel narrows there. Found on the
//     raw samples instead, touch jitter read as corners everywhere and was
//     left almost unsmoothed (turn jitter 0.43 where 0.08 was the target).
//   - Never let the kernel be narrower than the samples are far apart, so
//     sparse mouse input still averages its neighbours.
//   - A fingertip is noisier than a stylus, so touch gets a wider kernel.
//   - Both ends are exactly where the pen went down and came up, and the
//     kernel tapers into them so there is no kink.
//   - No point moves further from the drawn stroke than a small bound.
//   - Pressure is smoothed the same way, so variable-width nibs stop flickering.
//   - Every sample keeps its own time, and the count is unchanged -- except
//     that at the top of the write-assist range a touch-down or lift-off
//     hook of a few pixels may be trimmed from either end (trimHooks).
//
// The constants below were chosen by a sweep, not by eye: wobble (turn
// jitter), distance from the intended curve, and how far a zigzag's corners
// move, for pen and touch at both strengths. Every one is a trade - a wider
// kernel removes more wobble and starts cutting curves - so change one only
// with tests/test_ink_smoothing.py running.
(function () {
  "use strict";

  // Kernel widths and the movement bound, in screen pixels; divided by the
  // zoom so they are the same size on screen at any zoom.
  const STRENGTHS = {
    natural: { sigma: 3.2, bound: 3.5 },
    strong: { sigma: 4.8, bound: 5.0 }
  };
  // The de-jittered copy corners are read from is this much smoother. At 2 the
  // crests of an ordinary curve drawn by finger still read as corners and kept
  // their wobble; at 3 a real zigzag corner moved 1.9px, past the 1.5px limit.
  const DETECT_WIDTH = 2.5;
  // How far each side of a point to look when deciding whether it is a corner,
  // in kernel widths.
  const CORNER_REACH = 3;
  // Turns sharper than this (radians between the two directions) begin to
  // count as corners, fully so from CORNER_FULL.
  const CORNER_ANGLE = 0.9;
  const CORNER_FULL = 1.6;
  const SPACING_FLOOR = 1.2;
  // A fingertip reports about twice the jitter of a stylus (3.2px against
  // 1.6px on the synthetic strokes), so touch gets a wider kernel. Per
  // strength: natural needs the full 1.9 to steady a finger, while strong
  // already starts wide and began cutting curves past 1.6 (RMS 1.27 against
  // 1.16 raw at 1.75).
  const INPUT_NOISE = {
    touch: {
      natural: { sigma: 1.9, bound: 1.6 },
      strong: { sigma: 1.6, bound: 1.6 }
    }
  };
  const NO_EXTRA_NOISE = { sigma: 1, bound: 1 };

  // ---------- write assist as a level ----------
  //
  // One number, 0 to 100, instead of Off / Natural / Strong. Every parameter
  // is a curve through the same anchors, and the anchors ARE the old presets:
  // 40 is Natural and 70 is Strong to the last digit, so everything
  // tests/test_ink_smoothing.py measured about them still holds exactly there.
  // 0 is Off. Old saved settings map onto the anchors, so nobody's preference
  // moves under them.
  //
  // 70-100 is new ground, asked for as "as clean and as uniform as possible":
  // a wider kernel, a looser (still bounded) movement band, and line weight
  // evened out -- pressure pulled toward the stroke's median, so a stylus
  // stops leaving thick and thin. The live filter barely changes up there
  // (events.js): the heavy lifting stays at lift, where it costs no lag.
  const LEVEL_OF = { off: 0, natural: 40, strong: 70 };
  const DEFAULT_LEVEL = 40;

  function assistLevel(value) {
    if (typeof value === "string") {
      if (Object.prototype.hasOwnProperty.call(LEVEL_OF, value)) return LEVEL_OF[value];
      if (value.trim() === "") return DEFAULT_LEVEL;
      value = Number(value);
    }
    if (typeof value !== "number" || !Number.isFinite(value)) return DEFAULT_LEVEL;
    return Math.max(0, Math.min(100, Math.round(value)));
  }

  // A level's parameters, read off piecewise-linear curves through the
  // anchors. At an anchor the anchor's own numbers are returned untouched, so
  // no floating-point interpolation can nudge Natural or Strong.
  function alongAnchors(anchors, level) {
    for (const anchor of anchors) if (anchor.level === level) return anchor;
    if (level <= anchors[0].level) return anchors[0];
    for (let i = 1; i < anchors.length; i++) {
      const hi = anchors[i];
      if (level > hi.level) continue;
      const lo = anchors[i - 1];
      const k = (level - lo.level) / (hi.level - lo.level);
      const out = { level };
      for (const key of Object.keys(hi)) {
        if (key !== "level") out[key] = lo[key] + (hi[key] - lo[key]) * k;
      }
      return out;
    }
    return anchors[anchors.length - 1];
  }

  // Kernel width and movement band on screen, and how far pressure is pulled
  // to the median. touchSigma/touchBound are the extra widening a fingertip
  // needs over a stylus (INPUT_NOISE above, per anchor). hook is the longest
  // end hook, in screen px, that trimHooks may take off.
  //
  // Why the geometry stops changing at Strong. Measured on the mean of 12
  // synthetic strokes: the intended line itself scores 0.0575 on turn jitter,
  // and Strong's pen output already scores 0.0559 -- at the floor. There is no
  // wobble left to take out, so anything smoother can only round the letters
  // off. Two ways past it were tried and measured before settling this:
  //   - A plain wider kernel (sigma 7): pen wobble 0.056 -> 0.045 on one
  //     stroke, but distance from the intended line 0.79 -> 1.15 and a
  //     zigzag's corners drifting 2.2 -> 3.5px. Rounder letters, not cleaner.
  //   - Twicing (2H - H^2, which undoes a Gaussian's shrinkage of real
  //     curves): looked like a win on one stroke and was not on twelve -- no
  //     setting inside Strong's shape budget beat it on wobble on both pen and
  //     touch (best: -3% pen, +3% touch). Removed rather than left in unused.
  // So the top of the slider buys uniformity instead of smoothness: even line
  // weight, end hooks trimmed, and a longer reach for the digit tidy
  // (tidyReach below). None of those changes the shape of a letter.
  const LIFT_ANCHORS = [
    { level: 1,   sigma: 1.6, bound: 1.8, touchSigma: 1.9, touchBound: 1.6, even: 0,   hook: 0 },
    { level: 40,  sigma: 3.2, bound: 3.5, touchSigma: 1.9, touchBound: 1.6, even: 0,   hook: 0 },
    { level: 70,  sigma: 4.8, bound: 5.0, touchSigma: 1.6, touchBound: 1.6, even: 0,   hook: 0 },
    { level: 100, sigma: 4.8, bound: 5.0, touchSigma: 1.6, touchBound: 1.6, even: 0.8, hook: 4 }
  ];

  // The live filter's cutoffs (Hz), for events.js. Light below Natural,
  // exactly Natural and Strong at their anchors, and only a touch firmer at
  // the top: everything past Strong is done on lift, where it is free.
  const LIVE_ANCHORS = [
    { level: 1,   base: 18,  gain: 24, ceiling: 36 },
    { level: 40,  base: 11,  gain: 18, ceiling: 28 },
    { level: 70,  base: 9.5, gain: 16, ceiling: 22 },
    { level: 100, base: 8.5, gain: 15, ceiling: 20 }
  ];

  function liftParams(value) {
    const level = assistLevel(value);
    return level === 0 ? null : alongAnchors(LIFT_ANCHORS, level);
  }

  function liveFilter(value) {
    const level = assistLevel(value);
    if (level === 0) return null;
    const { base, gain, ceiling } = alongAnchors(LIVE_ANCHORS, level);
    return { base, gain, ceiling };
  }

  // How much further than usual the recogniser's tidy may move a stroke
  // (handwriting.js maxShiftFor). 1 up to Strong, so that layer is unchanged
  // across the old range; 1.6 at the top, so a written 1 or 0 can be tidied
  // as far as "as clean as possible" asks.
  function tidyReach(value) {
    const level = assistLevel(value);
    return level <= 70 ? 1 : 1 + ((level - 70) / 30) * 0.6;
  }
  // Gaussian weight is 1.1% at three kernel widths. Cutting it at 2.5 saved
  // little time and measurably less smoothing (pen wobble 0.075 -> 0.081).
  const KERNEL_REACH = 3;

  // exp(-t) for t in [0, EXP_MAX], linearly interpolated. The kernel window is
  // bounded at KERNEL_REACH widths, so t = d^2/(2w^2) never exceeds
  // KERNEL_REACH^2/2 = 4.5. At this resolution the interpolation error is
  // about 1e-7 relative -- several orders below the movement bound every point
  // is clamped into afterwards, and far below a pixel.
  const EXP_MAX = KERNEL_REACH * KERNEL_REACH / 2;
  const EXP_STEPS = 2048;
  const EXP_SCALE = EXP_STEPS / EXP_MAX;
  const EXP_TABLE = new Float64Array(EXP_STEPS + 2);
  for (let i = 0; i < EXP_TABLE.length; i++) {
    EXP_TABLE[i] = Math.exp(-i / EXP_SCALE);
  }

  function negExp(t) {
    if (!(t < EXP_MAX)) return Math.exp(-t);
    const scaled = t * EXP_SCALE;
    const index = scaled | 0;
    const frac = scaled - index;
    const a = EXP_TABLE[index];
    return a + (EXP_TABLE[index + 1] - a) * frac;
  }

  function arcLengths(points) {
    const s = new Float64Array(points.length);
    for (let i = 1; i < points.length; i++) {
      s[i] = s[i - 1] + Math.hypot(points[i].x - points[i - 1].x, points[i].y - points[i - 1].y);
    }
    return s;
  }

  function medianStep(s) {
    const steps = [];
    for (let i = 1; i < s.length; i++) steps.push(s[i] - s[i - 1]);
    steps.sort((a, b) => a - b);
    return steps.length ? steps[Math.floor(steps.length / 2)] : 0;
  }

  // One Gaussian pass over `points`, parameterised by arc length `s`, with a
  // per-sample kernel width. Returns plain {x, y, pressure} records; without
  // `withPressure` each keeps its own pressure, which is all the de-jittered
  // copy needs.
  // The inner loop used to read points[j].x / .y / .pressure straight off an
  // array of plain objects, once per kernel tap -- roughly 25k megamorphic
  // property loads for a 500-point stroke, which is what pushed a lift over
  // the 2 ms budget (test_lift_smoothing_is_cheap). Hoisting the three
  // channels into Float64Arrays first is arithmetically identical, so no
  // smoothed point moves by even a float, and the shape and digit recognisers
  // downstream see exactly what they saw before.
  function gaussianPass(points, s, widthAt, withPressure) {
    const count = points.length;
    const weightOf = new Float64Array(count);
    for (let i = 0; i < count; i++) {
      const left = i > 0 ? s[i] - s[i - 1] : 0;
      const right = i < count - 1 ? s[i + 1] - s[i] : 0;
      weightOf[i] = Math.max(1e-6, (left + right) / 2);
    }

    const px = new Float64Array(count);
    const py = new Float64Array(count);
    const pp = withPressure ? new Float64Array(count) : null;
    for (let i = 0; i < count; i++) {
      const point = points[i];
      px[i] = point.x;
      py[i] = point.y;
      if (withPressure) {
        pp[i] = typeof point.pressure === "number" ? point.pressure : 0.55;
      }
    }

    const out = new Array(count);
    let lo = 0;
    let hi = 0;
    for (let i = 0; i < count; i++) {
      const width = Math.max(1e-6, widthAt(i));
      const reach = KERNEL_REACH * width;
      const centre = s[i];
      while (lo < i && s[lo] < centre - reach) lo++;
      while (lo > 0 && s[lo - 1] >= centre - reach) lo--;
      if (hi < i) hi = i;
      while (hi < count - 1 && s[hi + 1] <= centre + reach) hi++;
      while (hi > i && s[hi] > centre + reach) hi--;

      const twoWidthSquared = 2 * width * width;
      let sumW = 0;
      let x = 0;
      let y = 0;
      let pressure = 0;
      for (let j = lo; j <= hi; j++) {
        const d = s[j] - centre;
        const w = negExp((d * d) / twoWidthSquared) * weightOf[j];
        sumW += w;
        x += px[j] * w;
        y += py[j] * w;
        if (withPressure) pressure += pp[j] * w;
      }
      out[i] = {
        x: x / sumW,
        y: y / sumW,
        pressure: withPressure ? pressure / sumW : points[i].pressure
      };
    }
    return out;
  }

  // Unit direction of travel over [from, to] in arc length, from the chord of
  // the samples at either end of that span.
  function chordDirection(points, s, from, to, hint) {
    let a = hint;
    while (a > 0 && s[a] > from) a--;
    while (a < points.length - 1 && s[a] < from) a++;
    let b = a;
    while (b < points.length - 1 && s[b] < to) b++;
    const dx = points[b].x - points[a].x;
    const dy = points[b].y - points[a].y;
    const length = Math.hypot(dx, dy);
    return length > 1e-9 ? { x: dx / length, y: dy / length } : null;
  }

  // 0 on a smooth run, rising to 1 at a sharp corner, spread a little so the
  // kernel narrows before it reaches the turn rather than exactly on it.
  function cornerness(points, s, reach) {
    const count = points.length;
    const total = s[count - 1];
    const raw = new Float64Array(count);
    for (let i = 1; i < count - 1; i++) {
      if (s[i] < reach * 0.5 || total - s[i] < reach * 0.5) continue;
      const before = chordDirection(points, s, s[i] - reach, s[i], i);
      const after = chordDirection(points, s, s[i], s[i] + reach, i);
      if (!before || !after) continue;
      const angle = Math.acos(Math.max(-1, Math.min(1, before.x * after.x + before.y * after.y)));
      if (angle > CORNER_ANGLE) raw[i] = Math.min(1, (angle - CORNER_ANGLE) / (CORNER_FULL - CORNER_ANGLE));
    }
    const spread = new Float64Array(count);
    for (let i = 0; i < count; i++) {
      if (!raw[i]) continue;
      for (let j = i; j >= 0 && s[i] - s[j] <= reach * 0.5; j--) spread[j] = Math.max(spread[j], raw[i]);
      for (let j = i; j < count && s[j] - s[i] <= reach * 0.5; j++) spread[j] = Math.max(spread[j], raw[i]);
    }
    return spread;
  }

  function nearestOnPolyline(point, polyline, hint, window) {
    let best = Infinity;
    let bestPoint = polyline[hint];
    const from = Math.max(1, hint - window);
    const to = Math.min(polyline.length - 1, hint + window);
    for (let i = from; i <= to; i++) {
      const a = polyline[i - 1];
      const b = polyline[i];
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const lengthSquared = dx * dx + dy * dy;
      let t = 0;
      if (lengthSquared > 0) t = Math.max(0, Math.min(1, ((point.x - a.x) * dx + (point.y - a.y) * dy) / lengthSquared));
      const x = a.x + dx * t;
      const y = a.y + dy * t;
      const d = Math.hypot(point.x - x, point.y - y);
      if (d < best) {
        best = d;
        bestPoint = { x, y };
      }
    }
    return { distance: best, point: bestPoint };
  }

  /**
   * Smooth a finished stroke.
   *
   * @param rawPoints samples as the pen reported them: {x, y, pressure, time}
   * @param strength  "natural" | "strong"; anything else returns a copy
   * @param scale     current zoom, so the kernel is the same size on screen
   * @param inputType pointer type of the stroke ("pen", "touch", "mouse")
   */
  function smoothStroke(rawPoints, strength, scale, inputType) {
    const preset = liftParams(strength);
    let points = (rawPoints || []).filter((p) => p && Number.isFinite(p.x) && Number.isFinite(p.y));
    if (!preset || points.length < 3) return points.map((p) => ({ ...p }));
    if (preset.hook > 0) {
      points = trimHooks(points, preset.hook / Math.max(0.05, Number(scale) || 1));
    }

    // Same products as the old table (preset x per-input widening) so the
    // anchors reproduce Natural and Strong bit for bit.
    const noise = inputType === "touch"
      ? { sigma: preset.touchSigma, bound: preset.touchBound }
      : NO_EXTRA_NOISE;
    const zoom = Math.max(0.05, Number(scale) || 1);
    const rawS = arcLengths(points);
    const step = medianStep(rawS);
    const sigma = Math.max((preset.sigma * noise.sigma) / zoom, SPACING_FLOOR * step);
    const rawTotal = rawS[rawS.length - 1];
    if (!(rawTotal > sigma)) return points.map((p) => ({ ...p }));

    // 1. A de-jittered copy: what the hand meant, near enough to measure
    //    length along and to find corners on.
    const detect = gaussianPass(points, rawS, (i) =>
      DETECT_WIDTH * sigma * Math.min(1, Math.min(rawS[i], rawTotal - rawS[i]) / (2 * sigma) + 0.15), false);
    detect[0] = { ...detect[0], x: points[0].x, y: points[0].y };
    detect[detect.length - 1] = { ...detect[detect.length - 1], x: points.at(-1).x, y: points.at(-1).y };
    const s = arcLengths(detect);
    const total = s[s.length - 1];
    const corner = cornerness(detect, s, CORNER_REACH * sigma);

    // 2. The real pass over the raw samples, narrow at corners, tapering into
    //    both ends.
    const smoothed = gaussianPass(points, s, (i) =>
      sigma * (1 - 0.85 * corner[i]) * Math.min(1, Math.min(s[i], total - s[i]) / (2 * sigma)), true);

    const count = points.length;
    const out = smoothed.map((p, i) => ({ ...points[i], x: p.x, y: p.y, pressure: p.pressure }));
    out[0] = { ...out[0], x: points[0].x, y: points[0].y };
    out[count - 1] = { ...out[count - 1], x: points[count - 1].x, y: points[count - 1].y };

    // 3. Hold every point inside a band around what was drawn.
    const bound = (preset.bound * noise.bound) / zoom;
    const window = Math.max(4, Math.ceil((4 * sigma) / Math.max(1e-6, step)));
    for (let i = 1; i < count - 1; i++) {
      const near = nearestOnPolyline(out[i], points, i, window);
      if (near.distance > bound) {
        const ratio = bound / near.distance;
        out[i].x = near.point.x + (out[i].x - near.point.x) * ratio;
        out[i].y = near.point.y + (out[i].y - near.point.y) * ratio;
      }
    }

    // 4. Even the line weight, at the top of the range only. A stylus reports
    //    pressure that swings with grip and speed, and the pressure-sensitive
    //    nibs turn that into thick and thin within one letter. Pulled toward
    //    the stroke's own median, not a fixed value, so a heavy writer stays
    //    heavy and a light one light -- only the wobble in it goes.
    if (preset.even > 0) evenPressure(out, preset.even);
    return out;
  }

  // End hooks: the tick a stylus leaves as it touches down or lifts -- a few
  // pixels that double back on the stroke. One of the commonest marks of
  // untidy handwriting, and not part of any letter, so it can go without
  // changing a letter's shape.
  //
  // A hook has to be all of: within `maxLength` of the end (a few px on
  // screen), at most 12% of the whole stroke, and a genuine reversal -- the
  // tail turns more than 140 degrees against the stroke's direction just
  // beyond it. The sharp corner of a v or a 4 is far from the ends, and a
  // curve that simply starts somewhere does not reverse, so neither is taken.
  // 140, not less: the flag on a handwritten 1 turns about 135 degrees into
  // the downstroke and is part of the letter. A touch-down hook folds back
  // harder than that, and is shorter.
  const HOOK_TURN = (140 * Math.PI) / 180;

  function trimHooks(points, maxLength) {
    if (points.length < 8 || !(maxLength > 0)) return points;
    const s = arcLengths(points);
    const total = s[s.length - 1];
    const reach = Math.min(maxLength, total * 0.12);
    if (!(reach > 0.5)) return points;

    const direction = (a, b) => Math.atan2(b.y - a.y, b.x - a.x);
    const turn = (a, b) => {
      let d = Math.abs(a - b) % (2 * Math.PI);
      return d > Math.PI ? 2 * Math.PI - d : d;
    };

    // The index where the stroke proper begins, scanning in from one end.
    // `at(i)` walks from that end; `dist(i)` is arc length from it.
    const findCut = (at, dist, count) => {
      let best = 0;
      let bestTurn = HOOK_TURN;
      for (let k = 1; k < count - 1 && dist(k) <= reach; k++) {
        // Direction of the stroke just past k, over twice the reach.
        let m = k + 1;
        while (m < count - 1 && dist(m) - dist(k) < reach * 2) m++;
        if (dist(m) - dist(k) < reach * 0.8) break;
        const tail = direction(at(k), at(0));
        const body = direction(at(k), at(m));
        const bend = Math.PI - turn(tail, body);
        // Taken only where the tail folds back against the body, and at the
        // sharpest such fold within reach.
        if (bend > bestTurn) {
          bestTurn = bend;
          best = k;
        }
      }
      return best;
    };

    const n = points.length;
    const head = findCut((i) => points[i], (i) => s[i], n);
    const tail = findCut((i) => points[n - 1 - i], (i) => total - s[n - 1 - i], n);
    if (!head && !tail) return points;
    const trimmed = points.slice(head, n - tail);
    return trimmed.length >= 3 ? trimmed : points;
  }

  function evenPressure(points, amount) {
    const pressures = [];
    for (const point of points) {
      if (typeof point.pressure === "number" && Number.isFinite(point.pressure)) pressures.push(point.pressure);
    }
    // Mouse input reports a flat 0.5 or nothing; there is nothing to even.
    if (pressures.length < 3) return;
    pressures.sort((a, b) => a - b);
    const median = pressures[Math.floor(pressures.length / 2)];
    for (const point of points) {
      if (typeof point.pressure === "number" && Number.isFinite(point.pressure)) {
        point.pressure += (median - point.pressure) * amount;
      }
    }
  }

  window.Inkyscib = window.Inkyscib || {};
  window.Inkyscib.InkSmooth = {
    smoothStroke,
    STRENGTHS,
    assistLevel,
    liveFilter,
    tidyReach,
    liftParams,
    LEVEL_OF
  };
})();
