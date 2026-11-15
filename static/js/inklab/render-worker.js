// InkLab render worker. It owns the drawing surface: it drains pen samples from
// the shared ring once per animation frame, assembles the active stroke, and
// draws through whichever renderer initialised. Design: spec sections 10 and 12.
(function () {
  'use strict';

  let InkLab = null;
  let consumer = null;
  let renderer = null;
  let tessellator = null;
  let backend = '';
  let fallbackReason = '';
  let size = null;
  let ink = null;
  let baseSize = 4;
  let pageTimeOrigin = 0;
  let initialised = false;
  let currentCanvas = null;
  let rebuiltAfterLoss = false;

  let committed = [];
  let pendingPredicted = [];
  let provisional = [];
  let finished = [];
  let drawing = false;
  let predictionSource = 'none';

  // The WebNN hook (spec section 11.2). No trained model ships, so in practice
  // this stays null and the polynomial predictor does the work.
  let neural = null;
  let neuralInFlight = false;
  let neuralResult = null;

  let seenWake = 0;
  let loopActive = false;
  let frames = 0;
  let lastStatsAt = -Infinity;
  const latencies = [];
  const LATENCY_WINDOW = 120;

  function messageOf(error) {
    return error && error.message ? error.message : String(error);
  }

  function reportError(error) {
    const text = error && error.message ? `${error.name}: ${error.message}` : String(error);
    self.postMessage({ type: 'error', message: text });
  }

  // A validation error in a per-frame pass would otherwise repeat every frame,
  // so each distinct message is reported once.
  const reportedGpuErrors = new Set();
  function reportGpuError(error) {
    const text = `WebGPU: ${messageOf(error)}`;
    if (reportedGpuErrors.has(text)) return;
    reportedGpuErrors.add(text);
    self.postMessage({ type: 'error', message: text });
  }

  // --- frame scheduling -----------------------------------------------------

  let useTimers = typeof self.requestAnimationFrame !== 'function';
  let animationFrameSeen = false;

  // Animation frames are the right clock, but a worker is not guaranteed to get
  // them - a hidden or headless page may never deliver one. If none has arrived
  // within 250 ms the scheduler switches to timers for good. The guard stops a
  // late animation frame and the watchdog both running the same frame.
  function requestFrame(callback) {
    let done = false;
    const run = (timestamp) => {
      if (done) return;
      done = true;
      callback(timestamp);
    };
    if (useTimers) {
      setTimeout(() => run(performance.now()), 16);
      return;
    }
    self.requestAnimationFrame((timestamp) => {
      animationFrameSeen = true;
      run(timestamp);
    });
    if (!animationFrameSeen) {
      setTimeout(() => {
        if (animationFrameSeen) return;
        useTimers = true;
        run(performance.now());
      }, 250);
    }
  }

  // --- the drain loop ---------------------------------------------------------

  function drainRing() {
    const { Flags } = InkLab.RingBuffer;
    let newestCommittedTime = null;
    const count = consumer.drain((sample) => {
      switch (sample.flags) {
        case Flags.DOWN:
          committed = [sample];
          pendingPredicted = [];
          provisional = [];
          drawing = true;
          newestCommittedTime = sample.time;
          break;
        case Flags.MOVE:
          if (!drawing) return;
          committed.push(sample);
          // A newer real sample makes every earlier prediction stale.
          pendingPredicted = [];
          newestCommittedTime = sample.time;
          break;
        case Flags.PREDICTED:
          if (!drawing) return;
          pendingPredicted.push(sample);
          break;
        case Flags.UP:
          if (!drawing) return;
          committed.push(sample);
          newestCommittedTime = sample.time;
          // Only committed samples are ever baked. Predictions never are.
          renderer.bake(committed);
          finished.push(committed);
          committed = [];
          pendingPredicted = [];
          provisional = [];
          drawing = false;
          break;
        default:
          break;
      }
    });
    return { count, newestCommittedTime };
  }

  function latestCommittedTime() {
    return committed.length ? committed[committed.length - 1].time : null;
  }

  // At most one inference at a time. Each result is tagged with the newest
  // committed sample it was given, and is only used while that sample is still
  // the newest - a prediction for where the pen was is worse than none.
  function requestNeuralPrediction() {
    if (!neural || neuralInFlight || !committed.length) return;
    neuralInFlight = true;
    const forTime = latestCommittedTime();
    neural.predict(committed.slice()).then(
      (points) => {
        neuralInFlight = false;
        neuralResult = points ? { forTime, points } : null;
      },
      () => {
        neuralInFlight = false;
        neuralResult = null;
      }
    );
  }

  // Prediction sources, in order of preference: the browser's own predicted
  // events, a fresh neural result, then the polynomial extrapolator.
  function chooseProvisional() {
    if (!drawing) {
      provisional = [];
      predictionSource = 'none';
      return;
    }
    if (pendingPredicted.length) {
      provisional = pendingPredicted;
      predictionSource = 'native';
      return;
    }
    requestNeuralPrediction();
    if (neuralResult && neuralResult.forTime === latestCommittedTime()) {
      provisional = neuralResult.points;
      predictionSource = 'webnn';
      return;
    }
    provisional = InkLab.Predictor ? InkLab.Predictor.predict(committed) : [];
    predictionSource = provisional.length ? 'polynomial' : 'none';
  }

  function recordLatency(timestamp, newestCommittedTime) {
    if (newestCommittedTime === null) return;
    const presentOnPageClock = performance.timeOrigin + timestamp - pageTimeOrigin;
    latencies.push(presentOnPageClock - newestCommittedTime);
    if (latencies.length > LATENCY_WINDOW) latencies.shift();
  }

  function medianLatency() {
    if (!latencies.length) return null;
    const sorted = latencies.slice().sort((a, b) => a - b);
    return sorted[sorted.length >> 1];
  }

  function stats() {
    return {
      backend,
      fallbackReason,
      latencyMedianMs: medianLatency(),
      predictionSource,
      overflow: consumer ? consumer.overflow() : 0,
      frames,
    };
  }

  function postStats(now, force) {
    if (!force && now - lastStatsAt < 250) return;
    lastStatsAt = now;
    self.postMessage(Object.assign({ type: 'stats' }, stats()));
  }

  function frame(timestamp) {
    // No surface to draw on - the GPU was lost and a fresh canvas is on its way.
    if (!initialised) {
      loopActive = false;
      return;
    }
    try {
      // Read the wake counter before draining, so a notify that lands after the
      // drain has already moved it and the next wait resolves at once.
      seenWake = consumer.wake();
      const { count, newestCommittedTime } = drainRing();

      if (drawing || count > 0) {
        chooseProvisional();
        renderer.drawFrame(committed, provisional);
        frames++;
        recordLatency(timestamp, newestCommittedTime);
        postStats(timestamp, false);
        requestFrame(frame);
        return;
      }

      loopActive = false;
      postStats(timestamp, true);
      waitForWork();
    } catch (error) {
      loopActive = false;
      reportError(error);
    }
  }

  function startLoop() {
    if (loopActive || !initialised) return;
    loopActive = true;
    requestFrame(frame);
  }

  function waitForWork() {
    consumer.waitForWork(seenWake).then(startLoop, reportError);
  }

  function redraw() {
    if (!initialised) return;
    chooseProvisional();
    renderer.drawFrame(committed, provisional);
  }

  // --- choosing and replacing a renderer --------------------------------------

  function adoptGpuRenderer(gpuRenderer) {
    renderer = gpuRenderer;
    backend = gpuRenderer.name;
    // One device serves both drawing and tessellate requests.
    tessellator = gpuRenderer;
    gpuRenderer.onDeviceLost((info) => {
      handleDeviceLost(info).catch(reportError);
    });
    gpuRenderer.onError(reportGpuError);
  }

  async function useCanvas2D(canvas) {
    renderer = InkLab.Canvas2DRenderer.create();
    backend = renderer.name;
    await renderer.init(canvas, size, ink, baseSize);
  }

  // WebGPU first. The GPU renderer builds its device and every pipeline before
  // it touches the canvas, so a rejection here leaves the canvas free for 2D.
  async function chooseRenderer(canvas) {
    currentCanvas = canvas;
    if (!InkLab.GpuRenderer) {
      fallbackReason = 'WebGPU renderer not loaded';
      await useCanvas2D(canvas);
      return;
    }
    const gpuRenderer = InkLab.GpuRenderer.create({ gpu: self.navigator.gpu });
    try {
      await gpuRenderer.init(canvas, size, ink, baseSize);
      fallbackReason = '';
      adoptGpuRenderer(gpuRenderer);
    } catch (error) {
      fallbackReason = messageOf(error);
      await useCanvas2D(canvas);
    }
  }

  // Rebuild once on the same canvas, which WebGPU allows. If that fails the
  // canvas cannot fall back - it is locked to webgpu - so ask the page for a new
  // one and carry on in 2D there.
  async function handleDeviceLost(info) {
    if (info && info.reason === 'destroyed') return;
    if (!rebuiltAfterLoss) {
      rebuiltAfterLoss = true;
      const replacement = InkLab.GpuRenderer.create({ gpu: self.navigator.gpu });
      try {
        await replacement.init(currentCanvas, size, ink, baseSize);
        adoptGpuRenderer(replacement);
        for (const stroke of finished) renderer.bake(stroke);
        redraw();
        postStats(performance.now(), true);
        return;
      } catch (error) {
        fallbackReason = `The GPU device was lost and could not be rebuilt: ${messageOf(error)}`;
      }
    } else {
      fallbackReason = `The GPU device was lost again: ${info ? info.message : 'no message given'}`;
    }
    initialised = false;
    tessellator = null;
    self.postMessage({ type: 'needCanvas' });
  }

  async function handleReplaceCanvas(message) {
    currentCanvas = message.canvas;
    await useCanvas2D(message.canvas);
    for (const stroke of finished) renderer.bake(stroke);
    initialised = true;
    redraw();
    postStats(performance.now(), true);
    startLoop();
  }

  // --- messages ---------------------------------------------------------------

  async function handleInit(message) {
    importScripts(...message.scripts);
    InkLab = self.InkLab;
    consumer = InkLab.RingBuffer.createConsumer(message.sab);
    baseSize = InkLab.StrokeWidth.BASE_SIZE;
    // A model cannot be posted to a worker - functions do not survive
    // structured cloning - so a future model would be defined by a script the
    // worker loads, as self.InkLab.NeuralModel. None exists today.
    neural = InkLab.Predictor
      ? InkLab.Predictor.createNeural({ ml: self.navigator.ml, model: InkLab.NeuralModel })
      : null;
    pageTimeOrigin = message.pageTimeOrigin;
    ink = message.ink;
    size = size || { width: message.width, height: message.height, dpr: message.dpr };

    await chooseRenderer(message.canvas);
    initialised = true;

    self.postMessage({ type: 'ready', backend, fallbackReason });
    postStats(performance.now(), true);
    redraw();
    seenWake = consumer.wake();
    // Samples may already be waiting from before the renderer was ready.
    startLoop();
  }

  async function handleTessellate(message) {
    const samples = message.samples;
    const base = message.baseSize == null ? baseSize : message.baseSize;
    const dpr = size ? size.dpr : 1;
    let reply;
    try {
      if (!InkLab.GpuRenderer) throw new Error('WebGPU renderer not loaded');
      if (!tessellator) {
        tessellator = InkLab.GpuRenderer.create({ gpu: self.navigator.gpu });
        tessellator.onError(reportGpuError);
      }
      const result = await tessellator.tessellate(samples, base, dpr);
      reply = Object.assign({ backend: 'webgpu' }, result);
    } catch (error) {
      reply = {
        backend: 'none',
        reason: messageOf(error),
        dpr,
        jsWidths: samples.map((_, i) => InkLab.StrokeWidth.brushWidth(samples, i, base)),
      };
    }
    self.postMessage(Object.assign({ type: 'tessellate', id: message.id }, reply));
  }

  async function handleSnapshot(message) {
    const measured = initialised ? await renderer.snapshot() : { inked: 0, bbox: null };
    self.postMessage({
      type: 'snapshot',
      id: message.id,
      backend,
      fallbackReason,
      frames,
      overflow: consumer ? consumer.overflow() : 0,
      predictionSource,
      activeSamples: committed.length,
      finishedStrokes: finished.length,
      inked: measured.inked,
      bbox: measured.bbox,
    });
  }

  async function handle(message) {
    switch (message.type) {
      case 'init':
        await handleInit(message);
        break;
      case 'resize':
        size = { width: message.width, height: message.height, dpr: message.dpr };
        if (initialised) {
          renderer.resize(size, finished);
          redraw();
        }
        break;
      case 'clear':
        finished = [];
        if (initialised) {
          renderer.clear();
          redraw();
        }
        break;
      case 'replaceCanvas':
        await handleReplaceCanvas(message);
        break;
      case 'snapshot':
        await handleSnapshot(message);
        break;
      case 'tessellate':
        await handleTessellate(message);
        break;
      default:
        throw new Error(`Unknown message type: ${message.type}`);
    }
  }

  // Messages are handled strictly in order, even when a handler awaits, so a
  // snapshot can never observe a state older than a clear sent before it.
  let queue = Promise.resolve();
  self.onmessage = (event) => {
    queue = queue.then(() => handle(event.data)).catch(reportError);
  };
})();
