// InkLab ring buffer: a single-producer, single-consumer queue of pen samples
// over a SharedArrayBuffer.
//
// The page pushes samples as pointer events arrive and the render worker drains
// them once per frame. Neither side takes a lock. Each owns exactly one index -
// the page HEAD, the worker TAIL - and the page publishes a slot only after
// filling it, so a read of the other side's index can be stale but never wrong.
// One slot always stays empty, which is how a full ring is told apart from an
// empty one.
//
// When the ring is full the newest sample is dropped and counted. Losing ink
// without saying so is the worst thing a drawing surface can do, so the count
// is shown on the page and asserted zero in tests.
(function (root) {
  'use strict';

  const HEAD = 0;
  const TAIL = 1;
  const CAPACITY = 2;
  const OVERFLOW = 3;
  const WAKE = 4;
  const HEADER_SLOTS = 8;
  // Eight Int32 slots end at byte 32, which is also a multiple of 8, as a
  // Float64Array view requires.
  const DATA_OFFSET = 32;
  // x, y, pressure, time, flags
  const STRIDE = 5;
  const DEFAULT_CAPACITY = 16384;

  const Flags = Object.freeze({ DOWN: 1, MOVE: 2, UP: 4, PREDICTED: 8 });

  function allocate(capacity = DEFAULT_CAPACITY) {
    const sab = new SharedArrayBuffer(DATA_OFFSET + capacity * STRIDE * 8);
    new Int32Array(sab, 0, HEADER_SLOTS)[CAPACITY] = capacity;
    return sab;
  }

  function views(sab) {
    const header = new Int32Array(sab, 0, HEADER_SLOTS);
    const capacity = header[CAPACITY];
    const data = new Float64Array(sab, DATA_OFFSET, capacity * STRIDE);
    return { header, capacity, data };
  }

  function createProducer(sab) {
    const { header, capacity, data } = views(sab);
    return {
      push(sample) {
        const head = Atomics.load(header, HEAD);
        const next = (head + 1) % capacity;
        if (next === Atomics.load(header, TAIL)) {
          Atomics.add(header, OVERFLOW, 1);
          return false;
        }
        const at = head * STRIDE;
        data[at] = sample.x;
        data[at + 1] = sample.y;
        data[at + 2] = sample.pressure;
        data[at + 3] = sample.time;
        data[at + 4] = sample.flags;
        Atomics.store(header, HEAD, next);
        return true;
      },
      notify() {
        Atomics.add(header, WAKE, 1);
        Atomics.notify(header, WAKE);
      },
      overflow() {
        return Atomics.load(header, OVERFLOW);
      },
    };
  }

  function createConsumer(sab) {
    const { header, capacity, data } = views(sab);
    return {
      drain(visit) {
        const head = Atomics.load(header, HEAD);
        let tail = Atomics.load(header, TAIL);
        let count = 0;
        while (tail !== head) {
          const at = tail * STRIDE;
          visit({
            x: data[at],
            y: data[at + 1],
            pressure: data[at + 2],
            time: data[at + 3],
            flags: data[at + 4],
          });
          tail = (tail + 1) % capacity;
          count++;
        }
        Atomics.store(header, TAIL, tail);
        return count;
      },
      wake() {
        return Atomics.load(header, WAKE);
      },
      // Atomics.waitAsync returns a plain string, not a promise, when the value
      // has already moved on. Both shapes resolve the same way here.
      waitForWork(seenWake) {
        const result = Atomics.waitAsync(header, WAKE, seenWake);
        return result.async ? result.value : Promise.resolve(result.value);
      },
      overflow() {
        return Atomics.load(header, OVERFLOW);
      },
    };
  }

  root.InkLab = root.InkLab || {};
  root.InkLab.RingBuffer = Object.freeze({
    Flags,
    STRIDE,
    HEADER_SLOTS,
    DATA_OFFSET,
    DEFAULT_CAPACITY,
    HEAD,
    TAIL,
    CAPACITY,
    OVERFLOW,
    WAKE,
    allocate,
    createProducer,
    createConsumer,
  });
})(self);
