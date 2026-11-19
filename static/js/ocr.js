// Image to text: box handwriting on the page (or pick a photo) and get it back
// as LaTeX or text, read on this server (ocr_engine.py, /api/ocr).
//
// Start it from Tools > Image to text, or from "To text" on a selected
// picture. Drag a box around the writing; what is inside the box is sent,
// exactly as it looks (the page colour and the ink). The result opens in a
// sheet where it can be corrected, copied, switched between Equation and
// Text, or placed back on the page as a clean typeset card.
(() => {
  "use strict";

  const state = () => window.appState;
  const icon = (ref) => {
    try { return window.Inkyscib?.Icon?.svg?.(ref) || ""; } catch (_) { return ""; }
  };
  const notify = (message, tone) => window.Inkyscib?.notify?.(message, { tone: tone || "success" });

  let overlay = null;
  let sheet = null;
  let lastImage = null;
  let kind = "math";
  let busy = false;

  // ---------- capturing a region ----------

  function start() {
    if (!overlay) buildOverlay();
    overlay.hidden = false;
    document.body.classList.add("ocr-capturing");
    overlay.querySelector(".ocr-hint-text").textContent = "Drag a box around the writing";
    placeHint();
    checkServer();
  }

  // The bar sits just under the editor's own bars, where the eye already is:
  // at the bottom it hid behind a tablet's dock and the browser's own bar.
  function placeHint() {
    let below = 12;
    document.querySelectorAll(".file-ribbon, .toolbar, .tool-dock").forEach((el) => {
      const r = el.getBoundingClientRect();
      if (r.width && r.height && r.top < window.innerHeight * 0.4) below = Math.max(below, r.bottom + 12);
    });
    const hint = overlay.querySelector(".ocr-hint");
    hint.style.top = Math.round(below) + "px";
    hint.classList.remove("is-in");
    void hint.offsetWidth;
    hint.classList.add("is-in");
  }

  // The readers are optional on a server (requirements-ocr.txt), so ask once
  // whether this one has them, and say so on opening rather than after a box
  // has been drawn. Offline, or with no answer, the attempt reports instead.
  let available = null;
  function checkServer() {
    if (available !== null) return applyAvailability();
    fetch("/api/ocr/status")
      .then((response) => response.json())
      .then((body) => {
        available = !!body?.available;
        applyAvailability();
      })
      .catch(() => {});
  }

  function applyAvailability() {
    if (!overlay) return;
    overlay.classList.toggle("is-unavailable", available === false);
    if (available === false && !overlay.hidden) {
      overlay.querySelector(".ocr-hint-text").textContent = "Image to text is not set up on this server yet";
    }
  }

  function stopCapture() {
    if (!overlay) return;
    overlay.hidden = true;
    document.body.classList.remove("ocr-capturing");
    overlay.querySelector(".ocr-box").hidden = true;
  }

  function buildOverlay() {
    overlay = document.createElement("div");
    overlay.className = "ocr-overlay";
    overlay.id = "ocrOverlay";
    overlay.dataset.iconSet = "lucide";
    overlay.hidden = true;
    overlay.innerHTML = `
      <div class="ocr-box" hidden></div>
      <div class="ocr-hint" role="status">
        ${icon("lucide:scan-text")}<span class="ocr-hint-text">Drag a box around the writing</span>
        <label class="ocr-upload">${icon("lucide:upload")}<span>Or pick a photo</span><input type="file" accept="image/*" hidden></label>
        <button type="button" class="ocr-cancel" aria-label="Cancel">${icon("lucide:x")}</button>
      </div>`;
    document.body.appendChild(overlay);

    const box = overlay.querySelector(".ocr-box");
    let drag = null;
    overlay.addEventListener("pointerdown", (event) => {
      if (event.target.closest(".ocr-hint")) return;
      event.preventDefault();
      if (available === false) return;
      overlay.setPointerCapture?.(event.pointerId);
      drag = { x: event.clientX, y: event.clientY };
      box.hidden = false;
      setBox(box, drag.x, drag.y, drag.x, drag.y);
    });
    overlay.addEventListener("pointermove", (event) => {
      if (drag) setBox(box, drag.x, drag.y, event.clientX, event.clientY);
    });
    overlay.addEventListener("pointerup", (event) => {
      if (!drag) return;
      const rect = normRect(drag.x, drag.y, event.clientX, event.clientY);
      drag = null;
      if (rect.w < 12 || rect.h < 12) {
        box.hidden = true;
        return;
      }
      const crop = cropCanvas(rect);
      if (crop?.blank) {
        box.hidden = true;
        overlay.querySelector(".ocr-hint-text").textContent = "Nothing is written in that box. Try again around the ink";
        return;
      }
      stopCapture();
      if (crop) convert(crop.image);
    });
    overlay.querySelector(".ocr-cancel").addEventListener("click", stopCapture);
    overlay.querySelector('input[type="file"]').addEventListener("change", (event) => {
      const file = event.target.files?.[0];
      event.target.value = "";
      if (!file) return;
      const reader = new FileReader();
      reader.onload = () => {
        stopCapture();
        convert(String(reader.result));
      };
      reader.readAsDataURL(file);
    });
    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape" && overlay && !overlay.hidden) {
        event.stopPropagation();
        stopCapture();
      }
    }, true);
  }

  function normRect(x1, y1, x2, y2) {
    return { x: Math.min(x1, x2), y: Math.min(y1, y2), w: Math.abs(x2 - x1), h: Math.abs(y2 - y1) };
  }

  function setBox(box, x1, y1, x2, y2) {
    const r = normRect(x1, y1, x2, y2);
    Object.assign(box.style, { left: r.x + "px", top: r.y + "px", width: r.w + "px", height: r.h + "px" });
  }

  // What is inside the box: the page's own colour and the ink on top. Never
  // the dot grid or ruled lines, which a reader takes for strokes.
  function cropCanvas(rect) {
    const ink = document.getElementById("drawingCanvas");
    if (!ink) return null;
    const bounds = ink.getBoundingClientRect();
    const k = ink.width / Math.max(1, bounds.width);
    const sx = Math.max(0, (rect.x - bounds.left) * k);
    const sy = Math.max(0, (rect.y - bounds.top) * k);
    const sw = Math.min(ink.width - sx, rect.w * k);
    const sh = Math.min(ink.height - sy, rect.h * k);
    if (sw < 4 || sh < 4) return null;
    if (!inkInside(ink, sx, sy, sw, sh)) return { blank: true };
    const out = document.createElement("canvas");
    out.width = Math.round(sw);
    out.height = Math.round(sh);
    const g = out.getContext("2d");
    const pattern = document.getElementById("patternCanvas");
    const page = getComputedStyle(pattern || ink.parentElement || document.body).backgroundColor;
    g.fillStyle = page && page !== "rgba(0, 0, 0, 0)" ? page
      : (document.documentElement.dataset.theme === "light" ? "#ffffff" : "#10131c");
    g.fillRect(0, 0, out.width, out.height);
    g.drawImage(ink, sx, sy, sw, sh, 0, 0, out.width, out.height);
    return { image: out.toDataURL("image/png") };
  }

  // Whether the box holds any ink. The ink layer is transparent where
  // nothing is drawn, so an empty box is caught here instead of being sent
  // (the equation reader answers a blank picture with nonsense). When the
  // layer cannot be read, the server's own check decides.
  function inkInside(canvas, sx, sy, sw, sh) {
    try {
      const { data } = canvas.getContext("2d").getImageData(
        Math.floor(sx), Math.floor(sy), Math.max(1, Math.round(sw)), Math.max(1, Math.round(sh)));
      let marked = 0;
      for (let i = 3; i < data.length; i += 4) if (data[i] > 60 && ++marked >= 24) return true;
      return false;
    } catch (_) {
      return true;
    }
  }

  // ---------- converting ----------

  async function convert(image, nextKind) {
    lastImage = image;
    if (nextKind) kind = nextKind;
    openSheet();
    setBusy(true, kind === "math" ? "Reading the equation…" : "Reading the handwriting…");
    let body = null;
    let ok = false;
    try {
      const response = await fetch("/api/ocr", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ image, kind })
      });
      ok = response.ok;
      body = await response.json().catch(() => null);
    } catch (_) {
      body = { error: "Could not reach the server. Check the connection and try again." };
    }
    setBusy(false);
    if (!ok || !body || body.error) {
      showError((body && body.error) || "That image could not be converted.");
      return;
    }
    showResult(body.kind === "text" ? body.text : body.latex);
  }

  // ---------- the result sheet ----------

  function buildSheet() {
    sheet = document.createElement("div");
    sheet.className = "img-sheet ocr-sheet";
    sheet.id = "ocrSheet";
    sheet.dataset.iconSet = "lucide";
    sheet.hidden = true;
    sheet.innerHTML = `
      <div class="img-sheet-card ocr-card" role="dialog" aria-modal="true" aria-labelledby="ocrTitle">
        <div class="img-sheet-head">
          <h2 id="ocrTitle">Image to text</h2>
          <div class="img-tabs" role="tablist" aria-label="Read as">
            <button type="button" role="tab" data-kind="math" aria-selected="true"><span>Equation</span></button>
            <button type="button" role="tab" data-kind="text" aria-selected="false"><span>Text</span></button>
          </div>
          <button type="button" class="img-sheet-close" data-ocr="close" aria-label="Close">${icon("lucide:x")}</button>
        </div>
        <div class="ocr-body">
          <img class="ocr-source" alt="The part of the page being read">
          <div class="ocr-status" role="status" aria-live="polite"></div>
          <label class="ocr-result-label" for="ocrResult">Result — fix anything it misread</label>
          <textarea id="ocrResult" class="ocr-result" rows="4" spellcheck="false"></textarea>
          <p class="ocr-preview" aria-label="Preview"></p>
        </div>
        <div class="img-sheet-foot">
          <button type="button" class="img-ghost" data-ocr="again">${icon("lucide:scan-text")}<span>Box another</span></button>
          <span class="img-gap"></span>
          <button type="button" class="img-ghost" data-ocr="copy">${icon("lucide:copy")}<span>Copy</span></button>
          <button type="button" class="img-apply" data-ocr="place">${icon("lucide:check")}<span>Place on page</span></button>
        </div>
      </div>`;
    document.body.appendChild(sheet);
    sheet.addEventListener("click", (event) => {
      if (event.target === sheet) return closeSheet();
      const tab = event.target.closest("[data-kind]");
      if (tab && !busy && lastImage && tab.dataset.kind !== kind) {
        convert(lastImage, tab.dataset.kind);
        return;
      }
      const act = event.target.closest("[data-ocr]")?.dataset.ocr;
      if (act === "close") closeSheet();
      if (act === "again") { closeSheet(); start(); }
      if (act === "copy") copy();
      if (act === "place") place();
    });
    sheet.querySelector(".ocr-result").addEventListener("input", syncPreview);
    ["keydown", "keyup", "keypress"].forEach((type) => sheet.addEventListener(type, (event) => {
      if (event.key === "Escape" && type === "keydown") closeSheet();
      event.stopPropagation();
    }));
    ["pointerdown", "wheel"].forEach((type) => sheet.addEventListener(type, (event) => event.stopPropagation(), { passive: true }));
  }

  function openSheet() {
    if (!sheet) buildSheet();
    sheet.hidden = false;
    sheet.querySelector(".ocr-source").src = lastImage || "";
    sheet.querySelectorAll("[data-kind]").forEach((t) => t.setAttribute("aria-selected", String(t.dataset.kind === kind)));
  }

  function closeSheet() {
    if (sheet) sheet.hidden = true;
  }

  function setBusy(on, message) {
    busy = on;
    sheet.classList.toggle("is-busy", on);
    const status = sheet.querySelector(".ocr-status");
    status.textContent = on ? message + " The first one after a restart can take a minute while the models load." : "";
    sheet.querySelectorAll('[data-ocr="copy"], [data-ocr="place"]').forEach((b) => { b.disabled = on; });
  }

  function showError(message) {
    sheet.querySelector(".ocr-status").textContent = message;
    sheet.querySelector(".ocr-result").value = "";
    syncPreview();
  }

  function showResult(text) {
    const field = sheet.querySelector(".ocr-result");
    field.value = text || "";
    sheet.querySelector(".ocr-status").textContent = text ? "" : "No writing found in that box. Try a tighter one.";
    syncPreview();
    field.focus();
  }

  function syncPreview() {
    const value = sheet.querySelector(".ocr-result").value;
    sheet.querySelector(".ocr-preview").textContent = kind === "math" ? latexToReadable(value) : "";
  }

  async function copy() {
    const value = sheet.querySelector(".ocr-result").value;
    if (!value) return;
    try {
      await navigator.clipboard.writeText(value);
      notify(kind === "math" ? "LaTeX copied" : "Text copied");
    } catch (_) {
      notify("The browser would not allow copying here", "error");
    }
  }

  // ---------- reading LaTeX without a TeX engine ----------
  //
  // The page card is drawn with the app's own fonts, so the common pieces of
  // school maths are turned into their Unicode forms: powers and indices,
  // fractions, roots, Greek, operators. The exact LaTeX is still what Copy
  // gives you.

  const SUP = {
    0: "⁰", 1: "¹", 2: "²", 3: "³", 4: "⁴", 5: "⁵", 6: "⁶", 7: "⁷", 8: "⁸", 9: "⁹",
    "+": "⁺", "-": "⁻", "−": "⁻", "=": "⁼", "(": "⁽", ")": "⁾", "°": "°", "′": "′",
    a: "ᵃ", b: "ᵇ", c: "ᶜ", d: "ᵈ", e: "ᵉ", f: "ᶠ", g: "ᵍ", h: "ʰ", i: "ⁱ", j: "ʲ", k: "ᵏ", l: "ˡ", m: "ᵐ",
    n: "ⁿ", o: "ᵒ", p: "ᵖ", r: "ʳ", s: "ˢ", t: "ᵗ", u: "ᵘ", v: "ᵛ", w: "ʷ", x: "ˣ", y: "ʸ", z: "ᶻ"
  };
  const SUB = {
    0: "₀", 1: "₁", 2: "₂", 3: "₃", 4: "₄", 5: "₅", 6: "₆", 7: "₇", 8: "₈", 9: "₉",
    "+": "₊", "-": "₋", "−": "₋", "=": "₌", "(": "₍", ")": "₎",
    a: "ₐ", e: "ₑ", h: "ₕ", i: "ᵢ", j: "ⱼ", k: "ₖ", l: "ₗ", m: "ₘ", n: "ₙ", o: "ₒ", p: "ₚ", r: "ᵣ", s: "ₛ", t: "ₜ",
    u: "ᵤ", v: "ᵥ", x: "ₓ"
  };
  const SYMBOLS = {
    alpha: "α", beta: "β", gamma: "γ", delta: "δ", epsilon: "ε", varepsilon: "ε", zeta: "ζ", eta: "η", theta: "θ",
    vartheta: "ϑ", kappa: "κ", lambda: "λ", mu: "μ", nu: "ν", xi: "ξ", pi: "π", rho: "ρ", sigma: "σ", tau: "τ",
    phi: "φ", varphi: "φ", chi: "χ", psi: "ψ", omega: "ω", Gamma: "Γ", Delta: "Δ", Theta: "Θ", Lambda: "Λ",
    Xi: "Ξ", Pi: "Π", Sigma: "Σ", Phi: "Φ", Psi: "Ψ", Omega: "Ω",
    times: "×", cdot: "·", div: "÷", pm: "±", mp: "∓", ast: "∗", leq: "≤", le: "≤", geq: "≥", ge: "≥",
    neq: "≠", ne: "≠", lt: "<", gt: ">", approx: "≈", equiv: "≡", cong: "≅", sim: "∼", propto: "∝", infty: "∞",
    to: "→", rightarrow: "→", leftarrow: "←", Rightarrow: "⇒", implies: "⇒", Leftrightarrow: "⇔", iff: "⇔",
    angle: "∠", triangle: "△", degree: "°", circ: "°", perp: "⊥", parallel: "∥", mid: "|", vert: "|",
    int: "∫", sum: "∑", prod: "∏", partial: "∂", nabla: "∇",
    in: "∈", notin: "∉", subset: "⊂", subseteq: "⊆", cup: "∪", cap: "∩", emptyset: "∅", varnothing: "∅",
    forall: "∀", exists: "∃", therefore: "∴", because: "∵",
    surd: "√", cdots: "⋯", ldots: "…", dots: "…", prime: "′"
  };
  const ROOTS = { 2: "√", 3: "∛", 4: "∜" };
  // Wrappers that change how a letter looks, not what it says.
  const DECORATIONS = /\\(?:mathrm|mathbf|mathit|mathsf|mathbb|mathcal|text|textrm|textbf|textit|operatorname|boldsymbol|bm|overline|underline|bar|hat|widehat|vec|overrightarrow|tilde|widetilde|dot|ddot)\{([^{}]*)\}/g;
  // Characters that must reach the end untouched. Stand-ins keep the passes
  // below from reading an escaped brace, or a ^ they wrote, as structure.
  const KEEP = { "\u0001": "{", "\u0002": "}", "\u0003": "&", "\u0004": "^", "\u0005": "_" };

  // A power or an index in raised or lowered characters when every one has
  // such a form, and written out as ^(…) or _(…) when one does not.
  function script(text, table, mark) {
    const chars = [...text.trim()];
    if (chars.length && chars.every((c) => table[c])) return chars.map((c) => table[c]).join("");
    return chars.length === 1 ? mark + chars[0] : `${mark}(${text.trim()})`;
  }

  // One side of a fraction, or the inside of a root, keeps brackets once it
  // is more than a single term: (a+b)/2 and √(x+1), but 1/2 and √3.
  function term(text) {
    const t = text.trim();
    if (/^\([^()]*\)$/.test(t)) return t;
    return /[\s+\-−=×·÷±∓/,<>≤≥≠≈→⇒]/.test(t) ? `(${t})` : t;
  }

  function latexToReadable(latex) {
    let s = String(latex || "")
      .replace(/\\\\/g, "\n")
      .replace(/\\\{/g, "\u0001").replace(/\\\}/g, "\u0002").replace(/\\&/g, "\u0003").replace(/\\\|/g, "‖")
      .replace(/\\([%$#])/g, "$1")
      .replace(/\\begin\{(?:array|tabular)\}\{[^{}]*\}|\\begin\{[^{}]*\}|\\end\{[^{}]*\}/g, "")
      .replace(/&/g, " ")
      .replace(/\\(?:left|right|[Bb]igg?[lr]?)(?![A-Za-z])\.?/g, "")
      .replace(/\\(?:q?quad(?![A-Za-z])|[,;:! ])|~/g, " ")
      .replace(/\\([A-Za-z]+)/g, (whole, name) => SYMBOLS[name] ?? whole);
    // Innermost first, so a power inside a fraction (or a fraction inside a
    // root) is already plain text by the time the piece around it is read.
    for (let pass = 0; pass < 16; pass++) {
      const before = s;
      s = s
        .replace(/\^\{([^{}]*)\}|\^([^{}\\\s])/g, (_, group, one) => script(group ?? one, SUP, "\u0004"))
        .replace(/_\{([^{}]*)\}|_([^{}\\\s])/g, (_, group, one) => script(group ?? one, SUB, "\u0005"))
        .replace(DECORATIONS, "$1")
        .replace(/\\sqrt\[([^\]{}]*)\]\{([^{}]*)\}/g, (_, n, x) => (ROOTS[n.trim()] ?? script(n, SUP, "") + "√") + term(x))
        .replace(/\\sqrt\{([^{}]*)\}/g, (_, x) => "√" + term(x))
        .replace(/\\[dt]?frac\{([^{}]*)\}\{([^{}]*)\}/g, (_, top, bottom) => term(top) + "/" + term(bottom));
      if (s === before) {
        // Only plain groups are left in the way: open the ones that are not
        // a command's argument, and go round again.
        s = s.replace(/\{([^{}]*)\}/g, (group, inner, at, all) =>
          (/(?:\\[A-Za-z]+|[\^_\]}])$/.test(all.slice(0, at)) ? group : inner));
        if (s === before) break;
      }
    }
    s = s.replace(/\\sqrt\s*/g, "√").replace(/\\([A-Za-z]+)/g, "$1").replace(/[{}]/g, "")
      .replace(/[\u0001-\u0005]/g, (c) => KEEP[c]);
    return s.split("\n").map((line) => line.replace(/[ \t]+/g, " ").trim()).filter(Boolean).join("\n");
  }

  // ---------- placing it on the page ----------

  function place() {
    const raw = sheet.querySelector(".ocr-result").value.trim();
    if (!raw) return;
    const lines = (kind === "math" ? latexToReadable(raw) : raw).split("\n").filter(Boolean);
    const s = state();
    const ink = s?.toolSettings?.pen?.color || (document.documentElement.dataset.theme === "light" ? "#111111" : "#ffffff");
    const scale = 2;
    const size = 40;
    const probe = document.createElement("canvas").getContext("2d");
    const font = `600 ${size * scale}px "Space Grotesk", "Archivo", system-ui, sans-serif`;
    probe.font = font;
    const width = Math.ceil(Math.max(...lines.map((l) => probe.measureText(l).width))) + 32 * scale;
    const lineH = size * 1.35 * scale;
    const height = Math.ceil(lines.length * lineH + 24 * scale);
    const card = document.createElement("canvas");
    card.width = width;
    card.height = height;
    const g = card.getContext("2d");
    g.font = font;
    g.fillStyle = ink;
    g.textBaseline = "top";
    lines.forEach((line, i) => g.fillText(line, 16 * scale, 12 * scale + i * lineH));
    const image = card.toDataURL("image/png");

    const t = s.transform || { scale: 1, offsetX: 0, offsetY: 0 };
    const metrics = typeof window.getCanvasMetrics === "function" ? window.getCanvasMetrics() : { width: innerWidth, height: innerHeight };
    const cx = (metrics.width / 2 - t.offsetX) / t.scale;
    const cy = (metrics.height / 2 - t.offsetY) / t.scale;
    const w = width / scale;
    const h = height / scale;
    if (typeof window.commitHistory === "function") window.commitHistory();
    s.paths.push({
      tool: "image",
      points: [{ x: cx - w / 2, y: cy - h / 2 }, { x: cx + w / 2, y: cy + h / 2 }],
      image,
      ocrSource: kind,
      timestamp: Date.now()
    });
    window.setTool?.("select");
    window.Inkyscib?.Selection?.selectIndex?.(s.paths.length - 1);
    window.render?.();
    window.saveDrawing?.();
    closeSheet();
    notify("Placed on the page");
  }

  window.Inkyscib = window.Inkyscib || {};
  window.Inkyscib.Ocr = {
    start,
    convertImage: (image, k) => convert(image, k),
    latexToReadable,
    isOpen: () => !!sheet && !sheet.hidden
  };
})();
