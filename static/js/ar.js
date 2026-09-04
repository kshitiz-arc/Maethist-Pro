(function () {
  "use strict";

  var SMOOTH_FACTOR = 0.45;         
  var HANDS_CDN = "https://cdn.jsdelivr.net/npm/@mediapipe/hands@0.4/hands.js";

  var handsInstance = null;
  var prevGesture = "none";         
  var smoothPos = null;           
  var indicatorEl = null;           
  var frameLoopActive = false;

  function isDesktopDevice() {
    var hasFinePointer = window.matchMedia("(hover: hover) and (pointer: fine)").matches;
    var wideEnough = window.innerWidth >= 1024;
    return hasFinePointer && wideEnough;
  }

  async function startCamera() {
    var state = window.appState;
    var video = document.getElementById("arVideo");
    if (!video) return false;
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      alert("AR Inky needs camera support in this browser.");
      console.warn("AR Inky: getUserMedia not supported");
      return false;
    }

    try {
      var stream = await navigator.mediaDevices.getUserMedia({
        video: {
          facingMode: "user",
          width: { ideal: 1280 },
          height: { ideal: 720 },
        },
        audio: false,
      });

      video.srcObject = stream;
      state.arStream = stream;
      await video.play();
      return true;
    } catch (err) {
      console.error("AR Camera error:", err);
      if (err.name === "NotAllowedError") {
        alert("Camera permission denied. Please allow camera access to use AR Inky.");
      } else if (err.name === "NotFoundError") {
        alert("No camera found on this device.");
      } else {
        alert("Could not start camera: " + err.message);
      }
      return false;
    }
  }

  function stopCamera() {
    var state = window.appState;
    var video = document.getElementById("arVideo");

    if (state.arStream) {
      state.arStream.getTracks().forEach(function (t) { t.stop(); });
      state.arStream = null;
    }
    if (video) {
      video.srcObject = null;
    }
  }

  function loadScript(src) {
    return new Promise(function (resolve, reject) {
      if (document.querySelector('script[src="' + src + '"]')) {
        resolve();
        return;
      }
      var s = document.createElement("script");
      s.src = src;
      s.crossOrigin = "anonymous";
      s.onload = resolve;
      s.onerror = function () { reject(new Error("Failed to load " + src)); };
      document.head.appendChild(s);
    });
  }

  async function initHandTracking() {
    if (typeof window.Hands === "undefined") {
      try {
        await loadScript(HANDS_CDN);
      } catch (err) {
        console.error("AR Inky: Could not load MediaPipe Hands", err);
        alert("Could not load hand tracking library. Hand drawing won't be available, but you can still draw with the mouse.");
        return false;
      }
    }

    handsInstance = new window.Hands({
      locateFile: function (file) {
        return "https://cdn.jsdelivr.net/npm/@mediapipe/hands@0.4/" + file;
      },
    });

    handsInstance.setOptions({
      maxNumHands: 1,
      modelComplexity: 1,
      minDetectionConfidence: 0.7,
      minTrackingConfidence: 0.5,
    });

    handsInstance.onResults(onHandResults);

    var video = document.getElementById("arVideo");
    if (video && video.readyState >= 2) {
      try { await handsInstance.send({ image: video }); } catch (_) {}
    }

    return true;
  }

  function destroyHandTracking() {
    frameLoopActive = false;
    if (handsInstance) {
      handsInstance.close();
      handsInstance = null;
    }
    prevGesture = "none";
    smoothPos = null;
  }

  function startFrameLoop() {
    frameLoopActive = true;
    scheduleNextFrame();
  }

  function scheduleNextFrame() {
    if (!frameLoopActive || !window.appState.arMode) return;
    requestAnimationFrame(processFrame);
  }

  async function processFrame() {
    if (!frameLoopActive || !window.appState.arMode || !handsInstance) return;

    var video = document.getElementById("arVideo");
    if (!video || video.readyState < 2) {
      scheduleNextFrame();
      return;
    }

    try {
      await handsInstance.send({ image: video });
    } catch (err) {
      console.warn("Hand tracking frame error:", err);
    }
  }

  function isFingerExtended(landmarks, tipIdx, pipIdx) {
    return landmarks[tipIdx].y < landmarks[pipIdx].y;
  }

  function detectGesture(landmarks) {
    var indexUp  = isFingerExtended(landmarks, 8, 6);
    var middleUp = isFingerExtended(landmarks, 12, 10);
    var ringUp   = isFingerExtended(landmarks, 16, 14);
    var pinkyUp  = isFingerExtended(landmarks, 20, 18);

    if (indexUp && middleUp && ringUp && pinkyUp) return "palm";
    // One raised index finger is treated as the drawing gesture.
    var curledCount = (!middleUp ? 1 : 0) + (!ringUp ? 1 : 0) + (!pinkyUp ? 1 : 0);
    if (indexUp && curledCount >= 2) return "pointing";

    return "other";
  }


  function onHandResults(results) {
    var state = window.appState;
    if (!state.arMode) return;

    if (!results.multiHandLandmarks || results.multiHandLandmarks.length === 0) {
      if (prevGesture === "pointing") endHandDrawing();
      prevGesture = "none";
      hideIndicator();
      scheduleNextFrame();
      return;
    }

    var landmarks = results.multiHandLandmarks[0];
    var gesture = detectGesture(landmarks);

    var raw = landmarks[8];
    var metrics = typeof window.getCanvasMetrics === "function" ? window.getCanvasMetrics() : null;
    var rect = metrics && metrics.rect ? metrics.rect : { left: 0, top: 0, width: window.innerWidth, height: window.innerHeight };
    var screenX = rect.left + (1 - raw.x) * rect.width;
    var screenY = rect.top + raw.y * rect.height;

    if (!smoothPos) {
      smoothPos = { x: screenX, y: screenY };
    } else {
      smoothPos.x = smoothPos.x * SMOOTH_FACTOR + screenX * (1 - SMOOTH_FACTOR);
      smoothPos.y = smoothPos.y * SMOOTH_FACTOR + screenY * (1 - SMOOTH_FACTOR);
    }

    showIndicator(smoothPos.x, smoothPos.y, gesture);

    if (gesture === "pointing") {
      if (prevGesture !== "pointing") {
        startHandDrawing(smoothPos);
      } else {
        continueHandDrawing(smoothPos);
      }
    } else {
      if (prevGesture === "pointing") {
        endHandDrawing();
      }
    }

    prevGesture = gesture;
    scheduleNextFrame();
  }

  function smartGeometryApi() {
    return window.Inkyscib?.SmartGeometry || null;
  }

  function isSmartShapePath(path) {
    if (!path || path.tool !== "shape") return false;
    var geometry = smartGeometryApi();
    if (geometry?.isSmartGeometry?.(path)) return true;
    return Number(path.geometryVersion) === 1 &&
      typeof path.geometryKind === "string" &&
      path.geometryKind === path.shapeType;
  }

  function updateSmartShapeDraft(path, point) {
    var geometry = smartGeometryApi();
    if (geometry?.updateShapeDraft) return geometry.updateShapeDraft(path, point);
    if (geometry?.isSmartCircle?.(path) && geometry.updateCircleDraft) {
      return geometry.updateCircleDraft(path, point);
    }
    return false;
  }

  function finalizeSmartShape(path) {
    var geometry = smartGeometryApi();
    if (geometry?.finalizeSmartShape) return geometry.finalizeSmartShape(path);
    if (geometry?.isSmartCircle?.(path) && geometry.finalizeCircle) {
      return geometry.finalizeCircle(path);
    }
    return false;
  }

  function isMeaningfulSmartShape(path) {
    var geometry = smartGeometryApi();
    if (geometry?.isMeaningfulShape) return geometry.isMeaningfulShape(path);
    if (geometry?.isSmartCircle?.(path) && geometry.circleRadius) {
      return geometry.circleRadius(path) >= 4;
    }
    return Array.isArray(path?.points) && path.points.length >= 3;
  }

  function startHandDrawing(pos) {
    var state = window.appState;
    var worldPos = typeof window.clientPointToWorld === "function"
      ? window.clientPointToWorld(pos.x, pos.y)
      : { x: pos.x, y: pos.y };

    state.handPath = window.createPath
      ? window.createPath(worldPos)
      : {
          tool: state.currentTool,
          size: (state.toolSettings[state.currentTool] || {}).size || 2,
          color: state.currentTool === "eraser" ? null : ((state.toolSettings[state.currentTool] || {}).color || "#ffffff"),
          points: [worldPos],
          timestamp: Date.now(),
        };

    if (typeof window.render === "function") window.render();
  }

  function continueHandDrawing(pos) {
    var state = window.appState;
    if (!state.handPath) return;

    var worldPos = typeof window.clientPointToWorld === "function"
      ? window.clientPointToWorld(pos.x, pos.y)
      : { x: pos.x, y: pos.y };

    if (state.handPath.tool === "shape" || state.handPath.tool === "line") {
      if (isSmartShapePath(state.handPath)) {
        updateSmartShapeDraft(state.handPath, worldPos);
      } else {
        state.handPath.points[1] = worldPos;
      }
    } else {
      state.handPath.points.push(worldPos);
    }

    if (typeof window.render === "function") window.render();
  }

  function endHandDrawing() {
    var state = window.appState;
    if (!state.handPath) return;

    var smartShape = isSmartShapePath(state.handPath);
    if (smartShape) {
      finalizeSmartShape(state.handPath);
    } else if (state.handPath.tool === "shape" && state.handPath.points.length === 2) {
      var p1 = state.handPath.points[0];
      var p2 = state.handPath.points[1];
      state.handPath.width = Math.abs(p2.x - p1.x);
      state.handPath.height = Math.abs(p2.y - p1.y);
      state.handPath.centerX = (p1.x + p2.x) / 2;
      state.handPath.centerY = (p1.y + p2.y) / 2;
    }

    var isLineOrShape = state.handPath.tool === "line" || state.handPath.tool === "shape";
    var meaningful = smartShape
      ? isMeaningfulSmartShape(state.handPath)
      : isLineOrShape
        ? state.handPath.points.length === 2
        : state.handPath.points.length > 1;

    var createdPath = null;
    var createdIndex = -1;
    if (meaningful) {
      if (typeof window.commitHistory === "function") window.commitHistory();
      else state.redoStack = [];
      state.paths.push(state.handPath);
      createdPath = state.handPath;
      createdIndex = state.paths.length - 1;
    }

    state.handPath = null;

    if (typeof window.render === "function") window.render();
    if (typeof window.saveDrawing === "function") window.saveDrawing();
    if (createdPath && smartGeometryApi()?.afterPathCreated) {
      smartGeometryApi().afterPathCreated(createdPath, createdIndex);
    }
  }

  function createIndicator() {
    if (indicatorEl) return;
    indicatorEl = document.createElement("div");
    indicatorEl.id = "arFingerIndicator";
    indicatorEl.style.cssText =
      "position:fixed;width:18px;height:18px;border-radius:50%;" +
      "pointer-events:none;z-index:9999;transform:translate(-50%,-50%);" +
      "transition:background 0.15s;box-shadow:0 0 10px rgba(0,0,0,0.5);" +
      "display:none;";
    document.body.appendChild(indicatorEl);
  }

  function showIndicator(x, y, gesture) {
    if (!indicatorEl) createIndicator();
    indicatorEl.style.display = "block";
    indicatorEl.style.left = x + "px";
    indicatorEl.style.top = y + "px";

    if (gesture === "pointing") {
      indicatorEl.style.background = "#00ff88";
      indicatorEl.style.boxShadow = "0 0 12px rgba(0,255,136,0.7)";
    } else {
      indicatorEl.style.background = "rgba(255,255,255,0.5)";
      indicatorEl.style.boxShadow = "0 0 8px rgba(255,255,255,0.3)";
    }
  }

  function hideIndicator() {
    if (indicatorEl) indicatorEl.style.display = "none";
  }

  function removeIndicator() {
    if (indicatorEl) {
      indicatorEl.remove();
      indicatorEl = null;
    }
  }

  async function enterAR() {
    var state = window.appState;
    var video = document.getElementById("arVideo");
    var patternCanvas = document.getElementById("patternCanvas");
    var arBtn = document.getElementById("arBtn");

    if (arBtn) {
      arBtn.classList.add("loading");
      var span = arBtn.querySelector("span");
      if (span) span.textContent = "Loading...";
    }

    state._savedTransform = {
      scale: state.transform.scale,
      offsetX: state.transform.offsetX,
      offsetY: state.transform.offsetY,
    };

    state.transform.scale = 1;
    state.transform.offsetX = 0;
    state.transform.offsetY = 0;

    var camOK = await startCamera();
    if (!camOK) {
      state.transform.scale = state._savedTransform.scale;
      state.transform.offsetX = state._savedTransform.offsetX;
      state.transform.offsetY = state._savedTransform.offsetY;
      delete state._savedTransform;
      if (arBtn) {
        arBtn.classList.remove("loading");
        var s = arBtn.querySelector("span");
        if (s) s.textContent = "AR Inky";
      }
      return;
    }

    var handOK = await initHandTracking();

    state.arMode = true;

    video.classList.add("active");
    patternCanvas.style.display = "none";
    document.body.classList.add("ar-active");

    if (arBtn) {
      arBtn.classList.remove("loading");
      arBtn.classList.add("active");
      var sp = arBtn.querySelector("span");
      if (sp) sp.textContent = "Exit AR";
    }

    if (state.panMode && typeof window.setPanMode === "function") {
      window.setPanMode(false);
    }

    if (typeof window.render === "function") window.render();

    if (typeof closeMenu === "function") closeMenu();

    if (handOK) {
      startFrameLoop();
    }
  }

  function exitAR() {
    var state = window.appState;
    var video = document.getElementById("arVideo");
    var patternCanvas = document.getElementById("patternCanvas");
    var arBtn = document.getElementById("arBtn");

    if (state.handPath) {
      endHandDrawing();
    }

    destroyHandTracking();
    stopCamera();
    state.arMode = false;

    video.classList.remove("active");
    patternCanvas.style.display = "";
    document.body.classList.remove("ar-active");

    if (state._savedTransform) {
      state.transform.scale = state._savedTransform.scale;
      state.transform.offsetX = state._savedTransform.offsetX;
      state.transform.offsetY = state._savedTransform.offsetY;
      delete state._savedTransform;
    }

    if (arBtn) {
      arBtn.classList.remove("active");
      var span = arBtn.querySelector("span");
      if (span) span.textContent = "AR Inky";
    }

    removeIndicator();

    if (typeof window.render === "function") window.render();
  }

  async function toggleAR() {
    var state = window.appState;
    if (state.arMode) {
      exitAR();
    } else {
      await enterAR();
    }
  }

  function initAR() {
    var arBtn = document.getElementById("arBtn");

    if (arBtn) {
      arBtn.addEventListener("click", toggleAR);
    }
  }

  document.addEventListener("DOMContentLoaded", initAR);

  window.addEventListener("beforeunload", function () {
    if (window.appState && window.appState.arMode) {
      destroyHandTracking();
      stopCamera();
    }
  });

  window.Inkyscib = window.Inkyscib || {};
  window.Inkyscib.AR = { toggleAR: toggleAR, enterAR: enterAR, exitAR: exitAR, isDesktopDevice: isDesktopDevice };
})();

