// InkLab's stroke predictor. When the browser has no predicted events of its
// own, the worker draws the stroke a frame ahead of the pen using these.
//
// Prediction's characteristic failure is overshoot: ink that runs past where
// the pen stopped or turned, then snaps back. So the extrapolation is
// deliberately cautious - damped acceleration, no prediction at all when the
// pen is nearly still or about to reverse, and a hard cap on how far a
// prediction may travel. Design: spec section 11.2.
(function (root) {
  'use strict';

  const MAX_HORIZON_MS = 25;
  // px per ms. Below this the pen is treated as still.
  const STATIONARY_SPEED = 0.02;
  const ACCELERATION_DAMPING = 0.5;
  // A prediction may travel at most this many times the distance the pen would
  // cover at its current speed over the horizon.
  const DISPLACEMENT_LIMIT = 1.5;

  function predictedFlag() {
    return root.InkLab.RingBuffer.Flags.PREDICTED;
  }

  // Extrapolates the last four committed samples `horizonMs` ahead, returning
  // two predicted samples at half the horizon and at the horizon, or [] when
  // prediction would be a guess.
  function predict(committed, horizonMs = 16) {
    if (!committed || committed.length < 4) return [];
    const n = committed.length;
    const s0 = committed[n - 4];
    const s1 = committed[n - 3];
    const s2 = committed[n - 2];
    const s3 = committed[n - 1];

    const dt01 = s1.time - s0.time;
    const dt12 = s2.time - s1.time;
    const dt23 = s3.time - s2.time;
    // Written as !(dt > 0) so a NaN interval is rejected too.
    if (!(dt01 > 0) || !(dt12 > 0) || !(dt23 > 0)) return [];

    // Average velocity over each interval. When acceleration is constant that
    // equals the instantaneous velocity at the interval's midpoint, which is
    // what makes the estimates below exact for such motion at any spacing.
    const vax = (s1.x - s0.x) / dt01;
    const vay = (s1.y - s0.y) / dt01;
    const vbx = (s2.x - s1.x) / dt12;
    const vby = (s2.y - s1.y) / dt12;
    const vcx = (s3.x - s2.x) / dt23;
    const vcy = (s3.y - s2.y) / dt23;

    // Two acceleration estimates, averaged to damp sampling jitter.
    const span1 = (s2.time - s0.time) / 2;
    const span2 = (s3.time - s1.time) / 2;
    const ax = ((vbx - vax) / span1 + (vcx - vbx) / span2) / 2;
    const ay = ((vby - vay) / span1 + (vcy - vby) / span2) / 2;

    // Carry the last midpoint velocity forward to the newest sample.
    const vx = vcx + (ax * dt23) / 2;
    const vy = vcy + (ay * dt23) / 2;
    const speed = Math.hypot(vx, vy);
    if (speed < STATIONARY_SPEED) return [];

    const horizon = Math.min(horizonMs, MAX_HORIZON_MS);
    const dampedX = ACCELERATION_DAMPING * ax;
    const dampedY = ACCELERATION_DAMPING * ay;

    // If the damped velocity at the horizon points back against the current
    // one, the pen is turning around inside the frame: predicting either way
    // would show as overshoot.
    if (vx * (vx + dampedX * horizon) + vy * (vy + dampedY * horizon) <= 0) return [];

    const limit = DISPLACEMENT_LIMIT * speed * horizon;
    const PREDICTED = predictedFlag();
    return [horizon / 2, horizon].map((tau) => {
      let dx = vx * tau + 0.5 * dampedX * tau * tau;
      let dy = vy * tau + 0.5 * dampedY * tau * tau;
      const distance = Math.hypot(dx, dy);
      if (distance > limit) {
        // Shorten the step; never turn it.
        dx *= limit / distance;
        dy *= limit / distance;
      }
      return { x: s3.x + dx, y: s3.y + dy, pressure: s3.pressure, time: s3.time + tau, flags: PREDICTED };
    });
  }

  function isPoint(value) {
    return value !== null && typeof value === 'object' && Number.isFinite(value.x) && Number.isFinite(value.y);
  }

  // The WebNN hook. No trained model ships; this is where one would plug in.
  // `model(context, history)` resolves to an array of {x, y}. Anything wrong -
  // no API, no model, a throw, a rejection, output that is not points - gives
  // null, and the worker uses the polynomial predictor for that frame instead.
  function createNeural({ ml, model } = {}) {
    if (!ml || typeof ml.createContext !== 'function' || typeof model !== 'function') return null;

    // Created once, on first use, and shared by every prediction after it.
    let context = null;

    return {
      async predict(history, horizonMs = 16) {
        if (!history || history.length === 0) return null;
        try {
          if (!context) context = ml.createContext();
          const points = await model(await context, history);
          if (!Array.isArray(points) || points.length === 0 || !points.every(isPoint)) return null;

          const last = history[history.length - 1];
          const horizon = Math.min(horizonMs, MAX_HORIZON_MS);
          const PREDICTED = predictedFlag();
          return points.map((point, i) => ({
            x: point.x,
            y: point.y,
            pressure: last.pressure,
            time: last.time + (horizon * (i + 1)) / points.length,
            flags: PREDICTED,
          }));
        } catch (error) {
          return null;
        }
      },
    };
  }

  root.InkLab = root.InkLab || {};
  root.InkLab.Predictor = Object.freeze({ MAX_HORIZON_MS, predict, createNeural });
})(self);
