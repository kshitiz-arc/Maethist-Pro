'use strict';

// InkLab carries its own copy of the brush width formula, because the worker
// cannot load the editor's canvas.js - it touches the DOM the moment it runs.
// A copy is how the three existing ones drifted (TODOS.md item 5), so this test
// runs the editor's real functions, pulled out of canvas.js by source text, and
// requires InkLab's copy to agree with them to the last bit.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const { ROOT, loadInkLab } = require('./load.cjs');

const { StrokeWidth } = loadInkLab('static/js/inklab/stroke-width.js');

const EDITOR_FUNCTIONS = ['__clamp', '__pointPressure', '__segmentSpeed', '__penSegmentWidth'];
const CANVAS_SOURCE = fs.readFileSync(path.join(ROOT, 'static', 'js', 'canvas.js'), 'utf8');

// Finds `function name(` and returns the declaration through its matching
// closing brace. None of these four functions has a brace inside a string or
// a comment, so counting braces is enough.
function extractFunction(source, name) {
  const start = source.indexOf(`function ${name}(`);
  if (start === -1) return null;
  const open = source.indexOf('{', start);
  let depth = 0;
  for (let i = open; i < source.length; i++) {
    if (source[i] === '{') depth++;
    else if (source[i] === '}' && --depth === 0) return source.slice(start, i + 1);
  }
  return null;
}

function editorWidthFunction() {
  const sources = EDITOR_FUNCTIONS.map((name) => extractFunction(CANVAS_SOURCE, name));
  return vm.runInThisContext(
    `(function () {\n${sources.join('\n')}\nreturn __penSegmentWidth;\n})`,
    { filename: 'canvas.js (extracted)' }
  )();
}

// Strokes chosen to reach every branch of the formula: both ends of the speed
// clamp, the taper at both ends, and the fallbacks for a zero, negative or
// missing time interval and for missing pressure.
function strokes() {
  const wavy = (length, timeAt, pressureAt) =>
    Array.from({ length }, (_, i) => {
      const point = { x: 50 + i * 3.7 + Math.sin(i / 3) * 9, y: 80 + i * 1.3 + Math.cos(i / 4) * 6 };
      const time = timeAt(i);
      const pressure = pressureAt(i);
      if (time !== undefined) point.time = time;
      if (pressure !== undefined) point.pressure = pressure;
      return point;
    });
  const varying = (i) => 0.1 + 0.8 * Math.abs(Math.sin(i / 5));
  return [
    ['regular', wavy(40, (i) => 1000 + i * 7.5, varying)],
    ['duplicate timestamps', wavy(40, (i) => 1000 + Math.floor(i / 2) * 8, varying)],
    ['decreasing timestamps', wavy(40, (i) => 5000 - i * 6, varying)],
    ['no timestamps', wavy(40, () => undefined, varying)],
    ['no pressure', wavy(40, (i) => 1000 + i * 7.5, () => undefined)],
    ['out-of-range pressure', wavy(40, (i) => 1000 + i * 7.5, (i) => (i % 2 ? 1.7 : -0.3))],
    ['fast', Array.from({ length: 30 }, (_, i) => ({ x: i * 40, y: i * 11, pressure: 0.5, time: i * 8 }))],
    ['still', Array.from({ length: 30 }, (_, i) => ({ x: 20, y: 20, pressure: 0.6, time: i * 16 }))],
    ['single point', [{ x: 5, y: 6, pressure: 0.4, time: 10 }]],
    ['two points', [{ x: 5, y: 6, pressure: 0.4, time: 10 }, { x: 9, y: 2, pressure: 0.7, time: 18 }]],
  ];
}

test('all four editor functions can be found in canvas.js', () => {
  for (const name of EDITOR_FUNCTIONS) {
    assert.ok(
      extractFunction(CANVAS_SOURCE, name),
      `${name} was not found in canvas.js - the parity check below would be meaningless`
    );
  }
});

test('the base size is 4 CSS px', () => {
  assert.equal(StrokeWidth.BASE_SIZE, 4);
});

test("InkLab's brush width is bit-identical to the editor's", () => {
  const editorWidth = editorWidthFunction();
  let compared = 0;
  for (const baseSize of [2, 4, 9.5]) {
    for (const [label, points] of strokes()) {
      for (let i = 0; i < points.length; i++) {
        assert.strictEqual(
          StrokeWidth.brushWidth(points, i, baseSize),
          editorWidth('brush', baseSize, points, i),
          `${label}, baseSize ${baseSize}, index ${i}`
        );
        compared++;
      }
    }
  }
  assert.ok(compared > 800, `only ${compared} widths were compared`);
});
