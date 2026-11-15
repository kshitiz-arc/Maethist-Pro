'use strict';

// The WebNN hook is only an integration point: no model ships, and neither test
// browser exposes navigator.ml. So it is tested here against a fake `ml` and a
// fake model, for the one thing it must get right - use a model's output when
// it is good, and step aside (return null) whenever anything is wrong, so the
// polynomial predictor takes that frame.

const assert = require('node:assert/strict');
const test = require('node:test');
const { loadInkLab } = require('./load.cjs');

const { Predictor, RingBuffer } = loadInkLab(
  'static/js/inklab/ring-buffer.js',
  'static/js/inklab/predictor.js'
);
const { PREDICTED, MOVE } = RingBuffer.Flags;

const HISTORY = [
  { x: 10, y: 10, pressure: 0.4, time: 100, flags: MOVE },
  { x: 14, y: 11, pressure: 0.5, time: 108, flags: MOVE },
  { x: 18, y: 12, pressure: 0.6, time: 116, flags: MOVE },
  { x: 22, y: 13, pressure: 0.65, time: 124, flags: MOVE },
];

function fakeMl() {
  const ml = {
    contextsCreated: 0,
    async createContext() {
      ml.contextsCreated++;
      return { kind: 'fake WebNN context' };
    },
  };
  return ml;
}

test('without navigator.ml there is no neural predictor', () => {
  assert.equal(Predictor.createNeural({ model: async () => [] }), null);
  assert.equal(Predictor.createNeural({ ml: undefined, model: async () => [] }), null);
});

test('an ml object that cannot create a context is not enough', () => {
  assert.equal(Predictor.createNeural({ ml: {}, model: async () => [] }), null);
});

test('without a model there is no neural predictor', () => {
  assert.equal(Predictor.createNeural({ ml: fakeMl() }), null);
});

test("a model's points are used, filled in like the polynomial predictor's", async () => {
  let seen = null;
  const neural = Predictor.createNeural({
    ml: fakeMl(),
    model: async (context, history) => {
      seen = { context, history };
      return [{ x: 26, y: 14 }, { x: 30, y: 15 }];
    },
  });
  const out = await neural.predict(HISTORY, 16);

  assert.deepEqual(out, [
    { x: 26, y: 14, pressure: 0.65, time: 132, flags: PREDICTED },
    { x: 30, y: 15, pressure: 0.65, time: 140, flags: PREDICTED },
  ]);
  assert.deepEqual(seen.context, { kind: 'fake WebNN context' });
  assert.equal(seen.history, HISTORY);
});

test('a model that throws gives null', async () => {
  const neural = Predictor.createNeural({
    ml: fakeMl(),
    model: () => {
      throw new Error('inference failed');
    },
  });
  assert.equal(await neural.predict(HISTORY, 16), null);
});

test('a model that rejects gives null', async () => {
  const neural = Predictor.createNeural({
    ml: fakeMl(),
    model: async () => {
      throw new Error('inference failed');
    },
  });
  assert.equal(await neural.predict(HISTORY, 16), null);
});

test('a model that returns a non-finite coordinate gives null', async () => {
  const neural = Predictor.createNeural({ ml: fakeMl(), model: async () => [{ x: 1, y: Number.NaN }] });
  assert.equal(await neural.predict(HISTORY, 16), null);
});

test('a model that returns something other than points gives null', async () => {
  for (const result of [null, 'points', [{ x: 1 }], {}]) {
    const neural = Predictor.createNeural({ ml: fakeMl(), model: async () => result });
    assert.equal(await neural.predict(HISTORY, 16), null, JSON.stringify(result));
  }
});

test('an empty history gives null, since there is nothing to take pressure and time from', async () => {
  const neural = Predictor.createNeural({ ml: fakeMl(), model: async () => [{ x: 1, y: 1 }] });
  assert.equal(await neural.predict([], 16), null);
});

test('the WebNN context is created once, however many predictions follow', async () => {
  const ml = fakeMl();
  const neural = Predictor.createNeural({ ml, model: async () => [{ x: 1, y: 1 }] });
  await neural.predict(HISTORY, 16);
  await neural.predict(HISTORY, 16);
  await neural.predict(HISTORY, 16);
  assert.equal(ml.contextsCreated, 1);
});
