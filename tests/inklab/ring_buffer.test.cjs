'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { loadInkLab } = require('./load.cjs');

const { RingBuffer } = loadInkLab('static/js/inklab/ring-buffer.js');
const { Flags } = RingBuffer;

// Every value here is exactly representable in float64, so a round trip can be
// compared with strict equality rather than a tolerance.
function sample(n, flags = Flags.MOVE) {
  return { x: n * 1.5 - 3, y: n * 0.25, pressure: (n % 5) / 4, time: 1000 + n * 8.125, flags };
}

function drainAll(consumer) {
  const out = [];
  consumer.drain((s) => out.push(s));
  return out;
}

function ring(capacity) {
  const sab = RingBuffer.allocate(capacity);
  return {
    sab,
    producer: RingBuffer.createProducer(sab),
    consumer: RingBuffer.createConsumer(sab),
  };
}

test('allocate sizes the buffer for the header plus five float64 fields per slot', () => {
  const sab = RingBuffer.allocate(8);
  assert.equal(sab.byteLength, 32 + 8 * 5 * 8);
  assert.equal(new Int32Array(sab, 0, 8)[RingBuffer.CAPACITY], 8);
});

test('the default capacity is 16384 slots', () => {
  const sab = RingBuffer.allocate();
  assert.equal(new Int32Array(sab, 0, 8)[RingBuffer.CAPACITY], 16384);
});

test('samples drain in the order they were pushed', () => {
  const { producer, consumer } = ring(16);
  const pushed = [0, 1, 2, 3, 4].map((n) => sample(n));
  pushed.forEach((s) => assert.equal(producer.push(s), true));
  assert.deepEqual(drainAll(consumer), pushed);
});

test('order holds across wraparound for several capacities', () => {
  for (const capacity of [4, 5, 8]) {
    const { producer, consumer } = ring(capacity);
    let n = 0;
    for (let round = 0; round < 3; round++) {
      const pushed = [];
      for (let i = 0; i < capacity - 1; i++) {
        const s = sample(n++);
        assert.equal(producer.push(s), true, `capacity ${capacity}, round ${round}, push ${i}`);
        pushed.push(s);
      }
      assert.deepEqual(drainAll(consumer), pushed, `capacity ${capacity}, round ${round}`);
    }
  }
});

test('a full ring refuses the push and counts it instead of overwriting', () => {
  const { producer, consumer } = ring(4);
  const pushed = [sample(0), sample(1), sample(2)];
  pushed.forEach((s) => assert.equal(producer.push(s), true));
  assert.equal(producer.push(sample(3)), false);
  assert.equal(producer.overflow(), 1);
  assert.equal(consumer.overflow(), 1);
  assert.deepEqual(drainAll(consumer), pushed);
});

test('every field and every flag survives the round trip', () => {
  const { producer, consumer } = ring(16);
  const pushed = [
    { x: -12.5, y: 0, pressure: 0, time: 3.0625, flags: Flags.DOWN },
    { x: 1e6 + 0.5, y: -0.125, pressure: 1, time: 123456.789, flags: Flags.MOVE },
    { x: 7, y: 8, pressure: 0.5, time: 123464.1, flags: Flags.PREDICTED },
    { x: 7, y: 8, pressure: 0.5, time: 123470, flags: Flags.UP },
  ];
  pushed.forEach((s) => producer.push(s));
  assert.deepEqual(drainAll(consumer), pushed);
  assert.deepEqual({ ...Flags }, { DOWN: 1, MOVE: 2, UP: 4, PREDICTED: 8 });
});

// Catches either side keeping the other's index in a local copy: the producer
// would still see a full ring after the consumer had emptied it.
test('producer and consumer coordinate only through the shared buffer', () => {
  const { sab, producer, consumer } = ring(4);
  [0, 1, 2].forEach((n) => producer.push(sample(n)));
  assert.equal(producer.push(sample(3)), false);
  assert.equal(consumer.drain(() => {}), 3);
  assert.equal(producer.push(sample(4)), true, 'the producer must see the tail the consumer advanced');
  const secondConsumer = RingBuffer.createConsumer(sab);
  assert.deepEqual(drainAll(secondConsumer), [sample(4)]);
});

test('draining an empty ring visits nothing and reports zero', () => {
  const { consumer } = ring(4);
  let visited = 0;
  assert.equal(consumer.drain(() => visited++), 0);
  assert.equal(visited, 0);
});

test('notify advances the wake counter', () => {
  const { producer, consumer } = ring(4);
  const before = consumer.wake();
  producer.notify();
  assert.equal(consumer.wake(), before + 1);
});

// The worker reads the wake counter before it drains, then waits on that value.
// A notify that lands in between must not be slept through.
test('waiting on a stale wake value resolves at once', async () => {
  const { producer, consumer } = ring(4);
  const seen = consumer.wake();
  producer.notify();
  assert.equal(await consumer.waitForWork(seen), 'not-equal');
});

test('a waiting consumer wakes when the producer notifies', async () => {
  const { producer, consumer } = ring(4);
  const waiting = consumer.waitForWork(consumer.wake());
  producer.notify();
  assert.equal(await waiting, 'ok');
});
