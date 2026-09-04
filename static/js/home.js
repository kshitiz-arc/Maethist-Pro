(function () {
  const root = document.documentElement;
  const header = document.querySelector("[data-home-header]");
  const themeToggle = document.getElementById("themeToggle");
  const heroCanvas = document.getElementById("heroCanvas");
  const demoCanvas = document.getElementById("demoCanvas");
  const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  function setTheme(theme) {
    const normalized = theme === "light" ? "light" : "dark";
    root.dataset.theme = normalized;
    try {
      localStorage.setItem("theme", normalized);
    } catch (error) {
      // Theme still applies for the current session.
    }
  }

  const themeOverlay = document.getElementById("themeTransition");
  let themeAnimating = false;

  function setOverlayColors(nextTheme) {
    if (nextTheme === "light") {
      themeOverlay.style.setProperty("--theme-c1", "#ffffff");
      themeOverlay.style.setProperty("--theme-c2", "#e8f4ff");
      themeOverlay.style.setProperty("--theme-c3", "#cde7ff");
    } else {
      themeOverlay.style.setProperty("--theme-c1", "#071821");
      themeOverlay.style.setProperty("--theme-c2", "#0b2733");
      themeOverlay.style.setProperty("--theme-c3", "#02070a");
    }
  }

  themeToggle?.addEventListener("click", () => {
    if (themeAnimating) return;

    const nextTheme = root.dataset.theme === "dark" ? "light" : "dark";

    themeToggle.classList.remove("theme-spin");
    void themeToggle.offsetWidth;
    themeToggle.classList.add("theme-spin");
    window.setTimeout(() => themeToggle.classList.remove("theme-spin"), 600);

    if (!themeOverlay || reduceMotion) {
      setTheme(nextTheme);
      return;
    }

    themeAnimating = true;

    const rect = themeToggle.getBoundingClientRect();
    themeOverlay.style.setProperty("--theme-x", `${rect.left + rect.width / 2}px`);
    themeOverlay.style.setProperty("--theme-y", `${rect.top + rect.height / 2}px`);
    setOverlayColors(nextTheme);

    themeOverlay.className = "";
    void themeOverlay.offsetWidth;
    themeOverlay.classList.add("theme-running");

    requestAnimationFrame(() => {
      themeOverlay.classList.add("theme-open");
    });

    window.setTimeout(() => setTheme(nextTheme), 350);
    window.setTimeout(() => themeOverlay.classList.add("theme-fade"), 950);
    window.setTimeout(() => {
      themeOverlay.className = "";
      themeAnimating = false;
    }, 1350);
  });

  function syncHeader() {
    header?.classList.toggle("is-scrolled", window.scrollY > 20);
  }

  syncHeader();
  window.addEventListener("scroll", syncHeader, { passive: true });

  const revealObserver = "IntersectionObserver" in window
    ? new IntersectionObserver((entries) => {
        entries.forEach((entry) => {
          if (entry.isIntersecting) {
            entry.target.classList.add("is-visible");
            revealObserver.unobserve(entry.target);
          }
        });
      }, { threshold: 0.18 })
    : null;

  document.querySelectorAll(".reveal").forEach((element) => {
    if (revealObserver) {
      revealObserver.observe(element);
    } else {
      element.classList.add("is-visible");
    }
  });

  document.querySelectorAll(".magnetic").forEach((element) => {
    element.addEventListener("mousemove", (event) => {
      if (reduceMotion) return;
      const rect = element.getBoundingClientRect();
      const dx = (event.clientX - rect.left - rect.width / 2) / rect.width;
      const dy = (event.clientY - rect.top - rect.height / 2) / rect.height;
      element.style.transform = `translate(${dx * 8}px, ${dy * 6 - 2}px)`;
    });

    element.addEventListener("mouseleave", () => {
      element.style.transform = "";
    });
  });

  function setupHeroCanvas() {
    if (!heroCanvas) return;

    const ctx = heroCanvas.getContext("2d");
    let width = 0;
    let height = 0;
    let dpr = 1;
    let pointer = { x: 0, y: 0, active: false };
    const trails = [];
    const strokes = [
      { x: 0.1, y: 0.76, w: 0.38, color: "cyan", offset: 0 },
      { x: 0.54, y: 0.4, w: 0.34, color: "white", offset: 0.35 },
      { x: 0.66, y: 0.72, w: 0.26, color: "yellow", offset: 0.7 }
    ];

    function resize() {
      dpr = Math.min(2, window.devicePixelRatio || 1);
      width = window.innerWidth;
      height = window.innerHeight;
      heroCanvas.width = Math.max(1, Math.round(width * dpr));
      heroCanvas.height = Math.max(1, Math.round(height * dpr));
      heroCanvas.style.width = `${width}px`;
      heroCanvas.style.height = `${height}px`;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    }

    function themeColor(name, alpha) {
      const light = root.dataset.theme === "light";
      const colors = {
        white: light ? `rgba(15,23,42,${alpha})` : `rgba(248,250,252,${alpha})`,
        cyan: `rgba(103,232,249,${alpha})`,
        yellow: `rgba(250,204,21,${alpha})`
      };
      return colors[name] || colors.white;
    }

    function drawStroke(stroke, time) {
      const startX = width * stroke.x;
      const startY = height * stroke.y;
      const span = width * stroke.w;
      const amp = 24 + Math.sin(time * 0.001 + stroke.offset) * 8;

      ctx.save();
      ctx.lineCap = "round";
      ctx.lineJoin = "round";
      ctx.lineWidth = stroke.color === "white" ? 14 : 7;
      ctx.strokeStyle = themeColor(stroke.color, stroke.color === "white" ? 0.28 : 0.32);
      ctx.beginPath();
      ctx.moveTo(startX, startY);
      for (let i = 1; i <= 5; i += 1) {
        const x = startX + (span / 5) * i;
        const y = startY + Math.sin(i * 1.35 + time * 0.0014 + stroke.offset * 6) * amp;
        ctx.lineTo(x, y);
      }
      ctx.stroke();
      ctx.restore();
    }

    function drawTrail(trail) {
      ctx.save();
      ctx.lineCap = "round";
      ctx.lineJoin = "round";
      ctx.lineWidth = trail.width;
      ctx.strokeStyle = trail.color;
      ctx.beginPath();
      ctx.moveTo(trail.points[0].x, trail.points[0].y);
      for (let i = 1; i < trail.points.length; i += 1) {
        ctx.lineTo(trail.points[i].x, trail.points[i].y);
      }
      ctx.stroke();
      ctx.restore();
    }

    function frame(time) {
      ctx.clearRect(0, 0, width, height);

      const light = root.dataset.theme === "light";
      ctx.fillStyle = light ? "rgba(15,23,42,0.04)" : "rgba(255,255,255,0.045)";
      const gap = 28;
      const drift = reduceMotion ? 0 : (time * 0.012) % gap;
      for (let x = -gap + drift; x < width + gap; x += gap) {
        for (let y = -gap + drift; y < height + gap; y += gap) {
          ctx.fillRect(Math.round(x), Math.round(y), 1, 1);
        }
      }

      strokes.forEach((stroke) => drawStroke(stroke, time));

      if (pointer.active) {
        const radius = 130;
        const gradient = ctx.createRadialGradient(pointer.x, pointer.y, 0, pointer.x, pointer.y, radius);
        gradient.addColorStop(0, light ? "rgba(90,90,255,0.16)" : "rgba(103,232,249,0.2)");
        gradient.addColorStop(1, "rgba(0,0,0,0)");
        ctx.fillStyle = gradient;
        ctx.beginPath();
        ctx.arc(pointer.x, pointer.y, radius, 0, Math.PI * 2);
        ctx.fill();
      }

      trails.forEach((trail) => {
        trail.life -= 0.012;
        trail.width = Math.max(1, trail.width * 0.993);
        trail.color = root.dataset.theme === "light"
          ? `rgba(15,23,42,${Math.max(0, trail.life * 0.28)})`
          : `rgba(248,250,252,${Math.max(0, trail.life * 0.4)})`;
        drawTrail(trail);
      });

      for (let i = trails.length - 1; i >= 0; i -= 1) {
        if (trails[i].life <= 0) trails.splice(i, 1);
      }

      if (!reduceMotion) requestAnimationFrame(frame);
    }

    function addTrail(x, y) {
      const last = trails[trails.length - 1];
      if (!last || last.points.length > 18 || last.life < 0.55) {
        trails.push({ life: 1, width: 3, color: "rgba(255,255,255,0.4)", points: [{ x, y }] });
      } else {
        last.points.push({ x, y });
      }
    }

    window.addEventListener("resize", resize);
    window.addEventListener("pointermove", (event) => {
      pointer = { x: event.clientX, y: event.clientY, active: true };
      addTrail(event.clientX, event.clientY);
    }, { passive: true });
    window.addEventListener("pointerleave", () => {
      pointer.active = false;
    });

    resize();
    requestAnimationFrame(frame);
  }

  function setupDemoCanvas() {
    if (!demoCanvas) return;

    const ctx = demoCanvas.getContext("2d");
    let dpr = 1;
    let currentTool = "ink";
    let drawing = false;
    let last = null;
    let autoTime = 0;

    function resize() {
      const rect = demoCanvas.getBoundingClientRect();
      dpr = Math.min(2, window.devicePixelRatio || 1);
      demoCanvas.width = Math.max(1, Math.round(rect.width * dpr));
      demoCanvas.height = Math.max(1, Math.round(rect.height * dpr));
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      drawBase();
    }

    function drawBase() {
      const rect = demoCanvas.getBoundingClientRect();
      ctx.clearRect(0, 0, rect.width, rect.height);
      ctx.save();
      ctx.globalAlpha = root.dataset.theme === "light" ? 0.18 : 0.22;
      ctx.lineWidth = 14;
      ctx.lineCap = "round";
      ctx.strokeStyle = root.dataset.theme === "light" ? "#0f172a" : "#ffffff";
      ctx.beginPath();
      ctx.moveTo(rect.width * 0.16, rect.height * 0.56);
      ctx.bezierCurveTo(rect.width * 0.28, rect.height * 0.24, rect.width * 0.38, rect.height * 0.78, rect.width * 0.5, rect.height * 0.45);
      ctx.bezierCurveTo(rect.width * 0.62, rect.height * 0.13, rect.width * 0.68, rect.height * 0.68, rect.width * 0.82, rect.height * 0.36);
      ctx.stroke();
      ctx.restore();
    }

    function point(event) {
      const rect = demoCanvas.getBoundingClientRect();
      return {
        x: event.clientX - rect.left,
        y: event.clientY - rect.top
      };
    }

    function toolStyle() {
      if (currentTool === "highlight") {
        return { color: "rgba(250,204,21,0.38)", width: 26, composite: "source-over" };
      }
      if (currentTool === "erase") {
        return { color: root.dataset.theme === "light" ? "rgba(255,255,255,0.95)" : "rgba(8,11,18,0.95)", width: 34, composite: "source-over" };
      }
      return { color: root.dataset.theme === "light" ? "rgba(15,23,42,0.9)" : "rgba(248,250,252,0.92)", width: 9, composite: "source-over" };
    }

    function strokeTo(next) {
      if (!last) {
        last = next;
        return;
      }
      const style = toolStyle();
      ctx.save();
      ctx.globalCompositeOperation = style.composite;
      ctx.lineCap = "round";
      ctx.lineJoin = "round";
      ctx.strokeStyle = style.color;
      ctx.lineWidth = style.width;
      ctx.beginPath();
      ctx.moveTo(last.x, last.y);
      ctx.lineTo(next.x, next.y);
      ctx.stroke();
      ctx.restore();
      last = next;
    }

    demoCanvas.addEventListener("pointerdown", (event) => {
      drawing = true;
      demoCanvas.setPointerCapture?.(event.pointerId);
      last = point(event);
    });

    demoCanvas.addEventListener("pointermove", (event) => {
      if (!drawing) return;
      strokeTo(point(event));
    });

    demoCanvas.addEventListener("pointerup", () => {
      drawing = false;
      last = null;
    });

    demoCanvas.addEventListener("pointercancel", () => {
      drawing = false;
      last = null;
    });

    document.querySelectorAll(".demo-tool").forEach((button) => {
      button.addEventListener("click", () => {
        currentTool = button.dataset.demoTool || "ink";
        document.querySelectorAll(".demo-tool").forEach((tool) => {
          tool.classList.toggle("active", tool === button);
        });
      });
    });

    function autoDraw() {
      if (!drawing && !reduceMotion) {
        const rect = demoCanvas.getBoundingClientRect();
        const x = rect.width * (0.18 + (autoTime % 1) * 0.58);
        const y = rect.height * (0.68 + Math.sin(autoTime * 6.2) * 0.05);
        const style = currentTool;
        currentTool = "ink";
        strokeTo({ x, y });
        currentTool = style;
        autoTime += 0.008;
        if (autoTime > 1) {
          autoTime = 0;
          last = null;
          window.setTimeout(drawBase, 320);
        }
      }
      requestAnimationFrame(autoDraw);
    }

    window.addEventListener("resize", resize);
    resize();
    requestAnimationFrame(autoDraw);
  }

  setupHeroCanvas();
  setupDemoCanvas();
})();
