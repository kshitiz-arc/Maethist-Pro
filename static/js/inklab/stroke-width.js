// InkLab's brush width: a literal port of the brush branch of __penSegmentWidth
// in static/js/canvas.js, so a stroke drawn here has the same weight as the same
// stroke drawn in the editor.
//
// It has to be a copy - the render worker cannot load canvas.js, which touches
// the DOM as soon as it runs - and copies of this formula have drifted apart
// before (TODOS.md item 5). tests/inklab/stroke_width_parity.test.cjs runs the
// editor's own functions, pulled out of canvas.js, and requires this one to
// agree to the last bit. Keep the arithmetic in the same order as the original,
// or equal-looking code will round differently.
(function (root) {
  'use strict';

  const BASE_SIZE = 4;

  function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
  }

  function pointPressure(points, index) {
    const raw = points[index]?.pressure;
    return typeof raw === 'number' ? clamp(raw, 0.05, 1) : 0.55;
  }

  function segmentSpeed(points, index) {
    const a = points[index - 1];
    const b = points[index];
    if (!a || !b) return 0;

    const distance = Math.hypot(b.x - a.x, b.y - a.y);
    // A zero or NaN interval becomes 16 ms before the floor of 8; a negative
    // one falls to the floor.
    const dt = Math.max(8, (b.time || 0) - (a.time || 0) || 16);
    return distance / dt;
  }

  // Taper depends on how many samples follow `index`, so a point's width keeps
  // changing while samples are still being appended after it.
  function brushWidth(points, index, baseSize) {
    const pressure = pointPressure(points, index);
    const speed = segmentSpeed(points, index);
    const remaining = Math.max(0, points.length - 1 - index);

    const speedWeight = clamp(1.58 - speed * 0.88, 0.42, 1.5);
    const pressureWeight = 0.42 + pressure * 1.95;
    const taper = Math.min(1, 0.18 + index / 3.5, 0.16 + remaining / 5);
    return Math.max(0.55, baseSize * pressureWeight * speedWeight * taper);
  }

  root.InkLab = root.InkLab || {};
  root.InkLab.StrokeWidth = Object.freeze({ BASE_SIZE, brushWidth });
})(self);
