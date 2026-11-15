// InkLab, page side. Checks isolation, allocates the shared ring, hands the
// canvas to the render worker and shows what the worker reports. It never draws
// ink: everything visible on the canvas is the worker's.
(function (root) {
  'use strict';

  const InkLab = root.InkLab;
  const { RingBuffer } = InkLab;

  let canvasEl = document.getElementById('inklabCanvas');
  const statsEl = document.getElementById('inklabStats');
  const clearEl = document.getElementById('inklabClear');
  const messageEl = document.getElementById('inklabMessage');
  const config = JSON.parse(document.getElementById('inklabConfig').textContent);

  const errors = [];
  let latestStats = null;

  const lab = {
    errors,
    get stats() {
      return latestStats;
    },
  };
  InkLab.lab = lab;

  function recordError(text) {
    errors.push(text);
    messageEl.textContent = text;
    messageEl.hidden = false;
  }

  if (!root.crossOriginIsolated) {
    const text =
      'InkLab needs cross-origin isolation for SharedArrayBuffer, and this page does not have it. ' +
      'Serve /lab/ink and /static/js/inklab/ with Cross-Origin-Opener-Policy: same-origin and ' +
      'Cross-Origin-Embedder-Policy: require-corp.';
    recordError(text);
    lab.ready = Promise.reject(new Error(text));
    lab.ready.catch(() => {});
    return;
  }

  // The --ink token as premultiplied [r, g, b, a] in 0-1. Read once, at start.
  function inkColour() {
    const value = getComputedStyle(document.documentElement).getPropertyValue('--ink').trim();
    const match = /^#([0-9a-f]{6})$/i.exec(value);
    const hex = match ? match[1] : '1b1b18';
    return [0, 2, 4].map((at) => parseInt(hex.slice(at, at + 2), 16) / 255).concat(1);
  }

  function currentSize() {
    const rect = canvasEl.getBoundingClientRect();
    return { width: rect.width, height: rect.height, dpr: root.devicePixelRatio || 1 };
  }

  function renderStats(stats) {
    const backend = stats.fallbackReason
      ? `${stats.backend} (fell back: ${stats.fallbackReason})`
      : stats.backend;
    const latency = stats.latencyMedianMs == null ? 'latency -' : `latency ${stats.latencyMedianMs.toFixed(1)} ms`;
    statsEl.textContent = [
      backend,
      latency,
      `prediction ${stats.predictionSource}`,
      `overflow ${stats.overflow}`,
      `${stats.frames} frames`,
    ].join(' · ');
  }

  const sab = RingBuffer.allocate();
  const producer = RingBuffer.createProducer(sab);
  const worker = new Worker(config.worker);

  let resolveReady;
  let rejectReady;
  lab.ready = new Promise((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });

  const pending = new Map();
  let nextRequestId = 1;

  function request(type, payload) {
    const id = nextRequestId++;
    return new Promise((resolve) => {
      pending.set(id, resolve);
      worker.postMessage(Object.assign({ type, id }, payload));
    });
  }

  const resizeObserver = new ResizeObserver(() => {
    worker.postMessage(Object.assign({ type: 'resize' }, currentSize()));
  });

  // The worker's canvas is locked to webgpu after a GPU loss it could not
  // recover from, so it asks for a new element to carry on in 2D.
  function replaceCanvas() {
    const fresh = document.createElement('canvas');
    fresh.id = canvasEl.id;
    fresh.setAttribute('aria-label', canvasEl.getAttribute('aria-label'));
    resizeObserver.unobserve(canvasEl);
    canvasEl.replaceWith(fresh);
    canvasEl = fresh;
    resizeObserver.observe(canvasEl);
    // Any stroke in progress lost its pointer with the old element.
    activePointer = null;
    bindPointer(canvasEl);
    const offscreen = canvasEl.transferControlToOffscreen();
    worker.postMessage({ type: 'replaceCanvas', canvas: offscreen }, [offscreen]);
  }

  worker.onmessage = (event) => {
    const message = event.data;
    switch (message.type) {
      case 'ready':
        resolveReady({ backend: message.backend, fallbackReason: message.fallbackReason });
        break;
      case 'stats':
        latestStats = message;
        renderStats(message);
        break;
      case 'snapshot':
      case 'tessellate': {
        const resolve = pending.get(message.id);
        pending.delete(message.id);
        if (resolve) resolve(message);
        break;
      }
      case 'needCanvas':
        replaceCanvas();
        break;
      case 'error':
        recordError(message.message);
        rejectReady(new Error(message.message));
        break;
      default:
        break;
    }
  };

  worker.onerror = (event) => {
    const text = `The render worker failed: ${event.message || 'no message given'}`;
    recordError(text);
    rejectReady(new Error(text));
  };

  const offscreen = canvasEl.transferControlToOffscreen();
  worker.postMessage(
    Object.assign(
      {
        type: 'init',
        canvas: offscreen,
        sab,
        scripts: config.scripts,
        pageTimeOrigin: performance.timeOrigin,
        ink: inkColour(),
      },
      currentSize()
    ),
    [offscreen]
  );

  resizeObserver.observe(canvasEl);

  // --- pointer capture (spec section 9) ------------------------------------
  //
  // The page's only drawing job: turn pointer events into samples in the ring
  // and wake the worker. Coalesced events carry every sample the hardware
  // reported between frames; predicted events are the browser's own guess at
  // where the pen is going, marked so the worker never commits them.

  const { Flags } = RingBuffer;
  let activePointer = null;

  function sampleFrom(event, flags) {
    return { x: event.offsetX, y: event.offsetY, pressure: event.pressure, time: event.timeStamp, flags };
  }

  function onPointerDown(event) {
    if (!event.isPrimary || activePointer !== null) return;
    activePointer = event.pointerId;
    event.currentTarget.setPointerCapture(event.pointerId);
    producer.push(sampleFrom(event, Flags.DOWN));
    producer.notify();
    event.preventDefault();
  }

  function onPointerMove(event) {
    if (event.pointerId !== activePointer) return;
    const coalesced = typeof event.getCoalescedEvents === 'function' ? event.getCoalescedEvents() : [];
    for (const sample of coalesced.length ? coalesced : [event]) {
      producer.push(sampleFrom(sample, Flags.MOVE));
    }
    const predicted = typeof event.getPredictedEvents === 'function' ? event.getPredictedEvents() : [];
    for (const sample of predicted) {
      producer.push(sampleFrom(sample, Flags.PREDICTED));
    }
    producer.notify();
    event.preventDefault();
  }

  function onPointerEnd(event) {
    if (event.pointerId !== activePointer) return;
    activePointer = null;
    producer.push(sampleFrom(event, Flags.UP));
    producer.notify();
  }

  function bindPointer(element) {
    element.addEventListener('pointerdown', onPointerDown, { passive: false });
    element.addEventListener('pointermove', onPointerMove, { passive: false });
    element.addEventListener('pointerup', onPointerEnd, { passive: false });
    element.addEventListener('pointercancel', onPointerEnd, { passive: false });
  }

  bindPointer(canvasEl);

  lab.clear = () => worker.postMessage({ type: 'clear' });
  clearEl.addEventListener('click', lab.clear);

  // Test seams. They write to the same ring the pointer handlers use.
  lab.pushSample = (sample) => producer.push(sample);
  lab.notify = () => producer.notify();
  lab.snapshot = () => request('snapshot', {});
  lab.tessellate = (samples, baseSize) => request('tessellate', { samples, baseSize });
})(self);
