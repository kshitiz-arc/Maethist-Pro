'use strict';

// The polynomial predictor extrapolates the last four committed samples one
// frame ahead. Its failure mode is overshoot - ink running past where the pen
// stopped or turned - so most of these tests are about the guards against it.

const assert = require('node:assert/strict');
const test = require('node:test');
const { loadInkLab } = require('./load.cjs');

const { Predictor, RingBuffer } = loadInkLab(
  'static/js/inklab/ring-buffer.js',
  'static/js/inklab/predictor.js'
);
const { PREDICTED } = RingBuffer.Flags;

function samplesAt(times, position, pressure = 0.5) {
  return times.map((time) => {
    const [x, y] = position(time);
    return { x, y, pressure, time, flags: RingBuffer.Flags.MOVE };
  });
}

function near(actual, expected, label, tolerance = 1e-9) {
  assert.ok(Math.abs(actual - expected) <= tolerance, `${label}: ${actual} vs ${expected}`);
}

test('constant velocity lands exactly on the line', () => {
  // Irregular intervals on purpose; the estimate must not depend on them.
  const samples = samplesAt([0, 7, 16, 24], (t) => [0.5 * t, 0.25 * t]);
  const out = Predictor.predict(samples, 16);
  assert.equal(out.length, 2);
  assert.equal(out[0].x, 16);
  assert.equal(out[0].y, 8);
  assert.equal(out[1].x, 20);
  assert.equal(out[1].y, 10);
});

test('constant acceleration matches the damped formula, with irregular intervals', () => {
  const ax = 0.01;
  const ay = 0.004;
  const position = (t) => [2 + 0.3 * t + 0.5 * ax * t * t, 5 - 0.1 * t + 0.5 * ay * t * t];
  const times = [0, 6, 15, 21];
  const samples = samplesAt(times, position);
  const out = Predictor.predict(samples, 16);

  // Computed independently: the true velocity at the last sample, and half the
  // true acceleration.
  const t3 = 21;
  const [x3, y3] = position(t3);
  const vx = 0.3 + ax * t3;
  const vy = -0.1 + ay * t3;
  const expected = [8, 16].map((tau) => [
    x3 + vx * tau + 0.5 * (0.5 * ax) * tau * tau,
    y3 + vy * tau + 0.5 * (0.5 * ay) * tau * tau,
  ]);

  assert.equal(out.length, 2);
  out.forEach((point, i) => {
    near(point.x, expected[i][0], `point ${i} x`);
    near(point.y, expected[i][1], `point ${i} y`);
  });
});

test('a stationary pen is not predicted', () => {
  const samples = samplesAt([0, 8, 16, 24], () => [40, 40]);
  assert.deepEqual(Predictor.predict(samples, 16), []);
});

test('a pen that will reverse within the horizon is not predicted', () => {
  // x = 1.4t - 0.025t^2: still moving right at t = 24 (v = 0.2), but hard
  // enough on the brakes that the damped extrapolation turns back within 16 ms.
  const samples = samplesAt([0, 8, 16, 24], (t) => [1.4 * t - 0.025 * t * t, 50]);
  assert.deepEqual(Predictor.predict(samples, 16), []);
});

test('a tight curve is clamped to one and a half times the distance at current speed', () => {
  // Moving right at 0.5 px/ms, pulled hard downwards: unclamped, the prediction
  // at the horizon would travel 20.8 px; the clamp allows 1.5 * 0.5 * 16 = 12.
  const samples = samplesAt([0, 8, 16, 24], (t) => [0.5 * t, 0.5 * 0.3 * (t - 24) * (t - 24)]);
  const out = Predictor.predict(samples, 16);
  const last = samples[3];
  assert.equal(out.length, 2);

  const dx = out[1].x - last.x;
  const dy = out[1].y - last.y;
  near(Math.hypot(dx, dy), 12, 'clamped displacement', 1e-6);
  // The clamp shortens the step; it must not turn it.
  near(dy / dx, 19.2 / 8, 'direction kept', 1e-6);

  // Halfway, the unclamped displacement (6.25 px) is inside the limit.
  near(Math.hypot(out[0].x - last.x, out[0].y - last.y), Math.hypot(4, 4.8), 'unclamped half-step', 1e-6);
});

test('a zero or negative interval is not predicted', () => {
  const zero = samplesAt([0, 8, 8, 16], (t) => [t, t]);
  const negative = samplesAt([0, 8, 4, 12], (t) => [t, t]);
  assert.deepEqual(Predictor.predict(zero, 16), []);
  assert.deepEqual(Predictor.predict(negative, 16), []);
});

test('fewer than four samples are not predicted', () => {
  const samples = samplesAt([0, 8, 16], (t) => [t, t]);
  assert.deepEqual(Predictor.predict(samples, 16), []);
});

test('the horizon is capped at 25 ms', () => {
  const samples = samplesAt([0, 8, 16, 24], (t) => [0.5 * t, 0]);
  const out = Predictor.predict(samples, 100);
  assert.equal(Predictor.MAX_HORIZON_MS, 25);
  assert.equal(out[1].time, 24 + 25);
  assert.equal(out[1].x, 12 + 0.5 * 25);
});

test('predictions carry the PREDICTED flag, the latest pressure and their own times', () => {
  const samples = samplesAt([0, 8, 16, 24], (t) => [t, 0], 0.5);
  samples[3].pressure = 0.72;
  const out = Predictor.predict(samples, 16);
  assert.deepEqual(
    out.map(({ pressure, time, flags }) => ({ pressure, time, flags })),
    [
      { pressure: 0.72, time: 32, flags: PREDICTED },
      { pressure: 0.72, time: 40, flags: PREDICTED },
    ]
  );
});

test('only the last four samples are used', () => {
  // A long wobbly history followed by four samples on a straight line must give
  // the straight-line answer.
  const history = samplesAt([0, 5, 11, 18, 26], (t) => [t * 3, Math.sin(t) * 40]);
  const tail = samplesAt([100, 108, 116, 124], (t) => [t, 2 * t]);
  const out = Predictor.predict(history.concat(tail), 16);
  assert.equal(out[1].x, 124 + 16);
  assert.equal(out[1].y, 248 + 32);
});
