// AR MAETHIST: draw in the air over what the camera sees.
//
// The camera picture never leaves the device: MediaPipe Hands runs in this
// page (WebAssembly) and only the fingertip position is used. The library and
// its model are fetched from jsDelivr when AR starts, which the privacy
// policy lists; nothing is fetched until then.
//
// Pinch your thumb and index finger together to put the pen down, open them
// to lift it. A pinch is far steadier than "index finger up", which drew a
// line every time you moved your hand to start somewhere new.
(function () {
  "use strict";

  function notify(message, tone) {
    if (window.Inkyscib && window.Inkyscib.notify) window.Inkyscib.notify(message, { tone: tone || "error" });
  }

  var NAME = "AR MAETHIST";
  // Pinned, so the code that runs is the code that was tested.
  var HANDS_VERSION = "0.4.1675469240";
  var HANDS_BASE = "https://cdn.jsdelivr.net/npm/@mediapipe/hands@" + HANDS_VERSION + "/";
  // Pen down below this thumb-to-index gap (as a share of the hand's size),
  // up above the second: the gap between the two stops a pinch held at the
  // edge from flickering the pen up and down.
  var PINCH_DOWN = 0.32;
  var PINCH_UP = 0.46;

  var hands = null;
  var hud = null;
  var cursor = null;
  var entering = false;
  var sending = false;
  var looping = false;
  var penDown = false;
  var lostFrames = 0;
  var filterX = null;
  var filterY = null;

  function state() { return window.appState; }

  // ---------- the One Euro filter ----------
  // Smooths hard when the hand is still (no jitter) and barely at all when
  // it moves fast (no lag): a fixed average had to choose one.
  function OneEuro(minCutoff, beta) {
    this.minCutoff = minCutoff;
    this.beta = beta;
    this.x = null;
    this.dx = 0;
    this.t = 0;
  }
  OneEuro.prototype.alpha = function (cutoff, dt) {
    var tau = 1 / (2 * Math.PI * cutoff);
    return 1 / (1 + tau / dt);
  };
  OneEuro.prototype.filter = function (value, t) {
    if (this.x === null) {
      this.x = value;
      this.t = t;
      return value;
    }
    var dt = Math.max(1e-3, (t - this.t) / 1000);
    this.t = t;
    var dx = (value - this.x) / dt;
    this.dx += this.alpha(1, dt) * (dx - this.dx);
    var cutoff = this.minCutoff + this.beta * Math.abs(this.dx);
    this.x += this.alpha(cutoff, dt) * (value - this.x);
    return this.x;
  };

  // ---------- camera ----------

  async function startCamera() {
    var video = document.getElementById("arVideo");
    if (!video) return false;
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      notify(NAME + " needs a browser that can use the camera.");
      return false;
    }
    try {
      var stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: "user", width: { ideal: 1280 }, height: { ideal: 720 } },
        audio: false
      });
      video.srcObject = stream;
      state().arStream = stream;
      await video.play();
      return true;
    } catch (err) {
      if (err && err.name === "NotAllowedError") {
        notify("Camera access was blocked. Allow the camera for this site to use " + NAME + ".");
      } else if (err && err.name === "NotFoundError") {
        notify("No camera was found on this device.");
      } else {
        notify("The camera could not start" + (err && err.message ? ": " + err.message : "."));
      }
      return false;
    }
  }

  function stopCamera() {
    var video = document.getElementById("arVideo");
    var s = state();
    if (s && s.arStream) {
      s.arStream.getTracks().forEach(function (t) { t.stop(); });
      s.arStream = null;
    }
    if (video) video.srcObject = null;
  }

  // ---------- hand tracking ----------

  function loadScript(src) {
    return new Promise(function (resolve, reject) {
      if (window.Hands) return resolve();
      var existing = document.querySelector('script[src="' + src + '"]');
      if (existing) {
        existing.addEventListener("load", function () { resolve(); }, { once: true });
        existing.addEventListener("error", function () { reject(new Error("Failed to load " + src)); }, { once: true });
        return;
      }
      var s = document.createElement("script");
      s.src = src;
      s.crossOrigin = "anonymous";
      s.onload = function () { resolve(); };
      s.onerror = function () { s.remove(); reject(new Error("Failed to load " + src)); };
      document.head.appendChild(s);
    });
  }

  async function startTracking() {
    try {
      await loadScript(HANDS_BASE + "hands.js");
    } catch (_) {
      notify("Hand tracking could not load (it needs a connection the first time). The camera is on, but drawing in the air is off.");
      return false;
    }
    hands = new window.Hands({ locateFile: function (file) { return HANDS_BASE + file; } });
    var desktop = window.matchMedia("(pointer: fine)").matches && window.innerWidth >= 1024;
    hands.setOptions({
      maxNumHands: 1,
      // The full model on a laptop; the lite one on a tablet, where the full
      // one cannot keep up with the camera.
      modelComplexity: desktop ? 1 : 0,
      minDetectionConfidence: 0.7,
      minTrackingConfidence: 0.55
    });
    hands.onResults(onResults);
    return true;
  }

  function stopTracking() {
    looping = false;
    if (hands) {
      try { hands.close(); } catch (_) { /* already closed */ }
      hands = null;
    }
    penDown = false;
    filterX = filterY = null;
  }

  // One frame in flight at a time, and the next is always scheduled, even
  // after a frame that failed: the old loop only rescheduled from the
  // results callback, so one dropped frame stopped tracking for good.
  function loop() {
    if (!looping) return;
    var video = document.getElementById("arVideo");
    var next = function () {
      if (!looping) return;
      if (video && typeof video.requestVideoFrameCallback === "function") video.requestVideoFrameCallback(loop);
      else window.requestAnimationFrame(loop);
    };
    if (!hands || sending || !video || video.readyState < 2 || document.hidden) return next();
    sending = true;
    hands.send({ image: video })
      .catch(function () { /* a dropped frame; the next one carries on */ })
      .then(function () { sending = false; next(); });
  }

  // ---------- reading the hand ----------

  function dist(a, b) { return Math.hypot(a.x - b.x, a.y - b.y); }

  // Where a point of the camera picture lands on screen. The video fills the
  // screen with object-fit: cover, so part of it is cropped away; mapping the
  // picture's 0..1 straight onto the screen put the dot beside the finger.
  // It is also mirrored, so moving right moves right.
  function toScreen(point) {
    var video = document.getElementById("arVideo");
    var rect = video.getBoundingClientRect();
    var vw = video.videoWidth || 16;
    var vh = video.videoHeight || 9;
    var k = Math.max(rect.width / vw, rect.height / vh);
    var dw = vw * k;
    var dh = vh * k;
    return {
      x: rect.left + (rect.width - dw) / 2 + (1 - point.x) * dw,
      y: rect.top + (rect.height - dh) / 2 + point.y * dh
    };
  }

  function onResults(results) {
    if (!state() || !state().arMode) return;
    var hand = results.multiHandLandmarks && results.multiHandLandmarks[0];
    if (!hand) {
      // A frame or two without a hand is the tracker blinking, not the hand
      // leaving; lift the pen only when it has really gone.
      lostFrames += 1;
      if (lostFrames > 4) {
        if (penDown) liftPen();
        hideCursor();
        setStatus("Show your hand to the camera", "idle");
      }
      return;
    }
    lostFrames = 0;
    var size = Math.max(1e-3, dist(hand[0], hand[9]));
    var gap = dist(hand[4], hand[8]) / size;
    var tip = { x: (hand[4].x + hand[8].x) / 2, y: (hand[4].y + hand[8].y) / 2 };
    var screen = toScreen(tip);
    var now = performance.now();
    if (!filterX) {
      filterX = new OneEuro(1.4, 0.015);
      filterY = new OneEuro(1.4, 0.015);
    }
    var at = { x: filterX.filter(screen.x, now), y: filterY.filter(screen.y, now) };

    if (!penDown && gap < PINCH_DOWN) {
      penDown = true;
      putPenDown(at);
    } else if (penDown && gap > PINCH_UP) {
      liftPen();
    } else if (penDown) {
      movePen(at);
    }
    showCursor(at, penDown);
    setStatus(penDown ? "Drawing. Open your fingers to lift the pen" : "Pinch thumb and finger to draw", penDown ? "drawing" : "ready");
  }

  // ---------- drawing ----------

  function world(at) {
    return typeof window.clientPointToWorld === "function" ? window.clientPointToWorld(at.x, at.y) : { x: at.x, y: at.y };
  }

  function putPenDown(at) {
    var s = state();
    var p = world(at);
    s.handPath = typeof window.createPath === "function" ? window.createPath(p) : {
      tool: s.currentTool,
      size: (s.toolSettings[s.currentTool] || {}).size || 2,
      color: (s.toolSettings[s.currentTool] || {}).color || "#ffffff",
      points: [p],
      timestamp: Date.now()
    };
    if (typeof window.render === "function") window.render();
  }

  function movePen(at) {
    var s = state();
    if (!s.handPath) return;
    var p = world(at);
    if (s.handPath.tool === "line" || s.handPath.tool === "shape") s.handPath.points[1] = p;
    else s.handPath.points.push(p);
    if (typeof window.render === "function") window.render();
  }

  function liftPen() {
    penDown = false;
    var s = state();
    var path = s && s.handPath;
    if (!path) return;
    s.handPath = null;
    var straight = path.tool === "line" || path.tool === "shape";
    if (straight ? path.points.length === 2 : path.points.length > 1) {
      if (path.tool === "shape" && path.points.length === 2) {
        var a = path.points[0];
        var b = path.points[1];
        path.width = Math.abs(b.x - a.x);
        path.height = Math.abs(b.y - a.y);
        path.centerX = (a.x + b.x) / 2;
        path.centerY = (a.y + b.y) / 2;
      }
      if (typeof window.commitHistory === "function") window.commitHistory();
      s.paths.push(path);
      if (typeof window.saveDrawing === "function") window.saveDrawing();
    }
    if (typeof window.render === "function") window.render();
  }

  // ---------- on screen ----------

  function icon(ref) {
    try { return (window.Inkyscib && window.Inkyscib.Icon && window.Inkyscib.Icon.svg(ref)) || ""; } catch (_) { return ""; }
  }

  function buildHud() {
    hud = document.createElement("div");
    hud.className = "ar-hud";
    hud.id = "arHud";
    hud.dataset.iconSet = "lucide";
    hud.setAttribute("role", "toolbar");
    hud.setAttribute("aria-label", NAME);
    hud.innerHTML =
      '<span class="ar-hud-name">' + icon("lucide:camera") + "<b>" + NAME + "</b></span>" +
      '<span class="ar-hud-status" role="status" aria-live="polite"><i class="ar-hud-dot" aria-hidden="true"></i><span class="ar-hud-text">Starting the camera…</span></span>' +
      '<button type="button" class="ar-hud-btn" data-ar="undo" aria-label="Undo">' + icon("lucide:undo-2") + "</button>" +
      '<button type="button" class="ar-hud-btn" data-ar="dim" aria-pressed="false" title="Dim the camera picture" aria-label="Dim the camera picture">' + icon("lucide:sun-dim") + "</button>" +
      '<button type="button" class="ar-hud-btn ar-hud-exit" data-ar="exit">' + icon("lucide:x") + "<span>Exit</span></button>";
    document.body.appendChild(hud);
    hud.addEventListener("click", function (event) {
      var button = event.target.closest("[data-ar]");
      if (!button) return;
      var act = button.dataset.ar;
      if (act === "exit") exitAR();
      else if (act === "undo") { if (penDown) liftPen(); if (typeof window.undo === "function") window.undo(); }
      else if (act === "dim") {
        var on = !document.body.classList.contains("ar-dim");
        document.body.classList.toggle("ar-dim", on);
        button.setAttribute("aria-pressed", String(on));
      }
    });
  }

  function placeHud() {
    var below = 12;
    document.querySelectorAll(".file-ribbon, .toolbar").forEach(function (el) {
      var r = el.getBoundingClientRect();
      if (r.width && r.height && r.top < window.innerHeight * 0.4) below = Math.max(below, r.bottom + 10);
    });
    hud.style.top = Math.round(below) + "px";
  }

  function setStatus(text, tone) {
    if (!hud) return;
    var label = hud.querySelector(".ar-hud-text");
    if (label.textContent !== text) label.textContent = text;
    hud.dataset.tone = tone || "idle";
  }

  function showCursor(at, down) {
    if (!cursor) {
      cursor = document.createElement("div");
      cursor.className = "ar-cursor";
      cursor.id = "arFingerIndicator";
      document.body.appendChild(cursor);
    }
    var s = state();
    var colour = (s && s.toolSettings && s.toolSettings.pen && s.toolSettings.pen.color) || "#ffffff";
    cursor.style.setProperty("--ar-ink", colour);
    cursor.style.transform = "translate(" + at.x + "px, " + at.y + "px)";
    cursor.classList.toggle("is-down", down);
    cursor.hidden = false;
  }

  function hideCursor() { if (cursor) cursor.hidden = true; }

  function onKey(event) {
    if (event.key === "Escape" && state() && state().arMode) {
      event.stopPropagation();
      exitAR();
    }
  }

  // ---------- entering and leaving ----------

  async function enterAR() {
    var s = state();
    if (!s || s.arMode || entering) return;
    entering = true;
    if (!hud) buildHud();
    hud.hidden = false;
    placeHud();
    setStatus("Starting the camera…", "idle");

    s._savedTransform = { scale: s.transform.scale, offsetX: s.transform.offsetX, offsetY: s.transform.offsetY };
    var ok = await startCamera();
    if (!ok) {
      delete s._savedTransform;
      hud.hidden = true;
      entering = false;
      return;
    }
    // The page is drawn at 1:1 over the camera, so a stroke lands where the
    // finger was; the view comes back on exit.
    s.transform.scale = 1;
    s.transform.offsetX = 0;
    s.transform.offsetY = 0;
    s.arMode = true;
    if (s.panMode && typeof window.setPanMode === "function") window.setPanMode(false);
    document.getElementById("arVideo").classList.add("active");
    var pattern = document.getElementById("patternCanvas");
    if (pattern) pattern.style.display = "none";
    document.body.classList.add("ar-active");
    document.addEventListener("keydown", onKey, true);
    if (typeof window.render === "function") window.render();

    setStatus("Loading hand tracking…", "idle");
    var tracking = await startTracking();
    entering = false;
    if (!state().arMode) return; // exited while loading
    if (tracking) {
      setStatus("Show your hand to the camera", "idle");
      looping = true;
      loop();
    } else {
      setStatus("Hand tracking is off. Draw with the pen as usual", "error");
    }
  }

  function exitAR() {
    var s = state();
    if (!s) return;
    if (penDown) liftPen();
    stopTracking();
    stopCamera();
    s.arMode = false;
    entering = false;
    var video = document.getElementById("arVideo");
    if (video) video.classList.remove("active");
    var pattern = document.getElementById("patternCanvas");
    if (pattern) pattern.style.display = "";
    document.body.classList.remove("ar-active", "ar-dim");
    document.removeEventListener("keydown", onKey, true);
    if (s._savedTransform) {
      s.transform.scale = s._savedTransform.scale;
      s.transform.offsetX = s._savedTransform.offsetX;
      s.transform.offsetY = s._savedTransform.offsetY;
      delete s._savedTransform;
    }
    if (hud) hud.hidden = true;
    if (cursor) { cursor.remove(); cursor = null; }
    if (typeof window.render === "function") window.render();
  }

  function toggleAR() {
    var s = state();
    if (s && (s.arMode || entering)) exitAR();
    else return enterAR();
  }

  document.addEventListener("DOMContentLoaded", function () {
    var button = document.getElementById("arBtn");
    if (button) button.addEventListener("click", toggleAR);
  });
  document.addEventListener("visibilitychange", function () {
    // A hidden tab keeps the camera light on for nothing; the pen lifts.
    if (document.hidden && penDown) liftPen();
  });
  window.addEventListener("pagehide", function () { if (state() && state().arMode) exitAR(); });

  window.Inkyscib = window.Inkyscib || {};
  window.Inkyscib.AR = {
    toggleAR: toggleAR,
    enterAR: enterAR,
    exitAR: exitAR,
    // For tests: feed a hand as MediaPipe would report it.
    _results: onResults,
    _toScreen: toScreen,
    PINCH_DOWN: PINCH_DOWN,
    PINCH_UP: PINCH_UP
  };
})();
