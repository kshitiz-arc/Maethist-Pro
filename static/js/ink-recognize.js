// What a freehand stroke was meant to be.
//
// Two different questions live here, and they want two different tools.
//
// A *shape* is parametric: a circle has a centre and a radius, a triangle has
// three vertices. Fitting that geometry directly — least squares for the
// circle, corner detection plus per-edge line fits for the polygons — is
// robust to size and rotation, and it hands back the numbers geometry.js needs
// to build a real object. Template matching would answer "circle?" but not
// "which circle", and would need a template per aspect ratio.
//
// A *digit* is not parametric. A 5 is a 5 because of how it looks, its
// proportions included — a squashed 5 is still a 5, but a squashed circle is
// an ellipse. So digits go through $P (Vatavu, Anthony & Wobbrock 2012), a
// point-cloud matcher: strokes become an unordered cloud, normalised for
// position and scale but NOT rotation, which is what keeps 6 and 9 apart.
//
// Nothing here touches the DOM or app state, so all of it is testable on its
// own. handwriting.js decides what to do with the answers.
(function () {
  "use strict";

  // ---------- tunables ----------
  //
  // Every threshold that decides "close enough" is named here rather than
  // buried at its use site, because they are the whole behaviour of the
  // feature and they get calibrated against real strokes.

  const SHAPE = {
    // Samples a stroke is resampled to before fitting. Enough to describe a
    // rounded corner, few enough that the O(n) passes stay trivial.
    SAMPLES: 64,
    // How close the ends must come, relative to the stroke's own size, for it
    // to count as a closed outline.
    CLOSURE: 0.28,
    // Mean radial error of the circle fit, relative to the radius.
    CIRCLE_RESIDUAL: 0.13,
    // Turn angle that makes a sample a corner candidate, in radians (~37°).
    // Measured: below this, wobble on a circle starts reading as corners and
    // circle recall collapses; above it, the obtuse corners of a rhombus turn
    // too little to be seen at all and the whole shape is rejected.
    CORNER_ANGLE: 0.65,
    // Corner candidates nearer than this share of the outline are one corner.
    CORNER_SPACING: 0.12,
    // Max deviation of an edge from its chord, relative to the chord, for the
    // edge to read as a straight line.
    EDGE_STRAIGHTNESS: 0.14,
    // Two sides within this share of the longest side count as equal. It has
    // to be tight: a kite's two pairs differ by ~16%, so a loose figure
    // swallows every kite into the rhombus case.
    SIDE_TOLERANCE: 0.14,
    RIGHT_ANGLE: 0.28,
    // Mean radial error of the ellipse fit, relative to each axis. Tighter
    // than the circle's: an ellipse has two more degrees of freedom, so a
    // rounded box fits one better than it fits a circle.
    ELLIPSE_RESIDUAL: 0.1,
    // The most corners an outline may have and still be read as a polygon.
    // Six: a hexagon's corners are 64/6 samples apart, comfortably wider than
    // CORNER_SPACING; an octagon's are not.
    MAX_CORNERS: 6,
    // An open stroke is a straight line when no sample strays further than
    // this share of its length from the fitted line.
    LINE_STRAIGHTNESS: 0.035
  };

  // How far each assist level will move a drawing toward a named figure.
  //
  // "straight" is about intent: a square drawn with its sides leaning 18° is
  // still a square to the person who drew it, so the tolerances are wide and
  // the result is the ideal figure, turned square to the page when it is
  // nearly square to it. "exact" is about fidelity: a kind is only named when
  // the drawing already is one, so naming it moves nothing a person would
  // notice, and the orientation is never changed.
  //
  // Measured against the old single rule (right angles within 16°, read off
  // the corners): a square leaning 14° came out a rhombus 25% of the time and
  // one leaning 18° every time, and a square leaning 10° was rebuilt 239x198.
  const INTENT = {
    straight: {
      // Mean distance of the four corners from 90°. A deliberate rhombus is
      // usually 60/120 (30° off); a hand-drawn square rarely strays past 18.
      rightAngleMean: 22 * Math.PI / 180,
      squareRatio: 0.85,
      equalSides: 0.16,
      parallel: 11 * Math.PI / 180,
      triangleRight: 14 * Math.PI / 180,
      equilateral: 0.15,
      // 12% read a scalene triangle whose sides were 263/234/206 as
      // isosceles 98% of the time: two sides 11% apart is not an intention.
      isosceles: 0.09,
      regularSides: 0.25,
      regularAngle: 20 * Math.PI / 180,
      circleRatio: 0.78,
      // Turned square to the page when within this of it.
      snap: 15 * Math.PI / 180,
      // A square this close to 45° is a diamond and is kept one.
      diamondSnap: 10 * Math.PI / 180,
      lineSnap: 8 * Math.PI / 180
    },
    exact: {
      rightAngleMean: 4 * Math.PI / 180,
      squareRatio: 0.96,
      equalSides: 0.05,
      parallel: 4 * Math.PI / 180,
      triangleRight: 4 * Math.PI / 180,
      equilateral: 0.05,
      isosceles: 0.04,
      regularSides: 0.06,
      regularAngle: 6 * Math.PI / 180,
      circleRatio: 0.93,
      snap: 0,
      diamondSnap: 0,
      lineSnap: 0
    }
  };

  const DIGIT = {
    // $P's cloud size. 32 is the paper's own figure.
    SAMPLES: 32,
    // Below this $P score, we say we do not know rather than guess.
    MIN_SCORE: 0.62,
    // A match only counts if it beats the runner-up class by this much, so an
    // ambiguous 1-vs-7 is left alone instead of being coerced.
    MIN_MARGIN: 0.04
  };

  // ---------- small geometry ----------

  function distance(a, b) {
    return Math.hypot(b.x - a.x, b.y - a.y);
  }

  function pathLength(points) {
    let total = 0;
    for (let i = 1; i < points.length; i += 1) total += distance(points[i - 1], points[i]);
    return total;
  }

  function boundsOf(points) {
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const point of points) {
      if (point.x < minX) minX = point.x;
      if (point.y < minY) minY = point.y;
      if (point.x > maxX) maxX = point.x;
      if (point.y > maxY) maxY = point.y;
    }
    if (!Number.isFinite(minX)) return null;
    return { minX, minY, maxX, maxY, width: maxX - minX, height: maxY - minY };
  }

  function finitePoint(point) {
    return !!point && Number.isFinite(point.x) && Number.isFinite(point.y);
  }

  function usable(points) {
    return (points || []).filter(finitePoint);
  }

  /**
   * Uniform arc-length resampling.
   *
   * Raw pointer samples cluster where the hand slowed down, which biases every
   * fit below toward whatever the writer hesitated over. Spacing them evenly
   * makes each sample count the same.
   */
  function resample(points, count) {
    const source = usable(points);
    if (source.length < 2 || count < 2) return source.map((point) => ({ ...point }));

    const total = pathLength(source);
    if (!(total > 0)) return [{ ...source[0] }, { ...source[source.length - 1] }];

    const step = total / (count - 1);
    const output = [{ ...source[0] }];
    let carried = 0;

    for (let i = 1; i < source.length; i += 1) {
      const from = source[i - 1];
      const to = source[i];
      let segment = distance(from, to);
      if (!(segment > 0)) continue;

      // Walk this segment, emitting a sample every `step` of arc length. The
      // leftover distance carries into the next segment so spacing never
      // drifts across a long stroke.
      let position = 0;
      while (carried + (segment - position) >= step && output.length < count) {
        const advance = step - carried;
        position += advance;
        const ratio = position / segment;
        output.push({
          x: from.x + (to.x - from.x) * ratio,
          y: from.y + (to.y - from.y) * ratio,
          pressure: blendPressure(from, to, ratio)
        });
        carried = 0;
      }
      carried += segment - position;
    }

    // Floating-point drift can leave the last sample short; pin it to the end.
    while (output.length < count) output.push({ ...source[source.length - 1] });
    return output;
  }

  function blendPressure(from, to, ratio) {
    const a = Number.isFinite(from.pressure) ? from.pressure : 0.55;
    const b = Number.isFinite(to.pressure) ? to.pressure : 0.55;
    return a + (b - a) * ratio;
  }

  // ---------- circle ----------

  /**
   * Algebraic (Kåsa) circle fit.
   *
   * Minimises the error in x² + y² + Dx + Ey + F = 0, which is linear in
   * D, E, F and so solves in closed form — no iteration, no starting guess.
   * It biases slightly toward smaller circles on a partial arc, which does not
   * matter here because we only accept nearly-closed outlines anyway.
   */
  function fitCircle(points) {
    const source = usable(points);
    if (source.length < 3) return null;

    let sumX = 0;
    let sumY = 0;
    for (const point of source) {
      sumX += point.x;
      sumY += point.y;
    }
    // Centring first keeps the normal equations well conditioned when the
    // stroke sits far from the origin, which on a scrolled page it always does.
    const meanX = sumX / source.length;
    const meanY = sumY / source.length;

    let sxx = 0;
    let syy = 0;
    let sxy = 0;
    let sxz = 0;
    let syz = 0;
    for (const point of source) {
      const x = point.x - meanX;
      const y = point.y - meanY;
      const z = x * x + y * y;
      sxx += x * x;
      syy += y * y;
      sxy += x * y;
      sxz += x * z;
      syz += y * z;
    }

    const determinant = 2 * (sxx * syy - sxy * sxy);
    if (!Number.isFinite(determinant) || Math.abs(determinant) < 1e-9) return null;

    const centerX = (syy * sxz - sxy * syz) / determinant;
    const centerY = (sxx * syz - sxy * sxz) / determinant;
    const center = { x: centerX + meanX, y: centerY + meanY };

    let radius = 0;
    for (const point of source) radius += distance(point, center);
    radius /= source.length;
    if (!(radius > 0)) return null;

    let error = 0;
    for (const point of source) error += Math.abs(distance(point, center) - radius);
    error /= source.length;

    return { center, radius, residual: error / radius };
  }

  // ---------- corners ----------

  /**
   * Corner samples, as indices into `samples`.
   *
   * The turn is measured across a window rather than between neighbours: at
   * one-sample spacing, hand tremor swamps the real turn, and every stroke
   * looks like it is made entirely of corners.
   */
  function detectCorners(samples, closed) {
    const count = samples.length;
    if (count < 5) return [];

    const window = Math.max(2, Math.round(count * 0.06));
    const strengths = new Array(count).fill(0);

    for (let i = 0; i < count; i += 1) {
      const before = closed ? samples[(i - window + count) % count] : samples[Math.max(0, i - window)];
      const after = closed ? samples[(i + window) % count] : samples[Math.min(count - 1, i + window)];
      if (!closed && (i < window || i > count - 1 - window)) continue;

      const inX = samples[i].x - before.x;
      const inY = samples[i].y - before.y;
      const outX = after.x - samples[i].x;
      const outY = after.y - samples[i].y;
      if ((inX === 0 && inY === 0) || (outX === 0 && outY === 0)) continue;

      // Signed turn between the incoming and outgoing directions.
      const turn = Math.abs(Math.atan2(inX * outY - inY * outX, inX * outX + inY * outY));
      strengths[i] = turn;
    }

    // Keep only local maxima above the threshold, then thin any that ended up
    // closer together than a real corner pair could be.
    const spacing = Math.max(2, Math.round(count * SHAPE.CORNER_SPACING));
    const candidates = [];
    for (let i = 0; i < count; i += 1) {
      if (strengths[i] < SHAPE.CORNER_ANGLE) continue;
      let peak = true;
      for (let offset = -spacing; offset <= spacing && peak; offset += 1) {
        if (offset === 0) continue;
        const j = closed ? (i + offset + count) % count : i + offset;
        if (j < 0 || j >= count) continue;
        // `>` not `>=`, so a plateau of equal strengths keeps its first sample
        // instead of discarding every sample in the run.
        if (strengths[j] > strengths[i]) peak = false;
      }
      if (peak) candidates.push(i);
    }

    return thinCorners(candidates, strengths, spacing, count, closed);
  }

  function thinCorners(candidates, strengths, spacing, count, closed) {
    if (candidates.length < 2) return candidates;
    const kept = [];
    for (const index of candidates) {
      const clash = kept.findIndex((other) => {
        const raw = Math.abs(other - index);
        const gap = closed ? Math.min(raw, count - raw) : raw;
        return gap < spacing;
      });
      if (clash === -1) {
        kept.push(index);
      } else if (strengths[index] > strengths[kept[clash]]) {
        kept[clash] = index;
      }
    }
    return kept.sort((a, b) => a - b);
  }

  // ---------- edges ----------

  /** Total least squares line through a run of samples, as a unit normal. */
  function fitLine(points) {
    const source = usable(points);
    if (source.length < 2) return null;

    let meanX = 0;
    let meanY = 0;
    for (const point of source) {
      meanX += point.x;
      meanY += point.y;
    }
    meanX /= source.length;
    meanY /= source.length;

    let sxx = 0;
    let syy = 0;
    let sxy = 0;
    for (const point of source) {
      const x = point.x - meanX;
      const y = point.y - meanY;
      sxx += x * x;
      syy += y * y;
      sxy += x * y;
    }

    // Principal direction of the scatter; the normal is perpendicular to it.
    const angle = 0.5 * Math.atan2(2 * sxy, sxx - syy);
    const dirX = Math.cos(angle);
    const dirY = Math.sin(angle);
    const normal = { x: -dirY, y: dirX };
    return { normal, offset: normal.x * meanX + normal.y * meanY };
  }

  function intersectLines(first, second) {
    if (!first || !second) return null;
    const determinant = first.normal.x * second.normal.y - first.normal.y * second.normal.x;
    // Near-parallel edges have no usable corner; the caller keeps its samples.
    if (!Number.isFinite(determinant) || Math.abs(determinant) < 1e-6) return null;
    return {
      x: (first.offset * second.normal.y - second.offset * first.normal.y) / determinant,
      y: (second.offset * first.normal.x - first.offset * second.normal.x) / determinant
    };
  }

  /** How far an edge strays from the straight chord between its ends. */
  function edgeStraightness(samples) {
    if (samples.length < 3) return 0;
    const first = samples[0];
    const last = samples[samples.length - 1];
    const chord = distance(first, last);
    if (!(chord > 0)) return Infinity;

    let worst = 0;
    for (let i = 1; i < samples.length - 1; i += 1) {
      const point = samples[i];
      // Perpendicular distance from the chord.
      const area = Math.abs(
        (last.x - first.x) * (first.y - point.y) - (first.x - point.x) * (last.y - first.y)
      );
      worst = Math.max(worst, area / chord);
    }
    return worst / chord;
  }

  function sliceEdge(samples, from, to, closed) {
    const out = [];
    if (closed) {
      let i = from;
      for (;;) {
        out.push(samples[i]);
        if (i === to) break;
        i = (i + 1) % samples.length;
      }
    } else {
      for (let i = from; i <= to; i += 1) out.push(samples[i]);
    }
    return out;
  }

  // ---------- shape ----------

  /**
   * What parametric shape this stroke is, if any.
   *
   * Returns null rather than a low-confidence guess — leaving the ink alone is
   * always the safe answer, and the caller has no better information to
   * second-guess this with.
   */
  /**
   * Drop the samples nearest each corner before fitting the edge's line.
   *
   * Those samples are on the curved turn, not the straight run, and including
   * them bends every fitted line toward its neighbours.
   */
  function trimEnds(edge) {
    if (edge.length < 7) return edge;
    const trim = Math.max(1, Math.round(edge.length * 0.18));
    return edge.slice(trim, edge.length - trim);
  }

  /** A refined corner far outside the stroke means the fit went wrong. */
  function withinReach(point, bounds, scale) {
    return (
      point.x > bounds.minX - scale &&
      point.x < bounds.maxX + scale &&
      point.y > bounds.minY - scale &&
      point.y < bounds.maxY + scale
    );
  }

  /**
   * Which quadrilateral, by side lengths and corner angles.
   *
   * geometry.js draws rectangle, rhombus, parallelogram and kite as separate
   * kinds, so picking the wrong one produces a shape that resists being edited
   * into the one the writer drew.
   */
  function classifyQuad(vertices) {
    const sides = vertices.map((vertex, index) => distance(vertex, vertices[(index + 1) % 4]));
    const longest = Math.max(...sides);
    if (!(longest > 0)) return null;

    // Turn angle at each corner, so a square reads as four right angles.
    const angles = vertices.map((vertex, index) => {
      const previous = vertices[(index + 3) % 4];
      const next = vertices[(index + 1) % 4];
      const inX = vertex.x - previous.x;
      const inY = vertex.y - previous.y;
      const outX = next.x - vertex.x;
      const outY = next.y - vertex.y;
      return Math.abs(Math.atan2(inX * outY - inY * outX, inX * outX + inY * outY));
    });

    const equal = (a, b) => Math.abs(a - b) / longest <= SHAPE.SIDE_TOLERANCE;
    const rightAngled = angles.every(
      (angle) => Math.abs(angle - Math.PI / 2) <= SHAPE.RIGHT_ANGLE
    );
    const equilateral =
      (Math.max(...sides) - Math.min(...sides)) / longest <= SHAPE.SIDE_TOLERANCE;
    const oppositeEqual = equal(sides[0], sides[2]) && equal(sides[1], sides[3]);
    // A kite is two *adjacent* equal pairs, in either pairing.
    const adjacentEqual =
      (equal(sides[0], sides[1]) && equal(sides[2], sides[3])) ||
      (equal(sides[1], sides[2]) && equal(sides[3], sides[0]));

    // Order matters: every rhombus also satisfies the kite test, and a square
    // satisfies all of them. Most specific first.
    if (rightAngled) return "rectangle";
    if (equilateral) return "rhombus";
    if (oppositeEqual) return "parallelogram";
    if (adjacentEqual) return "kite";
    // An irregular quadrilateral is not one of the four geometry.js can draw,
    // so it stays as ink rather than being forced into the nearest one.
    return null;
  }

  // ---------- analysis: what was drawn ----------
  //
  // Split from interpretation on purpose. analyzeShape measures the stroke --
  // its corners, its straight edges, the ellipse through it -- and knows
  // nothing about assist levels. interpretShape decides what that measurement
  // should become at a given level. The two used to be one function, which is
  // why "is this a square?" had exactly one answer however much help was
  // wanted.

  /**
   * Principal-axis ellipse through a closed outline.
   *
   * The axes come from the second moments of the resampled outline, which
   * gets the orientation right for any hand; the radii are then read off the
   * extent along each axis, because moments of an arc-length-sampled outline
   * are not proportional to the radii. Residual is the mean error of the
   * normalised radius, so 0.1 means samples sit on average 10% off the curve.
   */
  function fitEllipse(samples) {
    const source = usable(samples);
    if (source.length < 8) return null;
    let cx = 0;
    let cy = 0;
    for (const point of source) {
      cx += point.x;
      cy += point.y;
    }
    cx /= source.length;
    cy /= source.length;

    let sxx = 0;
    let syy = 0;
    let sxy = 0;
    for (const point of source) {
      const x = point.x - cx;
      const y = point.y - cy;
      sxx += x * x;
      syy += y * y;
      sxy += x * y;
    }
    const rotation = 0.5 * Math.atan2(2 * sxy, sxx - syy);
    const ux = Math.cos(rotation);
    const uy = Math.sin(rotation);

    let minU = Infinity;
    let maxU = -Infinity;
    let minV = Infinity;
    let maxV = -Infinity;
    for (const point of source) {
      const x = point.x - cx;
      const y = point.y - cy;
      const u = x * ux + y * uy;
      const v = -x * uy + y * ux;
      minU = Math.min(minU, u);
      maxU = Math.max(maxU, u);
      minV = Math.min(minV, v);
      maxV = Math.max(maxV, v);
    }
    const rx = (maxU - minU) / 2;
    const ry = (maxV - minV) / 2;
    if (!(rx > 0) || !(ry > 0)) return null;
    // Centre on the extents, not the mean: a hand lingers where it slows
    // down, which pulls the mean of the samples toward that side.
    const offU = (maxU + minU) / 2;
    const offV = (maxV + minV) / 2;
    const center = { x: cx + offU * ux - offV * uy, y: cy + offU * uy + offV * ux };

    let error = 0;
    for (const point of source) {
      const x = point.x - center.x;
      const y = point.y - center.y;
      const u = (x * ux + y * uy) / rx;
      const v = (-x * uy + y * ux) / ry;
      error += Math.abs(Math.hypot(u, v) - 1);
    }
    return { center, rx, ry, rotation, residual: error / source.length };
  }

  /**
   * Measure a stroke: a closed polygon (its refined corners), a closed round
   * outline (the ellipse through it), an open straight line, or nothing.
   *
   * `options.lines` opts in to open strokes. The shape recogniser has always
   * been closed-only, and handwriting relies on that: a written 1 or l is an
   * open straight stroke, so lines are only looked for by a caller that has
   * already decided the stroke is too long to be a letter.
   */
  function analyzeShape(points, options = {}) {
    const source = usable(points);
    if (source.length < 8) return null;

    const bounds = boundsOf(source);
    if (!bounds) return null;
    const scale = Math.max(bounds.width, bounds.height);
    if (!(scale > 0)) return null;

    const gap = distance(source[0], source[source.length - 1]);
    const closed = gap / scale <= SHAPE.CLOSURE;

    if (!closed) {
      if (!options.lines) return null;
      return analyzeLine(source);
    }

    const samples = resample(source, SHAPE.SAMPLES);
    const corners = detectCorners(samples, true);

    const circle = fitCircle(samples);
    const ellipse = fitEllipse(samples);
    const round =
      corners.length < 3 &&
      ((circle && circle.residual <= SHAPE.CIRCLE_RESIDUAL) ||
        (ellipse && ellipse.residual <= SHAPE.ELLIPSE_RESIDUAL));
    if (round && ellipse) {
      return {
        type: "round",
        ellipse,
        circle,
        confidence: circle ? Math.max(0, 1 - circle.residual / SHAPE.CIRCLE_RESIDUAL) : 0.5
      };
    }

    if (corners.length < 3 || corners.length > SHAPE.MAX_CORNERS) return null;

    // Every edge between corners must actually be straight, or this is a
    // rounded blob that happens to have three bumps.
    const edges = [];
    for (let i = 0; i < corners.length; i += 1) {
      const from = corners[i];
      const to = corners[(i + 1) % corners.length];
      const edge = sliceEdge(samples, from, to, true);
      if (edge.length < 3) return null;
      if (edgeStraightness(edge) > SHAPE.EDGE_STRAIGHTNESS) return null;
      edges.push(edge);
    }

    // Refine each corner as the intersection of its two edges' fitted lines,
    // which is far steadier than trusting the one sample nearest the turn.
    const lines = edges.map((edge) => fitLine(trimEnds(edge)));
    const vertices = [];
    for (let i = 0; i < corners.length; i += 1) {
      const previous = lines[(i - 1 + lines.length) % lines.length];
      const current = lines[i];
      const refined = intersectLines(previous, current);
      const fallback = samples[corners[i]];
      const vertex = refined && withinReach(refined, bounds, scale) ? refined : fallback;
      vertices.push({ x: vertex.x, y: vertex.y });
    }

    // A figure drawn for a diagram never crosses itself. A closed zigzag or a
    // star does, and before up to six corners were accepted such a stroke was
    // turned away by the corner count alone; now it has to be turned away
    // for what it is. Concave outlines (an L-shaped hexagon) are still simple
    // and still pass.
    if (!isSimplePolygon(vertices)) return null;

    return { type: "polygon", vertices, confidence: 1 };
  }

  function segmentsCross(a, b, c, d) {
    const side = (p, q, r) => (q.x - p.x) * (r.y - p.y) - (q.y - p.y) * (r.x - p.x);
    const d1 = side(c, d, a);
    const d2 = side(c, d, b);
    const d3 = side(a, b, c);
    const d4 = side(a, b, d);
    return ((d1 > 0) !== (d2 > 0)) && ((d3 > 0) !== (d4 > 0)) &&
      d1 !== 0 && d2 !== 0 && d3 !== 0 && d4 !== 0;
  }

  /** No two non-adjacent edges cross. */
  function isSimplePolygon(vertices) {
    const n = vertices.length;
    if (n < 4) return true;
    for (let i = 0; i < n; i += 1) {
      const a = vertices[i];
      const b = vertices[(i + 1) % n];
      for (let j = i + 2; j < n; j += 1) {
        if (i === 0 && j === n - 1) continue; // they share vertex 0
        if (segmentsCross(a, b, vertices[j], vertices[(j + 1) % n])) return false;
      }
    }
    return true;
  }

  function analyzeLine(source) {
    const line = fitLine(source);
    if (!line) return null;
    const first = source[0];
    const last = source[source.length - 1];
    const length = distance(first, last);
    if (!(length > 0)) return null;
    // fitLine hands back the line's unit normal and offset; distance from it
    // is the straightness, as a share of the stroke's own length.
    const { normal, offset } = line;
    const off = (point) => point.x * normal.x + point.y * normal.y - offset;
    let worst = 0;
    for (const point of source) worst = Math.max(worst, Math.abs(off(point)));
    if (worst / length > SHAPE.LINE_STRAIGHTNESS) return null;
    // Endpoints are the ends of the stroke dropped onto the fitted line, so
    // the line starts and stops where the pen did.
    const project = (point) => {
      const d = off(point);
      return { x: point.x - d * normal.x, y: point.y - d * normal.y };
    };
    return { type: "line", a: project(first), b: project(last), length, confidence: 1 };
  }

  // ---------- interpretation: what it should become ----------

  const TAU = Math.PI * 2;

  function wrapAngle(angle) {
    let a = angle % TAU;
    if (a <= -Math.PI) a += TAU;
    if (a > Math.PI) a -= TAU;
    return a;
  }

  function centroid(vertices) {
    const n = vertices.length;
    return {
      x: vertices.reduce((sum, v) => sum + v.x, 0) / n,
      y: vertices.reduce((sum, v) => sum + v.y, 0) / n
    };
  }

  function rotatePoints(vertices, about, angle) {
    if (!angle) return vertices.map((v) => ({ x: v.x, y: v.y }));
    const c = Math.cos(angle);
    const s = Math.sin(angle);
    return vertices.map((v) => {
      const x = v.x - about.x;
      const y = v.y - about.y;
      return { x: about.x + x * c - y * s, y: about.y + x * s + y * c };
    });
  }

  function sidesOf(vertices) {
    return vertices.map((v, i) => distance(v, vertices[(i + 1) % vertices.length]));
  }

  /** Interior angle at every vertex, in radians. */
  function interiorAngles(vertices) {
    const n = vertices.length;
    return vertices.map((v, i) => {
      const p = vertices[(i - 1 + n) % n];
      const q = vertices[(i + 1) % n];
      const a = Math.atan2(p.y - v.y, p.x - v.x);
      const b = Math.atan2(q.y - v.y, q.x - v.x);
      return Math.abs(wrapAngle(a - b));
    });
  }

  function spread(values) {
    const top = Math.max(...values);
    return top > 0 ? (top - Math.min(...values)) / top : Infinity;
  }

  /** Direction of an edge, folded into [0, π) so an edge and its reverse agree. */
  function edgeDirection(a, b) {
    let angle = Math.atan2(b.y - a.y, b.x - a.x);
    if (angle < 0) angle += Math.PI;
    if (angle >= Math.PI) angle -= Math.PI;
    return angle;
  }

  function parallelGap(a, b) {
    const d = Math.abs(a - b) % Math.PI;
    return Math.min(d, Math.PI - d);
  }

  /**
   * The smallest turn, within `tolerance`, that lays one of `directions`
   * along a page axis. Zero when none is close enough, so a figure that is
   * deliberately tilted stays tilted.
   */
  function axisSnap(directions, tolerance) {
    if (!(tolerance > 0)) return 0;
    let best = null;
    for (const direction of directions) {
      const quarter = Math.PI / 2;
      const delta = Math.round(direction / quarter) * quarter - direction;
      if (Math.abs(delta) <= tolerance && (best === null || Math.abs(delta) < Math.abs(best))) {
        best = delta;
      }
    }
    return best || 0;
  }

  function snapFigure(vertices, directions, tolerance) {
    const turn = axisSnap(directions, tolerance);
    return turn ? rotatePoints(vertices, centroid(vertices), turn) : vertices;
  }

  /** Edge directions, plus the diagonals for a quadrilateral. */
  function figureDirections(vertices) {
    const n = vertices.length;
    const out = vertices.map((v, i) => edgeDirection(v, vertices[(i + 1) % n]));
    if (n === 4) {
      out.push(edgeDirection(vertices[0], vertices[2]), edgeDirection(vertices[1], vertices[3]));
    }
    return out;
  }

  /** Clockwise or counter-clockwise, as the sign of the signed area. */
  function winding(vertices) {
    let area = 0;
    for (let i = 0; i < vertices.length; i += 1) {
      const a = vertices[i];
      const b = vertices[(i + 1) % vertices.length];
      area += a.x * b.y - b.x * a.y;
    }
    return area >= 0 ? 1 : -1;
  }

  /**
   * Rotate `ideal` corner order so it starts at the corner nearest the first
   * one drawn and runs the same way round. Keeps A-B-C-D where the writer put
   * them, which is what makes the labels read as theirs.
   */
  function alignOrder(ideal, drawn) {
    let order = ideal;
    if (winding(order) !== winding(drawn)) order = order.slice().reverse();
    let start = 0;
    let best = Infinity;
    order.forEach((v, i) => {
      const d = distance(v, drawn[0]);
      if (d < best) {
        best = d;
        start = i;
      }
    });
    return order.slice(start).concat(order.slice(0, start));
  }

  // --- quadrilaterals ---

  /**
   * The rectangle a four-cornered outline was aiming at.
   *
   * Orientation is the mean of the edge directions taken modulo 90° -- every
   * edge of a rectangle is parallel or perpendicular to it -- via the
   * quadrupled-angle average, which is the only average of directions that
   * does not care which edge was called "first". Sizes are the edges
   * projected on those axes, so a lean adds nothing: a square drawn with its
   * sides leaning 18° is still 200 across. The old rebuild measured the
   * diagonal instead, which is how a leaning square came back 239x198.
   */
  function idealRectangle(vertices, tolerances) {
    let sin4 = 0;
    let cos4 = 0;
    const n = vertices.length;
    for (let i = 0; i < n; i += 1) {
      const a = vertices[i];
      const b = vertices[(i + 1) % n];
      const phi = Math.atan2(b.y - a.y, b.x - a.x);
      const weight = distance(a, b);
      sin4 += Math.sin(4 * phi) * weight;
      cos4 += Math.cos(4 * phi) * weight;
    }
    let theta = Math.atan2(sin4, cos4) / 4;

    const ux = Math.cos(theta);
    const uy = Math.sin(theta);
    let along = 0;
    let alongCount = 0;
    let across = 0;
    let acrossCount = 0;
    for (let i = 0; i < n; i += 1) {
      const a = vertices[i];
      const b = vertices[(i + 1) % n];
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const pu = Math.abs(dx * ux + dy * uy);
      const pv = Math.abs(-dx * uy + dy * ux);
      if (pu >= pv) {
        along += pu;
        alongCount += 1;
      } else {
        across += pv;
        acrossCount += 1;
      }
    }
    if (!alongCount || !acrossCount) return null;
    let width = along / alongCount;
    let height = across / acrossCount;
    const square = Math.min(width, height) / Math.max(width, height) >= tolerances.squareRatio;
    if (square) width = height = (width + height) / 2;

    // Square to the page when nearly so; a square nearly at 45° is a diamond
    // and is kept as one rather than being turned a whole 45°.
    if (tolerances.snap > 0) {
      if (Math.abs(theta) <= tolerances.snap) {
        theta = 0;
      } else if (square && Math.abs(Math.abs(theta) - Math.PI / 4) <= tolerances.diamondSnap) {
        theta = Math.sign(theta) * Math.PI / 4;
      }
    }

    const center = centroid(vertices);
    const cu = { x: Math.cos(theta) * width / 2, y: Math.sin(theta) * width / 2 };
    const cv = { x: -Math.sin(theta) * height / 2, y: Math.cos(theta) * height / 2 };
    const ideal = [
      { x: center.x - cu.x - cv.x, y: center.y - cu.y - cv.y },
      { x: center.x + cu.x - cv.x, y: center.y + cu.y - cv.y },
      { x: center.x + cu.x + cv.x, y: center.y + cu.y + cv.y },
      { x: center.x - cu.x + cv.x, y: center.y - cu.y + cv.y }
    ];
    return { kind: square ? "square" : "rectangle", vertices: alignOrder(ideal, vertices) };
  }

  /** A rhombus: diagonals that bisect each other at right angles. */
  function idealRhombus(vertices) {
    const [p0, p1, p2, p3] = vertices;
    const center = {
      x: (p0.x + p1.x + p2.x + p3.x) / 4,
      y: (p0.y + p1.y + p2.y + p3.y) / 4
    };
    const d1 = { x: p2.x - p0.x, y: p2.y - p0.y };
    const a = Math.hypot(d1.x, d1.y) / 2;
    const b = distance(p1, p3) / 2;
    if (!(a > 0) || !(b > 0)) return null;
    const e1 = { x: d1.x / (2 * a), y: d1.y / (2 * a) };
    let e2 = { x: -e1.y, y: e1.x };
    if ((p1.x - center.x) * e2.x + (p1.y - center.y) * e2.y < 0) e2 = { x: -e2.x, y: -e2.y };
    return [
      { x: center.x - e1.x * a, y: center.y - e1.y * a },
      { x: center.x + e2.x * b, y: center.y + e2.y * b },
      { x: center.x + e1.x * a, y: center.y + e1.y * a },
      { x: center.x - e2.x * b, y: center.y - e2.y * b }
    ];
  }

  /**
   * A parallelogram: any two diagonals that share a midpoint make one, so
   * keep the drawn diagonals and move only their midpoints together.
   */
  function idealParallelogram(vertices) {
    const [p0, p1, p2, p3] = vertices;
    const center = centroid(vertices);
    const h1 = { x: (p2.x - p0.x) / 2, y: (p2.y - p0.y) / 2 };
    const h2 = { x: (p1.x - p3.x) / 2, y: (p1.y - p3.y) / 2 };
    return [
      { x: center.x - h1.x, y: center.y - h1.y },
      { x: center.x + h2.x, y: center.y + h2.y },
      { x: center.x + h1.x, y: center.y + h1.y },
      { x: center.x - h2.x, y: center.y - h2.y }
    ];
  }

  /**
   * A kite: mirror-symmetric about the diagonal through the two corners that
   * sit between its equal pairs. `apex` is the index of one of them.
   */
  function idealKite(vertices, apex) {
    const a = vertices[apex];
    const c = vertices[(apex + 2) % 4];
    const len = distance(a, c);
    if (!(len > 0)) return null;
    const ax = { x: (c.x - a.x) / len, y: (c.y - a.y) / len };
    const reflect = (p) => {
      const t = (p.x - a.x) * ax.x + (p.y - a.y) * ax.y;
      const foot = { x: a.x + ax.x * t, y: a.y + ax.y * t };
      return { x: 2 * foot.x - p.x, y: 2 * foot.y - p.y };
    };
    const b = vertices[(apex + 1) % 4];
    const d = vertices[(apex + 3) % 4];
    // The two wing corners, averaged with each other's mirror image.
    const bMirror = reflect(d);
    const wing = { x: (b.x + bMirror.x) / 2, y: (b.y + bMirror.y) / 2 };
    const out = [];
    out[apex] = { x: a.x, y: a.y };
    out[(apex + 1) % 4] = wing;
    out[(apex + 2) % 4] = { x: c.x, y: c.y };
    out[(apex + 3) % 4] = reflect(wing);
    return out;
  }

  /** A trapezium: the one nearly-parallel pair made exactly parallel. */
  function idealTrapezium(vertices, first) {
    const out = vertices.map((v) => ({ x: v.x, y: v.y }));
    const pairs = [[first, (first + 1) % 4], [(first + 2) % 4, (first + 3) % 4]];
    let sx = 0;
    let sy = 0;
    for (const [i, j] of pairs) {
      let dx = vertices[j].x - vertices[i].x;
      let dy = vertices[j].y - vertices[i].y;
      // The opposite side runs the other way round the outline.
      if (sx * dx + sy * dy < 0) {
        dx = -dx;
        dy = -dy;
      }
      sx += dx;
      sy += dy;
    }
    const len = Math.hypot(sx, sy);
    if (!(len > 0)) return null;
    const dir = { x: sx / len, y: sy / len };
    for (const [i, j] of pairs) {
      const mid = { x: (vertices[i].x + vertices[j].x) / 2, y: (vertices[i].y + vertices[j].y) / 2 };
      const half = distance(vertices[i], vertices[j]) / 2;
      const sign = (vertices[j].x - vertices[i].x) * dir.x + (vertices[j].y - vertices[i].y) * dir.y >= 0 ? 1 : -1;
      out[i] = { x: mid.x - dir.x * half * sign, y: mid.y - dir.y * half * sign };
      out[j] = { x: mid.x + dir.x * half * sign, y: mid.y + dir.y * half * sign };
    }
    return out;
  }

  function interpretQuad(vertices, t) {
    const angles = interiorAngles(vertices);
    const meanRight = angles.reduce((sum, a) => sum + Math.abs(a - Math.PI / 2), 0) / 4;
    const sides = sidesOf(vertices);

    // Most specific first: every square is a rhombus, every rhombus a
    // parallelogram, every parallelogram has a parallel pair.
    if (meanRight <= t.rightAngleMean) return idealRectangle(vertices, t);

    const snap = (figure) => snapFigure(figure, figureDirections(figure), t.snap);
    if (spread(sides) <= t.equalSides) {
      const rhombus = idealRhombus(vertices);
      if (rhombus) return { kind: "rhombus", vertices: snap(rhombus) };
    }

    const dirs = vertices.map((v, i) => edgeDirection(v, vertices[(i + 1) % 4]));
    const parallel02 = parallelGap(dirs[0], dirs[2]) <= t.parallel;
    const parallel13 = parallelGap(dirs[1], dirs[3]) <= t.parallel;
    const equal = (a, b) => Math.abs(a - b) / Math.max(a, b) <= t.equalSides;

    if (parallel02 && parallel13) {
      return { kind: "parallelogram", vertices: snap(idealParallelogram(vertices)) };
    }
    for (const apex of [0, 1]) {
      // Kite with its axis through corners `apex` and `apex + 2`: the two
      // sides either side of each axis corner are equal.
      const s = (i) => sides[(i + 4) % 4];
      if (equal(s(apex - 1), s(apex)) && equal(s(apex + 1), s(apex + 2))) {
        const kite = idealKite(vertices, apex);
        if (kite) return { kind: "kite", vertices: snap(kite) };
      }
    }
    if (parallel02 !== parallel13) {
      const trapezium = idealTrapezium(vertices, parallel02 ? 0 : 1);
      if (trapezium) return { kind: "trapezium", vertices: snap(trapezium) };
    }
    return null;
  }

  // --- triangles ---

  function interpretTriangle(vertices, t) {
    const sides = sidesOf(vertices);
    const angles = interiorAngles(vertices);
    const snap = (figure) => snapFigure(figure, figureDirections(figure), t.snap);

    if (spread(sides) <= t.equilateral) {
      const center = centroid(vertices);
      const side = sides.reduce((sum, s) => sum + s, 0) / 3;
      const radius = side / Math.sqrt(3);
      const start = Math.atan2(vertices[0].y - center.y, vertices[0].x - center.x);
      const turn = winding(vertices);
      const ideal = [0, 1, 2].map((k) => ({
        x: center.x + Math.cos(start + turn * k * TAU / 3) * radius,
        y: center.y + Math.sin(start + turn * k * TAU / 3) * radius
      }));
      return { kind: "triangle", triangleType: "equilateral", vertices: snap(ideal) };
    }

    // The corner nearest 90°. geometry.js keeps a right triangle's right
    // angle at index 1 and locks it there, so the result is re-ordered to put
    // it there: a snapped right triangle then edits like one drawn with the
    // Shape tool, instead of losing its right angle on the first drag.
    const rightIndex = angles.reduce((best, a, i) => (Math.abs(a - Math.PI / 2) < Math.abs(angles[best] - Math.PI / 2) ? i : best), 0);
    if (Math.abs(angles[rightIndex] - Math.PI / 2) <= t.triangleRight) {
      const k = vertices[rightIndex];
      const a = vertices[(rightIndex + 2) % 3];
      const b = vertices[(rightIndex + 1) % 3];
      const la = distance(k, a);
      const lb = distance(k, b);
      const angA = Math.atan2(a.y - k.y, a.x - k.x);
      const angB = Math.atan2(b.y - k.y, b.x - k.x);
      // Open or close both legs by half the error, so neither end moves more
      // than the other.
      const error = Math.PI / 2 - Math.abs(wrapAngle(angB - angA));
      const sign = wrapAngle(angB - angA) >= 0 ? 1 : -1;
      const newA = angA - sign * error / 2;
      const newB = angB + sign * error / 2;
      const ideal = [
        { x: k.x + Math.cos(newA) * la, y: k.y + Math.sin(newA) * la },
        { x: k.x, y: k.y },
        { x: k.x + Math.cos(newB) * lb, y: k.y + Math.sin(newB) * lb }
      ];
      // Snap by the legs only: a right triangle is square to the page when its
      // legs are, whatever its hypotenuse does.
      const legs = [edgeDirection(ideal[0], ideal[1]), edgeDirection(ideal[1], ideal[2])];
      const turn = axisSnap(legs, t.snap);
      return {
        kind: "triangle",
        triangleType: "right",
        vertices: turn ? rotatePoints(ideal, ideal[1], turn) : ideal
      };
    }

    // Isosceles: the apex is the corner between the two equal sides, and
    // geometry.js puts the apex first.
    for (let apex = 0; apex < 3; apex += 1) {
      const left = sides[(apex + 2) % 3];
      const right = sides[apex];
      if (Math.abs(left - right) / Math.max(left, right) > t.isosceles) continue;
      const top = vertices[apex];
      const b1 = vertices[(apex + 1) % 3];
      const b2 = vertices[(apex + 2) % 3];
      const mid = { x: (b1.x + b2.x) / 2, y: (b1.y + b2.y) / 2 };
      const axisLength = distance(top, mid);
      if (!(axisLength > 0)) break;
      const ax = { x: (mid.x - top.x) / axisLength, y: (mid.y - top.y) / axisLength };
      const half = distance(b1, b2) / 2;
      const leg = (left + right) / 2;
      const height = leg > half ? Math.sqrt(leg * leg - half * half) : axisLength;
      const base = { x: top.x + ax.x * height, y: top.y + ax.y * height };
      let n = { x: -ax.y, y: ax.x };
      if ((b1.x - mid.x) * n.x + (b1.y - mid.y) * n.y < 0) n = { x: -n.x, y: -n.y };
      const ideal = [
        { x: top.x, y: top.y },
        { x: base.x + n.x * half, y: base.y + n.y * half },
        { x: base.x - n.x * half, y: base.y - n.y * half }
      ];
      // An isosceles triangle is square to the page when its axis is.
      const turn = axisSnap([edgeDirection(ideal[0], base)], t.snap);
      return {
        kind: "triangle",
        triangleType: "isosceles",
        vertices: turn ? rotatePoints(ideal, centroid(ideal), turn) : ideal
      };
    }

    return { kind: "triangle", triangleType: "custom", vertices: snap(vertices) };
  }

  // --- five and six corners ---

  function interpretRegular(vertices, t) {
    const n = vertices.length;
    const kind = n === 5 ? "pentagon" : n === 6 ? "hexagon" : null;
    if (!kind) return null;
    const sides = sidesOf(vertices);
    const angles = interiorAngles(vertices);
    const target = Math.PI - TAU / n;
    const angleOff = Math.max(...angles.map((a) => Math.abs(a - target)));
    if (spread(sides) > t.regularSides || angleOff > t.regularAngle) return null;
    const center = centroid(vertices);
    const radius = vertices.reduce((sum, v) => sum + distance(v, center), 0) / n;
    const start = Math.atan2(vertices[0].y - center.y, vertices[0].x - center.x);
    const turn = winding(vertices);
    const ideal = [];
    for (let k = 0; k < n; k += 1) {
      const angle = start + turn * k * TAU / n;
      ideal.push({ x: center.x + Math.cos(angle) * radius, y: center.y + Math.sin(angle) * radius });
    }
    return { kind, vertices: snapFigure(ideal, figureDirections(ideal), t.snap) };
  }

  /**
   * What a measured stroke becomes at an assist level.
   *
   * level 1 ("straight"): the figure that was meant. Wide tolerances, the
   *   ideal figure, and square to the page when nearly square to it.
   * level 2 ("exact"): the figure that was drawn. A kind is named only when
   *   the drawing already is one, orientation is never touched, and anything
   *   that is not a named figure keeps its corners exactly where they were,
   *   joined by straight edges.
   *
   * Returns a descriptor for handwriting.js: a geometry kind with its
   * vertices (or centre and radii), "polyline" for straight-edged ink that is
   * no named figure, "line" for a straight open stroke, or null.
   */
  function interpretShape(analysis, level) {
    if (!analysis || !(level >= 1)) return null;
    const t = level >= 2 ? INTENT.exact : INTENT.straight;

    if (analysis.type === "round") {
      const { ellipse, circle } = analysis;
      const ratio = Math.min(ellipse.rx, ellipse.ry) / Math.max(ellipse.rx, ellipse.ry);
      if (ratio >= t.circleRatio) {
        // The least-squares circle when it is a good fit: its radius is the
        // average one, where the extent-based ellipse radii are the extremes.
        const useCircle = circle && circle.residual <= SHAPE.CIRCLE_RESIDUAL;
        return {
          kind: "circle",
          center: useCircle ? circle.center : ellipse.center,
          radius: useCircle ? circle.radius : (ellipse.rx + ellipse.ry) / 2
        };
      }
      let rotation = ellipse.rotation;
      if (t.snap > 0) rotation += axisSnap([((rotation % Math.PI) + Math.PI) % Math.PI], t.snap);
      return { kind: "ellipse", center: ellipse.center, rx: ellipse.rx, ry: ellipse.ry, rotation };
    }

    if (analysis.type === "line") {
      let { a, b } = analysis;
      if (t.lineSnap > 0) {
        const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
        const angle = Math.atan2(b.y - a.y, b.x - a.x);
        const eighth = Math.PI / 4;
        const target = Math.round(angle / eighth) * eighth;
        if (Math.abs(wrapAngle(target - angle)) <= t.lineSnap) {
          const half = distance(a, b) / 2;
          a = { x: mid.x - Math.cos(target) * half, y: mid.y - Math.sin(target) * half };
          b = { x: mid.x + Math.cos(target) * half, y: mid.y + Math.sin(target) * half };
        }
      }
      return { kind: "line", a, b };
    }

    if (analysis.type !== "polygon") return null;
    const vertices = analysis.vertices;
    let named = null;
    if (vertices.length === 3) named = interpretTriangle(vertices, t);
    else if (vertices.length === 4) named = interpretQuad(vertices, t);
    else named = interpretRegular(vertices, t);
    if (named) return named;
    // No named figure. Straight's job is the ideal figure, so it has nothing
    // to offer and the stroke stays ink. Exact keeps the drawn corners and
    // straightens between them -- which is what Exact means -- and this is
    // what keeps a closed zigzag untouched at the default step.
    if (t !== INTENT.exact) return null;
    return { kind: "polyline", vertices: vertices.map((v) => ({ x: v.x, y: v.y })) };
  }

  /**
   * Measure and interpret in one call. `level` defaults to 1 ("straight"),
   * the default assist level; closed outlines only, as it always was.
   */
  function recognizeShape(points, level = 1) {
    return interpretShape(analyzeShape(points), level);
  }

  // ---------- digits ----------
  //
  // Templates are polylines in a unit box with y growing downward, the same
  // orientation the canvas uses, so they read the way the glyph looks.

  function line(x0, y0, x1, y1, steps = 8) {
    const out = [];
    for (let i = 0; i <= steps; i += 1) {
      const t = i / steps;
      out.push({ x: x0 + (x1 - x0) * t, y: y0 + (y1 - y0) * t });
    }
    return out;
  }

  function arc(cx, cy, rx, ry, from, to, steps = 20) {
    const out = [];
    for (let i = 0; i <= steps; i += 1) {
      const angle = from + (to - from) * (i / steps);
      out.push({ x: cx + Math.cos(angle) * rx, y: cy + Math.sin(angle) * ry });
    }
    return out;
  }

  function join(...runs) {
    return runs.flat();
  }

  const PI = Math.PI;

  // Several variants per digit, because the point of this is to match how a
  // person actually writes rather than how a font draws. A 7 with and without
  // its crossbar are genuinely different clouds.
  const DIGIT_TEMPLATES = [
    ["0", [arc(0.5, 0.5, 0.33, 0.48, -PI / 2, -PI / 2 - 2 * PI, 30)]],
    ["0", [arc(0.5, 0.5, 0.33, 0.48, -PI / 2, -PI / 2 + 2 * PI, 30)]],

    ["1", [line(0.5, 0.02, 0.5, 0.98, 20)]],
    ["1", [join(line(0.28, 0.2, 0.5, 0.02, 5), line(0.5, 0.02, 0.5, 0.98, 16))]],
    ["1", [join(line(0.28, 0.2, 0.5, 0.02, 4), line(0.5, 0.02, 0.5, 0.98, 14), line(0.24, 0.98, 0.76, 0.98, 6))]],

    ["2", [join(arc(0.5, 0.33, 0.32, 0.28, PI, 2 * PI, 16), line(0.82, 0.33, 0.14, 0.95, 12), line(0.14, 0.95, 0.9, 0.95, 8))]],

    ["3", [join(arc(0.46, 0.27, 0.3, 0.24, -0.8 * PI, 0.5 * PI, 16), arc(0.44, 0.72, 0.34, 0.26, -0.55 * PI, 0.8 * PI, 16))]],

    ["4", [join(line(0.62, 0.03, 0.1, 0.68, 10), line(0.1, 0.68, 0.92, 0.68, 10)), line(0.66, 0.28, 0.66, 0.98, 10)]],
    ["4", [line(0.62, 0.03, 0.1, 0.68, 10), join(line(0.1, 0.68, 0.92, 0.68, 8), line(0.66, 0.2, 0.66, 0.98, 10))]],

    ["5", [join(line(0.8, 0.05, 0.26, 0.05, 8), line(0.26, 0.05, 0.21, 0.45, 6), arc(0.47, 0.7, 0.32, 0.28, -0.5 * PI, 0.75 * PI, 16))]],

    ["6", [join(arc(0.55, 0.36, 0.3, 0.34, -0.3 * PI, -1.5 * PI, 16), arc(0.5, 0.72, 0.3, 0.26, PI, 3 * PI, 20))]],

    ["7", [join(line(0.14, 0.08, 0.86, 0.08, 10), line(0.86, 0.08, 0.34, 0.97, 14))]],
    ["7", [join(line(0.14, 0.08, 0.86, 0.08, 8), line(0.86, 0.08, 0.34, 0.97, 12)), line(0.26, 0.54, 0.66, 0.5, 5)]],

    ["8", [join(arc(0.5, 0.27, 0.26, 0.25, -PI / 2, -PI / 2 + 2 * PI, 18), arc(0.5, 0.74, 0.31, 0.24, -PI / 2, -PI / 2 - 2 * PI, 18))]],

    ["9", [join(arc(0.5, 0.29, 0.29, 0.27, -PI / 2, -PI / 2 - 2 * PI, 20), line(0.79, 0.29, 0.64, 0.98, 10))]]
  ];

  /** $P step 1: one cloud from every stroke, resampled to a fixed budget. */
  function toCloud(strokes, count) {
    const runs = (strokes || []).map(usable).filter((run) => run.length >= 2);
    if (!runs.length) return null;

    const lengths = runs.map(pathLength);
    const total = lengths.reduce((sum, value) => sum + value, 0);
    if (!(total > 0)) return null;

    const cloud = [];
    runs.forEach((run, index) => {
      // Share the budget by arc length so a long stroke is not compressed into
      // the same handful of samples as a short one.
      const share = Math.max(2, Math.round((lengths[index] / total) * count));
      for (const point of resample(run, share)) {
        cloud.push({ x: point.x, y: point.y, stroke: index });
      }
    });
    return cloud.length >= 2 ? cloud : null;
  }

  /**
   * $P steps 2 and 3: scale into a unit box, then centre on the origin.
   *
   * The scale divides by the larger side, so proportion survives — that is
   * what separates a narrow 1 from a round 0 — and rotation is deliberately
   * not normalised, which is what separates 6 from 9.
   */
  function normalizeCloud(cloud) {
    const bounds = boundsOf(cloud);
    if (!bounds) return null;
    const size = Math.max(bounds.width, bounds.height);
    if (!(size > 0)) return null;

    const scaled = cloud.map((point) => ({
      x: (point.x - bounds.minX) / size,
      y: (point.y - bounds.minY) / size,
      stroke: point.stroke
    }));

    let centroidX = 0;
    let centroidY = 0;
    for (const point of scaled) {
      centroidX += point.x;
      centroidY += point.y;
    }
    centroidX /= scaled.length;
    centroidY /= scaled.length;

    return scaled.map((point) => ({
      x: point.x - centroidX,
      y: point.y - centroidY,
      stroke: point.stroke
    }));
  }

  /**
   * $P's greedy cloud distance, weighted so samples near the start index
   * matter most, and run from several starts because the greedy walk is not
   * symmetric in where it begins.
   */
  function cloudDistance(from, to, start) {
    const matched = new Array(from.length).fill(false);
    let sum = 0;
    let i = start;
    do {
      let best = Infinity;
      let index = -1;
      for (let j = 0; j < to.length; j += 1) {
        if (matched[j]) continue;
        const d = distance(from[i], to[j]);
        if (d < best) {
          best = d;
          index = j;
        }
      }
      if (index === -1) break;
      matched[index] = true;
      sum += (1 - ((i - start + from.length) % from.length) / from.length) * best;
      i = (i + 1) % from.length;
    } while (i !== start);
    return sum;
  }

  function greedyMatch(candidate, template) {
    if (candidate.length !== template.length) return Infinity;
    const step = Math.max(1, Math.floor(Math.pow(candidate.length, 0.5)));
    let best = Infinity;
    for (let i = 0; i < candidate.length; i += step) {
      best = Math.min(best, cloudDistance(candidate, template, i), cloudDistance(template, candidate, i));
    }
    return best;
  }

  let compiled = null;

  function templates() {
    if (!compiled) {
      compiled = [];
      for (const [name, strokes] of DIGIT_TEMPLATES) {
        const cloud = toCloud(strokes, DIGIT.SAMPLES);
        const normalized = cloud && normalizeCloud(cloud);
        // A template that will not compile can never match anything, so it is
        // dropped at build time rather than skewing scores at match time.
        if (normalized && normalized.length === DIGIT.SAMPLES) {
          compiled.push({ name, points: normalized });
        }
      }
    }
    return compiled;
  }

  /**
   * Which digit these strokes are, or null when it is not clear.
   *
   * `strokes` is an array of point arrays, so a two-stroke 4 or a crossed 7
   * arrives as one candidate.
   */
  function recognizeDigit(strokes) {
    const cloud = toCloud(strokes, DIGIT.SAMPLES);
    const candidate = cloud && normalizeCloud(cloud);
    if (!candidate || candidate.length !== DIGIT.SAMPLES) return null;

    // Best score per digit, so three 1-variants do not outvote a single 7.
    const byName = new Map();
    for (const template of templates()) {
      const score = Math.max(0, (2 - greedyMatch(candidate, template.points)) / 2);
      const previous = byName.get(template.name);
      if (previous === undefined || score > previous) byName.set(template.name, score);
    }

    const ranked = [...byName.entries()].sort((a, b) => b[1] - a[1]);
    if (!ranked.length) return null;

    const [name, score] = ranked[0];
    const runnerUp = ranked.length > 1 ? ranked[1][1] : 0;
    if (score < DIGIT.MIN_SCORE) return null;
    if (score - runnerUp < DIGIT.MIN_MARGIN) return null;

    return { digit: name, score, margin: score - runnerUp };
  }

  window.Inkyscib = window.Inkyscib || {};
  window.Inkyscib.InkRecognize = {
    recognizeShape,
    analyzeShape,
    interpretShape,
    recognizeDigit,
    SHAPE,
    INTENT,
    DIGIT,
    // exported for tests
    resample,
    fitCircle,
    detectCorners,
    fitLine,
    intersectLines,
    edgeStraightness,
    classifyQuad,
    fitEllipse,
    idealRectangle,
    toCloud,
    normalizeCloud,
    templates
  };
})();
