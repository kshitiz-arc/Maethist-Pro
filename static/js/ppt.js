(function () {
  "use strict";

  const imageCache = new Map();
  let exportOpen = false;
  let importOverlayHideTimer = null;
  let importAnimationRun = 0;

  function state() {
    return window.appState;
  }

  function clonePaths(paths) {
    return JSON.parse(JSON.stringify(paths || []));
  }

  function normalizeDeck(deck) {
    const slides = (deck?.slides || [])
      .filter((slide) => slide && slide.image)
      .map((slide, index) => ({
        index,
        // Which page of the stored original this slide came from. Kept
        // separate from `index` because pages can be reordered later while
        // the link back to the source must not move with them.
        pageIndex: Number.isFinite(slide.pageIndex) ? slide.pageIndex : index,
        width: Number.isFinite(slide.width) ? slide.width : 1920,
        height: Number.isFinite(slide.height) ? slide.height : 1080,
        sourceWidthEmu: Number.isFinite(slide.sourceWidthEmu) ? slide.sourceWidthEmu : null,
        sourceHeightEmu: Number.isFinite(slide.sourceHeightEmu) ? slide.sourceHeightEmu : null,
        image: slide.image,
        paths: Array.isArray(slide.paths) ? slide.paths : []
      }));

    return {
      active: slides.length > 0,
      name: deck?.name || "Inkyscib presentation",
      renderMode: deck?.renderMode || "browser",
      // Null for decks with no stored original: PPTX imports, and PDFs
      // imported before the document store existed.
      docId: typeof deck?.docId === "string" ? deck.docId : null,
      slides,
      currentSlide: Math.max(0, Math.min(deck?.currentSlide || 0, Math.max(0, slides.length - 1)))
    };
  }

  function currentSlide() {
    const ppt = state()?.ppt;
    if (!ppt?.active || !ppt.slides?.length) return null;
    return ppt.slides[Math.max(0, Math.min(ppt.currentSlide || 0, ppt.slides.length - 1))];
  }

  function syncCurrentSlidePaths() {
    const s = state();
    const slide = currentSlide();
    if (!s || !slide) return;
    slide.paths = clonePaths(s.paths);
  }

  function setStatus(message, tone = "muted") {
    const status = document.getElementById("pptImportStatus");
    if (!status) return;
    status.textContent = message || "";
    status.dataset.tone = tone;
  }

  function setPdfStatus(message, tone = "muted") {
    const status = document.getElementById("pdfImportStatus");
    if (!status) return;
    status.textContent = message || "";
    status.dataset.tone = tone;
  }

  function setImportAnimation(active, options = {}) {
    const overlay = document.getElementById("pptImportOverlay");
    const title = document.getElementById("pptImportLoaderTitle");
    const count = document.getElementById("pptImportLoaderCount");
    const progress = document.getElementById("pptImportProgressBar");
    const importBtn = document.getElementById("pptImportBtn");
    const input = document.getElementById("pptImportInput");

    window.clearTimeout(importOverlayHideTimer);

    if (active) importAnimationRun += 1;

    if (overlay) {
      overlay.hidden = !active;
      overlay.setAttribute("aria-hidden", active ? "false" : "true");
      overlay.classList.toggle("is-finishing", !!options.finishing);
    }
    document.body.classList.toggle("ppt-importing", active);
    importBtn?.classList.toggle("loading", active);
    if (importBtn) importBtn.disabled = active;
    if (input) input.disabled = active;

    if (!active) return;

    const done = Number.isFinite(options.done) ? Math.max(0, options.done) : null;
    const total = Number.isFinite(options.total) ? Math.max(0, options.total) : null;
    const percent = total ? Math.max(0, Math.min(100, Math.round((done || 0) / total * 100))) : null;

    if (title) title.textContent = options.title || "Importing deck";
    if (count) count.textContent = total ? `${Math.min(done || 0, total)} / ${total}` : "Loading";
    if (progress) progress.style.width = `${percent ?? 34}%`;
  }

  function finishImportAnimation(total) {
    const overlay = document.getElementById("pptImportOverlay");
    const importBtn = document.getElementById("pptImportBtn");
    const input = document.getElementById("pptImportInput");

    setImportAnimation(true, {
      title: "Ready",
      done: total || 1,
      total: total || 1,
      finishing: true
    });
    const run = importAnimationRun;

    document.body.classList.remove("ppt-importing");
    importBtn?.classList.remove("loading");
    if (importBtn) importBtn.disabled = false;
    if (input) input.disabled = false;

    importOverlayHideTimer = window.setTimeout(() => {
      if (run === importAnimationRun) setImportAnimation(false);
    }, 520);

    window.setTimeout(() => {
      if (run !== importAnimationRun) return;
      if (overlay) {
        overlay.hidden = true;
        overlay.setAttribute("aria-hidden", "true");
        overlay.classList.remove("is-finishing");
      }
      document.body.classList.remove("ppt-importing");
      importBtn?.classList.remove("loading");
      if (importBtn) importBtn.disabled = false;
      if (input) input.disabled = false;
    }, 900);
  }

  function hideImportAnimation() {
    setImportAnimation(false);
  }

  function updatePptUi() {
    const s = state();
    const ppt = s?.ppt;
    const active = !!ppt?.active && !!ppt.slides?.length;

    document.body.classList.toggle("ppt-active", active);

    const nav = document.getElementById("pptSlideNav");
    const panel = document.getElementById("pptDeckPanel");
    const exportTool = document.getElementById("pptExportTool");
    const counter = document.getElementById("pptSlideCounter");
    const title = document.getElementById("pptDeckTitle");
    const meta = document.getElementById("pptDeckMeta");
    const prev = document.getElementById("pptPrevSlide");
    const next = document.getElementById("pptNextSlide");

    if (!active) exportOpen = false;

    if (nav) nav.hidden = !active;
    if (exportTool) {
      exportTool.hidden = !active;
      exportTool.classList.toggle("active", active && exportOpen);
    }
    if (panel) panel.hidden = !active || !exportOpen;

    if (!active) return;

    const index = ppt.currentSlide || 0;
    const total = ppt.slides.length;
    if (counter) counter.textContent = `${index + 1} / ${total}`;
    if (title) title.textContent = ppt.name || "Imported presentation";
    if (meta) {
      const mode = ppt.renderMode === "basic" ? "basic render" : ppt.renderMode === "local" ? "local render" : "ready";
      meta.textContent = `${total} slide${total === 1 ? "" : "s"} ${mode}`;
    }
    if (prev) prev.disabled = index <= 0;
    if (next) next.disabled = index >= total - 1;
  }

  function loadSlideImage(src) {
    if (imageCache.has(src)) return imageCache.get(src).promise;

    const record = {
      image: new Image(),
      loaded: false,
      promise: null
    };

    record.promise = new Promise((resolve, reject) => {
      record.image.onload = () => {
        record.loaded = true;
        window.invalidateCanvasBackground?.();
        resolve(record.image);
      };
      record.image.onerror = reject;
      record.image.src = src;
    });

    imageCache.set(src, record);
    return record.promise;
  }

  function requestRender() {
    if (typeof window.render === "function") window.render();
  }

  function renderPptSlideBackground(ctx) {
    const slide = currentSlide();
    if (!slide) return;

    const cached = imageCache.get(slide.image);
    ctx.save();
    ctx.fillStyle = "#ffffff";
    ctx.shadowColor = "rgba(0, 0, 0, 0.28)";
    ctx.shadowBlur = 28;
    ctx.shadowOffsetY = 14;
    ctx.fillRect(0, 0, slide.width, slide.height);
    ctx.shadowColor = "transparent";

    if (cached?.loaded) {
      ctx.drawImage(cached.image, 0, 0, slide.width, slide.height);
    } else {
      loadSlideImage(slide.image).then(requestRender).catch(() => setStatus("Could not render one slide image.", "error"));
      ctx.fillStyle = "#f8fafc";
      ctx.fillRect(0, 0, slide.width, slide.height);
    }

    ctx.lineWidth = 2 / Math.max(0.1, state().transform.scale || 1);
    ctx.strokeStyle = "rgba(15, 23, 42, 0.22)";
    ctx.strokeRect(0, 0, slide.width, slide.height);
    ctx.restore();
  }

  function activateDeck(deck, options = {}) {
    const s = state();
    if (!s) return;

    if (s.ppt?.active) syncCurrentSlidePaths();

    s.ppt = normalizeDeck(deck);
    if (!s.ppt.active) {
      setStatus("No slides were found in that presentation.", "error");
      return;
    }

    s.paths = s.ppt.slides[s.ppt.currentSlide].paths || [];
    s.undoStack = [];
    s.redoStack = [];

    if (typeof window.fitPptSlideToViewport === "function") {
      window.fitPptSlideToViewport();
    }

    updatePptUi();
    requestRender();

    // Document chrome (the File ribbon) retitles on this rather than polling.
    try {
      document.dispatchEvent(new CustomEvent("inkyscibDeckChanged"));
    } catch (error) {
      /* nothing depends on this firing */
    }

    if (options.persist !== false && typeof window.saveDrawing === "function") window.saveDrawing();
    const statusFn = options.statusFn || setStatus;
    statusFn(
      `Imported ${s.ppt.slides.length} slide${s.ppt.slides.length === 1 ? "" : "s"}${s.ppt.renderMode === "basic" ? "..." : ""}.`,
      "success"
    );
  }

  function switchSlide(nextIndex) {
    const s = state();
    const ppt = s?.ppt;
    if (!ppt?.active) return;

    const target = Math.max(0, Math.min(nextIndex, ppt.slides.length - 1));
    if (target === ppt.currentSlide) return;

    syncCurrentSlidePaths();
    ppt.currentSlide = target;
    s.paths = ppt.slides[target].paths || [];
    s.undoStack = [];
    s.redoStack = [];

    if (typeof window.fitPptSlideToViewport === "function") {
      window.fitPptSlideToViewport();
    }

    updatePptUi();
    requestRender();
    if (typeof window.saveDrawing === "function") window.saveDrawing();
  }

  function toggleExportPanel(force = null) {
    const s = state();
    if (!s?.ppt?.active) return;
    exportOpen = force === null ? !exportOpen : !!force;
    updatePptUi();
  }

  function canUseServerPptImport() {
    return ["localhost", "127.0.0.1", "::1"].includes(window.location.hostname);
  }

  function replaceActivePptSlide(deckName, index, slide, options = {}) {
    const s = state();
    const ppt = s?.ppt;
    if (!ppt?.active || ppt.name !== deckName || !ppt.slides?.[index]) return;

    const oldSlide = ppt.slides[index];
    ppt.slides[index] = {
      ...slide,
      index,
      paths: Array.isArray(oldSlide.paths) ? oldSlide.paths : []
    };
    imageCache.delete(oldSlide.image);

    if (index === ppt.currentSlide) {
      loadSlideImage(slide.image).then(requestRender).catch(() => {});
      requestRender();
    }

    updatePptUi();
    if (options.persist !== false && typeof window.saveDrawing === "function") window.saveDrawing();
  }

  async function importPptViaServer(file) {
    const form = new FormData();
    form.append("ppt", file);
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), 15000);

    try {
      const response = await fetch("/api/ppt/import", {
        method: "POST",
        body: form,
        signal: controller.signal
      });
      const payload = await response.json();

      if (!response.ok) {
        throw new Error(payload.detail || payload.error || "PPT import failed.");
      }

      activateDeck(payload);
    } catch (error) {
      if (error.name === "AbortError") {
        throw new Error("Server PPT import is taking too long. Use .pptx for fast local import.");
      }
      throw error;
    } finally {
      window.clearTimeout(timeout);
    }
  }

  async function importPpt(file) {
    if (!file) return;
    if (state()?.notebook?.active) {
      setStatus("Turn off Notebook Mode before importing PPT.", "error");
      return;
    }

    const name = file.name || "";
    const lowerName = name.toLowerCase();
    const isPptx = lowerName.endsWith(".pptx");
    const isPpt = lowerName.endsWith(".ppt");

    if (!isPptx && !isPpt) {
      setStatus("Choose a .pptx file to import.", "error");
      return;
    }

    if (isPptx && typeof window.importPptxLocally === "function") {
      let activatedLocally = false;
      setImportAnimation(true, { title: name || "Opening deck", done: 0, total: 0 });
      setStatus("Opening PPTX on this device...", "loading");

      try {
        const deck = await window.importPptxLocally(file, {
          onDeckReady: (deckDraft) => {
            activatedLocally = true;
            activateDeck(deckDraft, { persist: false });
            setImportAnimation(true, {
              title: deckDraft.name || name || "Rendering slides",
              done: 1,
              total: deckDraft.slides.length
            });
            setStatus(`Loaded first slide. Rendering ${deckDraft.slides.length} slides locally...`, "loading");
          },
          onSlideRendered: (index, slide, total) => {
            if (activatedLocally) replaceActivePptSlide(name, index, slide, { persist: false });
            setImportAnimation(true, {
              title: name || "Rendering slides",
              done: Math.min(index + 1, total),
              total
            });
            setStatus(`Rendering slides locally ${Math.min(index + 1, total)} / ${total}...`, "loading");
          },
          onProgress: (done, total) => {
            if (done < total) {
              setImportAnimation(true, {
                title: name || "Rendering slides",
                done,
                total
              });
              setStatus(`Rendering slides locally ${done} / ${total}...`, "loading");
            }
          }
        });

        if (!activatedLocally) activateDeck(deck);
        finishImportAnimation(deck.slides.length);
        setStatus(`Imported ${deck.slides.length} slide${deck.slides.length === 1 ? "" : "s"} locally.`, "success");
        if (activatedLocally && typeof window.saveDrawing === "function") window.saveDrawing();
        return;
      } catch (error) {
        console.warn("Local PPTX import failed.", error);
        if (!canUseServerPptImport()) {
          hideImportAnimation();
          setStatus(error.message || "Fast local PPTX import failed.", "error");
          return;
        }
        setImportAnimation(true, { title: "Trying server import", done: 0, total: 0 });
        setStatus("Local import failed; trying server...", "loading");
      }
    }

    if (!canUseServerPptImport()) {
      hideImportAnimation();
      setStatus(
        isPpt
          ? "Fast import supports .pptx. Save this legacy .ppt as .pptx first."
          : "Fast local PPTX import is unavailable in this browser.",
        "error"
      );
      return;
    }

    setImportAnimation(true, { title: name || "Importing deck", done: 0, total: 0 });
    setStatus("Importing...", "loading");
    try {
      await importPptViaServer(file);
      finishImportAnimation(1);
    } catch (error) {
      hideImportAnimation();
      setStatus(error.message || "PPT import failed.", "error");
    }
  }

  async function importPdfViaServer(file) {
    const form = new FormData();
    form.append("pdf", file);
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), 30000);

    try {
      const response = await fetch("/api/pdf/import", {
        method: "POST",
        body: form,
        signal: controller.signal
      });
      const payload = await response.json();

      if (!response.ok) {
        throw new Error(payload.detail || payload.error || "PDF import failed.");
      }

      const count = payload.slides?.length || 0;
      activateDeck(payload, { statusFn: () => {} });
      finishImportAnimation(count);
      setPdfStatus(`Imported ${count} page${count === 1 ? "" : "s"}.`, "success");
    } catch (error) {
      if (error.name === "AbortError") {
        throw new Error("Server PDF import is taking too long.");
      }
      throw error;
    } finally {
      window.clearTimeout(timeout);
    }
  }

  async function importPdf(file) {
    if (!file) return;
    if (state()?.notebook?.active) {
      setPdfStatus("Turn off Notebook Mode before importing PDF.", "error");
      return;
    }

    const name = file.name || "";
    if (!name.toLowerCase().endsWith(".pdf")) {
      setPdfStatus("Choose a .pdf file to import.", "error");
      return;
    }

    const pdfBtn = document.getElementById("pdfImportBtn");
    const pdfInput = document.getElementById("pdfImportInput");

    const lockUi = (locked) => {
      if (pdfBtn) { pdfBtn.disabled = locked; pdfBtn.classList.toggle("loading", locked); }
      if (pdfInput) pdfInput.disabled = locked;
    };

    setImportAnimation(true, { title: name || "Importing PDF", done: 0, total: 0 });
    lockUi(true);
    setPdfStatus("Opening PDF on this device...", "loading");

    // Fast path: render entirely in the browser (works the same in prod as
    // local PPTX import). The server is only a localhost fallback.
    if (typeof window.importPdfLocally === "function") {
      let activatedLocally = false;
      try {
        const deck = await window.importPdfLocally(file, {
          onDeckReady: (deckDraft) => {
            activatedLocally = true;
            activateDeck(deckDraft, { persist: false, statusFn: () => {} });
            setImportAnimation(true, {
              title: deckDraft.name || name || "Rendering pages",
              done: 1,
              total: deckDraft.slides.length
            });
            setPdfStatus(`Loaded first page. Rendering ${deckDraft.slides.length} pages locally...`, "loading");
          },
          onSlideRendered: (index, slide, total) => {
            if (activatedLocally) replaceActivePptSlide(name, index, slide, { persist: false });
            setImportAnimation(true, {
              title: name || "Rendering pages",
              done: Math.min(index + 1, total),
              total
            });
            setPdfStatus(`Rendering pages locally ${Math.min(index + 1, total)} / ${total}...`, "loading");
          },
          onProgress: (done, total) => {
            if (done < total) {
              setImportAnimation(true, { title: name || "Rendering pages", done, total });
              setPdfStatus(`Rendering pages locally ${done} / ${total}...`, "loading");
            }
          }
        });

        if (!activatedLocally) activateDeck(deck, { statusFn: () => {} });
        finishImportAnimation(deck.slides.length);
        setPdfStatus(`Imported ${deck.slides.length} page${deck.slides.length === 1 ? "" : "s"}.`, "success");
        if (activatedLocally && typeof window.saveDrawing === "function") window.saveDrawing();
        lockUi(false);
        return;
      } catch (error) {
        console.warn("Local PDF import failed.", error);
        if (!canUseServerPptImport()) {
          hideImportAnimation();
          setPdfStatus(error.message || "PDF import failed.", "error");
          lockUi(false);
          return;
        }
        setImportAnimation(true, { title: "Trying server import", done: 0, total: 0 });
        setPdfStatus("Local import failed; trying server...", "loading");
      }
    } else if (!canUseServerPptImport()) {
      hideImportAnimation();
      setPdfStatus("Fast PDF import is unavailable in this browser.", "error");
      lockUi(false);
      return;
    }

    try {
      await importPdfViaServer(file);
    } catch (error) {
      hideImportAnimation();
      setPdfStatus(error.message || "PDF import failed.", "error");
    } finally {
      lockUi(false);
    }
  }

  async function renderSlideForExport(slide, paths, options = {}) {
    const width = Math.max(1, Number(slide.width) || 1920);
    const height = Math.max(1, Number(slide.height) || 1080);
    const image = await loadSlideImage(slide.image);
    const sourceWidth = Math.max(1, image.naturalWidth || image.width || Math.round(width));
    const sourceHeight = Math.max(1, image.naturalHeight || image.height || Math.round(height));
    // Imported custom-size slides may intentionally use a capped backing
    // raster. Export at that available resolution and scale annotations into
    // it instead of allocating a potentially enormous native-size canvas.
    const pixelScale = Math.max(sourceWidth / width, sourceHeight / height);
    const pixelWidth = Math.max(1, Math.round(width * pixelScale));
    const pixelHeight = Math.max(1, Math.round(height * pixelScale));
    const base = document.createElement("canvas");
    const overlay = document.createElement("canvas");
    base.width = overlay.width = pixelWidth;
    base.height = overlay.height = pixelHeight;

    const baseCtx = base.getContext("2d");
    const overlayCtx = overlay.getContext("2d");

    baseCtx.fillStyle = "#ffffff";
    baseCtx.fillRect(0, 0, pixelWidth, pixelHeight);
    baseCtx.drawImage(image, 0, 0, pixelWidth, pixelHeight);

    overlayCtx.scale(pixelWidth / width, pixelHeight / height);
    (paths || []).forEach((path) => {
      if (typeof window.drawInkyscibPathForExport === "function") {
        window.drawInkyscibPathForExport(overlayCtx, path);
      }
    });

    baseCtx.drawImage(overlay, 0, 0);
    return {
      image: base.toDataURL("image/png"),
      width,
      height,
      unit: options.unit === "pt" ? "pt" : "px",
      sourceWidthEmu: Number.isFinite(slide.sourceWidthEmu) ? slide.sourceWidthEmu : null,
      sourceHeightEmu: Number.isFinite(slide.sourceHeightEmu) ? slide.sourceHeightEmu : null
    };
  }

  async function collectExportImages() {
    const s = state();
    const ppt = s?.ppt;
    if (!ppt?.active || !ppt.slides?.length) throw new Error("Import a PPT first.");

    syncCurrentSlidePaths();

    const images = [];
    const unit = ppt.renderMode === "pdf" ? "pt" : "px";
    for (const slide of ppt.slides) {
      images.push(await renderSlideForExport(slide, slide.paths, { unit }));
    }
    return images;
  }

  function downloadBlob(blob, filename) {
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = filename;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  function dataUrlToBytes(dataUrl) {
    if (typeof dataUrl !== "string" || !dataUrl.includes(",")) {
      throw new Error("One exported slide image was invalid.");
    }

    const payload = dataUrl.split(",", 2)[1];
    const binary = window.atob(payload);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) {
      bytes[index] = binary.charCodeAt(index);
    }
    return bytes;
  }

  function stringToBytes(value) {
    return new TextEncoder().encode(value);
  }

  function concatBytes(chunks) {
    const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
    const output = new Uint8Array(total);
    let offset = 0;
    chunks.forEach((chunk) => {
      output.set(chunk, offset);
      offset += chunk.length;
    });
    return output;
  }

  function uint16LE(value) {
    const bytes = new Uint8Array(2);
    new DataView(bytes.buffer).setUint16(0, value, true);
    return bytes;
  }

  function uint32LE(value) {
    const bytes = new Uint8Array(4);
    new DataView(bytes.buffer).setUint32(0, value >>> 0, true);
    return bytes;
  }

  function loadImageDataUrl(src) {
    return new Promise((resolve, reject) => {
      const image = new Image();
      image.onload = () => resolve(image);
      image.onerror = reject;
      image.src = src;
    });
  }

  function pdfByteLength(value) {
    return stringToBytes(value).length;
  }

  async function imageDataForPdf(slideImage) {
    const descriptor = typeof slideImage === "string"
      ? { image: slideImage, width: null, height: null, unit: "pt" }
      : (slideImage || {});
    const dataUrl = descriptor.image;
    const image = await loadImageDataUrl(dataUrl);
    const width = Math.max(1, image.naturalWidth || image.width || 1920);
    const height = Math.max(1, image.naturalHeight || image.height || 1080);
    const dimensionScale = descriptor.unit === "px" ? 72 / 96 : 1;
    const pageWidth = Math.max(1, (Number(descriptor.width) || width) * dimensionScale);
    const pageHeight = Math.max(1, (Number(descriptor.height) || height) * dimensionScale);
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;

    const ctx = canvas.getContext("2d");
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, width, height);
    ctx.drawImage(image, 0, 0, width, height);

    return {
      width,
      height,
      pageWidth,
      pageHeight,
      bytes: dataUrlToBytes(canvas.toDataURL("image/jpeg", 0.92))
    };
  }

  async function buildLocalPdf(slideImages) {
    if (!slideImages.length) throw new Error("There are no slides to export.");

    const pages = [];
    let objectNumber = 3;
    for (const image of slideImages) {
      const imageData = await imageDataForPdf(image);
      pages.push({
        ...imageData,
        imageObject: objectNumber,
        contentObject: objectNumber + 1,
        pageObject: objectNumber + 2
      });
      objectNumber += 3;
    }

    const objectCount = objectNumber - 1;
    const parts = [];
    const offsets = new Array(objectCount + 1).fill(0);
    let position = 0;

    function add(part) {
      const bytes = typeof part === "string" ? stringToBytes(part) : part;
      parts.push(bytes);
      position += bytes.length;
    }

    function addObject(number, body) {
      offsets[number] = position;
      add(`${number} 0 obj\n`);
      add(body);
      add("\nendobj\n");
    }

    add("%PDF-1.4\n");
    addObject(1, "<< /Type /Catalog /Pages 2 0 R >>");
    addObject(2, `<< /Type /Pages /Count ${pages.length} /Kids [${pages.map((page) => `${page.pageObject} 0 R`).join(" ")}] >>`);

    pages.forEach((page, index) => {
      const imageName = `Im${index + 1}`;
      offsets[page.imageObject] = position;
      add(`${page.imageObject} 0 obj\n`);
      add(`<< /Type /XObject /Subtype /Image /Width ${page.width} /Height ${page.height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${page.bytes.length} >>\nstream\n`);
      add(page.bytes);
      add("\nendstream\nendobj\n");

      const content = `q\n${page.pageWidth} 0 0 ${page.pageHeight} 0 0 cm\n/${imageName} Do\nQ`;
      addObject(page.contentObject, `<< /Length ${pdfByteLength(content)} >>\nstream\n${content}\nendstream`);
      addObject(
        page.pageObject,
        `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${page.pageWidth} ${page.pageHeight}] /Resources << /XObject << /${imageName} ${page.imageObject} 0 R >> >> /Contents ${page.contentObject} 0 R >>`
      );
    });

    const xrefOffset = position;
    add(`xref\n0 ${objectCount + 1}\n`);
    add("0000000000 65535 f \n");
    for (let index = 1; index <= objectCount; index += 1) {
      add(`${String(offsets[index]).padStart(10, "0")} 00000 n \n`);
    }
    add(`trailer\n<< /Size ${objectCount + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF`);

    return new Blob(parts, { type: "application/pdf" });
  }

  let crcTable = null;

  function getCrcTable() {
    if (crcTable) return crcTable;
    crcTable = new Uint32Array(256);
    for (let index = 0; index < 256; index += 1) {
      let value = index;
      for (let bit = 0; bit < 8; bit += 1) {
        value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
      }
      crcTable[index] = value >>> 0;
    }
    return crcTable;
  }

  function crc32(bytes) {
    const table = getCrcTable();
    let crc = 0xffffffff;
    for (let index = 0; index < bytes.length; index += 1) {
      crc = table[(crc ^ bytes[index]) & 0xff] ^ (crc >>> 8);
    }
    return (crc ^ 0xffffffff) >>> 0;
  }

  function dosDateTime(date = new Date()) {
    const year = Math.max(1980, date.getFullYear());
    return {
      time: (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2),
      date: ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate()
    };
  }

  function createZip(entries) {
    const localParts = [];
    const centralParts = [];
    const timestamp = dosDateTime();
    let offset = 0;

    entries.forEach((entry) => {
      const nameBytes = stringToBytes(entry.name);
      const data = typeof entry.data === "string" ? stringToBytes(entry.data) : entry.data;
      const checksum = crc32(data);
      const localHeader = concatBytes([
        uint32LE(0x04034b50),
        uint16LE(20),
        uint16LE(0),
        uint16LE(0),
        uint16LE(timestamp.time),
        uint16LE(timestamp.date),
        uint32LE(checksum),
        uint32LE(data.length),
        uint32LE(data.length),
        uint16LE(nameBytes.length),
        uint16LE(0),
        nameBytes
      ]);
      const centralHeader = concatBytes([
        uint32LE(0x02014b50),
        uint16LE(20),
        uint16LE(20),
        uint16LE(0),
        uint16LE(0),
        uint16LE(timestamp.time),
        uint16LE(timestamp.date),
        uint32LE(checksum),
        uint32LE(data.length),
        uint32LE(data.length),
        uint16LE(nameBytes.length),
        uint16LE(0),
        uint16LE(0),
        uint16LE(0),
        uint16LE(0),
        uint32LE(0),
        uint32LE(offset),
        nameBytes
      ]);

      localParts.push(localHeader, data);
      centralParts.push(centralHeader);
      offset += localHeader.length + data.length;
    });

    const centralOffset = offset;
    const centralDirectory = concatBytes(centralParts);
    const eocd = concatBytes([
      uint32LE(0x06054b50),
      uint16LE(0),
      uint16LE(0),
      uint16LE(entries.length),
      uint16LE(entries.length),
      uint32LE(centralDirectory.length),
      uint32LE(centralOffset),
      uint16LE(0)
    ]);

    return concatBytes([...localParts, centralDirectory, eocd]);
  }

  const PPTX_A_NS = "http://schemas.openxmlformats.org/drawingml/2006/main";
  const PPTX_R_NS = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
  const PPTX_NS = "http://schemas.openxmlformats.org/presentationml/2006/main";
  const PPTX_PKG_REL_NS = "http://schemas.openxmlformats.org/package/2006/relationships";
  const PPTX_EMU_PER_CSS_PIXEL = 914400 / 96;
  const PPTX_EMU_PER_POINT = 914400 / 72;

  function xmlHeader() {
    return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';
  }

  function pptxContentTypes(slideCount) {
    const slideOverrides = Array.from({ length: slideCount }, (_, index) => (
      `<Override PartName="/ppt/slides/slide${index + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>`
    )).join("");
    return (
      xmlHeader() +
      '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
      '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
      '<Default Extension="xml" ContentType="application/xml"/>' +
      '<Default Extension="png" ContentType="image/png"/>' +
      '<Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/>' +
      '<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>' +
      '<Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/>' +
      '<Override PartName="/ppt/slideMasters/slideMaster1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideMaster+xml"/>' +
      '<Override PartName="/ppt/slideLayouts/slideLayout1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideLayout+xml"/>' +
      '<Override PartName="/ppt/theme/theme1.xml" ContentType="application/vnd.openxmlformats-officedocument.theme+xml"/>' +
      slideOverrides +
      "</Types>"
    );
  }

  function pptxRootRels() {
    return (
      xmlHeader() +
      `<Relationships xmlns="${PPTX_PKG_REL_NS}">` +
      '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="ppt/presentation.xml"/>' +
      '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>' +
      '<Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/>' +
      "</Relationships>"
    );
  }

  function pptxPresentationXml(slideCount, slideSize) {
    const slideIds = Array.from({ length: slideCount }, (_, index) => (
      `<p:sldId id="${256 + index}" r:id="rId${index + 1}"/>`
    )).join("");
    return (
      xmlHeader() +
      `<p:presentation xmlns:a="${PPTX_A_NS}" xmlns:r="${PPTX_R_NS}" xmlns:p="${PPTX_NS}">` +
      '<p:sldMasterIdLst><p:sldMasterId id="2147483648" r:id="rIdMaster"/></p:sldMasterIdLst>' +
      `<p:sldIdLst>${slideIds}</p:sldIdLst>` +
      `<p:sldSz cx="${slideSize.width}" cy="${slideSize.height}" type="custom"/>` +
      '<p:notesSz cx="6858000" cy="9144000"/>' +
      "</p:presentation>"
    );
  }

  function pptxPresentationRels(slideCount) {
    const slideRels = Array.from({ length: slideCount }, (_, index) => (
      `<Relationship Id="rId${index + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide${index + 1}.xml"/>`
    )).join("");
    return (
      xmlHeader() +
      `<Relationships xmlns="${PPTX_PKG_REL_NS}">` +
      slideRels +
      '<Relationship Id="rIdMaster" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideMaster" Target="slideMasters/slideMaster1.xml"/>' +
      "</Relationships>"
    );
  }

  function pptxSlideXml(index, placement) {
    return (
      xmlHeader() +
      `<p:sld xmlns:a="${PPTX_A_NS}" xmlns:r="${PPTX_R_NS}" xmlns:p="${PPTX_NS}">` +
      '<p:cSld><p:bg><p:bgPr><a:solidFill><a:srgbClr val="FFFFFF"/></a:solidFill><a:effectLst/></p:bgPr></p:bg><p:spTree>' +
      '<p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>' +
      '<p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>' +
      '<p:pic>' +
      `<p:nvPicPr><p:cNvPr id="2" name="Inkyscib slide ${index}"/><p:cNvPicPr/><p:nvPr/></p:nvPicPr>` +
      '<p:blipFill><a:blip r:embed="rIdImage"/><a:stretch><a:fillRect/></a:stretch></p:blipFill>' +
      `<p:spPr><a:xfrm><a:off x="${placement.x}" y="${placement.y}"/><a:ext cx="${placement.width}" cy="${placement.height}"/></a:xfrm>` +
      '<a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr>' +
      '</p:pic>' +
      '</p:spTree></p:cSld>' +
      '<p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr>' +
      '</p:sld>'
    );
  }

  function pptxSlideRels(index) {
    return (
      xmlHeader() +
      `<Relationships xmlns="${PPTX_PKG_REL_NS}">` +
      `<Relationship Id="rIdImage" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="../media/image${index}.png"/>` +
      '<Relationship Id="rIdLayout" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout" Target="../slideLayouts/slideLayout1.xml"/>' +
      "</Relationships>"
    );
  }

  function pptxSlideMasterXml() {
    return (
      xmlHeader() +
      `<p:sldMaster xmlns:a="${PPTX_A_NS}" xmlns:r="${PPTX_R_NS}" xmlns:p="${PPTX_NS}">` +
      '<p:cSld><p:spTree>' +
      '<p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>' +
      '<p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>' +
      '</p:spTree></p:cSld>' +
      '<p:clrMap bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2" accent1="accent1" accent2="accent2" accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" hlink="hlink" folHlink="folHlink"/>' +
      '<p:sldLayoutIdLst><p:sldLayoutId id="2147483649" r:id="rIdLayout"/></p:sldLayoutIdLst>' +
      '</p:sldMaster>'
    );
  }

  function pptxSlideMasterRels() {
    return (
      xmlHeader() +
      `<Relationships xmlns="${PPTX_PKG_REL_NS}">` +
      '<Relationship Id="rIdLayout" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout" Target="../slideLayouts/slideLayout1.xml"/>' +
      '<Relationship Id="rIdTheme" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/theme" Target="../theme/theme1.xml"/>' +
      '</Relationships>'
    );
  }

  function pptxSlideLayoutXml() {
    return (
      xmlHeader() +
      `<p:sldLayout xmlns:a="${PPTX_A_NS}" xmlns:r="${PPTX_R_NS}" xmlns:p="${PPTX_NS}" type="blank" preserve="1">` +
      '<p:cSld name="Blank"><p:spTree>' +
      '<p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>' +
      '<p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>' +
      '</p:spTree></p:cSld>' +
      '<p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr>' +
      '</p:sldLayout>'
    );
  }

  function pptxSlideLayoutRels() {
    return (
      xmlHeader() +
      `<Relationships xmlns="${PPTX_PKG_REL_NS}">` +
      '<Relationship Id="rIdMaster" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideMaster" Target="../slideMasters/slideMaster1.xml"/>' +
      '</Relationships>'
    );
  }

  function pptxThemeXml() {
    return (
      xmlHeader() +
      `<a:theme xmlns:a="${PPTX_A_NS}" name="Inkyscib">` +
      '<a:themeElements><a:clrScheme name="Inkyscib">' +
      '<a:dk1><a:sysClr val="windowText" lastClr="000000"/></a:dk1>' +
      '<a:lt1><a:sysClr val="window" lastClr="FFFFFF"/></a:lt1>' +
      '<a:dk2><a:srgbClr val="1F2937"/></a:dk2><a:lt2><a:srgbClr val="F8FAFC"/></a:lt2>' +
      '<a:accent1><a:srgbClr val="5A5AFF"/></a:accent1><a:accent2><a:srgbClr val="22C55E"/></a:accent2>' +
      '<a:accent3><a:srgbClr val="F59E0B"/></a:accent3><a:accent4><a:srgbClr val="EF4444"/></a:accent4>' +
      '<a:accent5><a:srgbClr val="06B6D4"/></a:accent5><a:accent6><a:srgbClr val="A855F7"/></a:accent6>' +
      '<a:hlink><a:srgbClr val="2563EB"/></a:hlink><a:folHlink><a:srgbClr val="7C3AED"/></a:folHlink>' +
      '</a:clrScheme><a:fontScheme name="Inkyscib"><a:majorFont><a:latin typeface="Aptos Display"/></a:majorFont><a:minorFont><a:latin typeface="Aptos"/></a:minorFont></a:fontScheme>' +
      '<a:fmtScheme name="Inkyscib"><a:fillStyleLst><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:fillStyleLst>' +
      '<a:lnStyleLst><a:ln w="6350"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln></a:lnStyleLst>' +
      '<a:effectStyleLst><a:effectStyle><a:effectLst/></a:effectStyle></a:effectStyleLst><a:bgFillStyleLst><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:bgFillStyleLst></a:fmtScheme>' +
      '</a:themeElements></a:theme>'
    );
  }

  function pptxDocProps(slideCount) {
    return {
      app: (
        xmlHeader() +
        '<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties" xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes">' +
        '<Application>Inkyscib</Application>' +
        `<Slides>${slideCount}</Slides>` +
        '</Properties>'
      ),
      core: (
        xmlHeader() +
        '<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:dcmitype="http://purl.org/dc/dcmitype/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">' +
        '<dc:title>Inkyscib annotated presentation</dc:title>' +
        '<dc:creator>Inkyscib</dc:creator>' +
        '</cp:coreProperties>'
      )
    };
  }

  async function normalizePptxSlideImage(slideImage) {
    const descriptor = typeof slideImage === "string"
      ? { image: slideImage, width: null, height: null, unit: "px" }
      : (slideImage || {});
    if (!descriptor.image) throw new Error("One exported slide image was invalid.");

    const image = await loadImageDataUrl(descriptor.image);
    return {
      image: descriptor.image,
      width: Math.max(1, Number(descriptor.width) || image.naturalWidth || image.width || 1920),
      height: Math.max(1, Number(descriptor.height) || image.naturalHeight || image.height || 1080),
      unit: descriptor.unit === "pt" ? "pt" : "px",
      sourceWidthEmu: Number.isFinite(descriptor.sourceWidthEmu) ? descriptor.sourceWidthEmu : null,
      sourceHeightEmu: Number.isFinite(descriptor.sourceHeightEmu) ? descriptor.sourceHeightEmu : null
    };
  }

  function pptxSlideSize(slide) {
    if (slide.sourceWidthEmu > 0 && slide.sourceHeightEmu > 0) {
      return {
        width: Math.round(slide.sourceWidthEmu),
        height: Math.round(slide.sourceHeightEmu)
      };
    }
    const emuPerUnit = slide.unit === "pt" ? PPTX_EMU_PER_POINT : PPTX_EMU_PER_CSS_PIXEL;
    return {
      width: Math.max(1, Math.round(slide.width * emuPerUnit)),
      height: Math.max(1, Math.round(slide.height * emuPerUnit))
    };
  }

  function pptxImagePlacement(slide, slideSize) {
    if (slide.sourceWidthEmu > 0 && slide.sourceHeightEmu > 0) {
      return { x: 0, y: 0, width: slideSize.width, height: slideSize.height };
    }
    const imageAspect = slide.width / slide.height;
    const slideAspect = slideSize.width / slideSize.height;
    let width;
    let height;

    if (imageAspect >= slideAspect) {
      width = slideSize.width;
      height = Math.max(1, Math.round(width / imageAspect));
    } else {
      height = slideSize.height;
      width = Math.max(1, Math.round(height * imageAspect));
    }

    return {
      x: Math.round((slideSize.width - width) / 2),
      y: Math.round((slideSize.height - height) / 2),
      width,
      height
    };
  }

  async function buildLocalPptx(slideImages) {
    if (!slideImages.length) throw new Error("There are no slides to export.");

    const slides = await Promise.all(slideImages.map(normalizePptxSlideImage));
    const slideCount = slides.length;
    // PPTX has one page size for the whole presentation. Preserve the source
    // deck's native size (the first page for mixed-size PDFs) and contain any
    // differently shaped page without cropping or stretching it.
    const slideSize = pptxSlideSize(slides[0]);
    const props = pptxDocProps(slideCount);
    const entries = [
      { name: "[Content_Types].xml", data: pptxContentTypes(slideCount) },
      { name: "_rels/.rels", data: pptxRootRels() },
      { name: "docProps/app.xml", data: props.app },
      { name: "docProps/core.xml", data: props.core },
      { name: "ppt/presentation.xml", data: pptxPresentationXml(slideCount, slideSize) },
      { name: "ppt/_rels/presentation.xml.rels", data: pptxPresentationRels(slideCount) },
      { name: "ppt/slideMasters/slideMaster1.xml", data: pptxSlideMasterXml() },
      { name: "ppt/slideMasters/_rels/slideMaster1.xml.rels", data: pptxSlideMasterRels() },
      { name: "ppt/slideLayouts/slideLayout1.xml", data: pptxSlideLayoutXml() },
      { name: "ppt/slideLayouts/_rels/slideLayout1.xml.rels", data: pptxSlideLayoutRels() },
      { name: "ppt/theme/theme1.xml", data: pptxThemeXml() }
    ];

    slides.forEach((slide, index) => {
      const slideNumber = index + 1;
      const placement = pptxImagePlacement(slide, slideSize);
      entries.push(
        { name: `ppt/slides/slide${slideNumber}.xml`, data: pptxSlideXml(slideNumber, placement) },
        { name: `ppt/slides/_rels/slide${slideNumber}.xml.rels`, data: pptxSlideRels(slideNumber) },
        { name: `ppt/media/image${slideNumber}.png`, data: dataUrlToBytes(slide.image) }
      );
    });

    return new Blob([createZip(entries)], {
      type: "application/vnd.openxmlformats-officedocument.presentationml.presentation"
    });
  }

  async function exportDeckViaServer(format, slides, filename) {
    const endpoint = format === "pptx" ? "/api/ppt/export/pptx" : "/api/ppt/export/pdf";
    const response = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ filename, slides })
    });

    if (!response.ok) {
      const payload = await response.json().catch(() => ({}));
      throw new Error(payload.error || "Export failed.");
    }

    return response.blob();
  }

  function exportFilename(filename, format) {
    return `${(filename || "inkyscib-presentation").replace(/\.[^.]+$/, "")}.${format}`;
  }

  async function exportDeck(format) {
    const s = state();
    if (!s?.ppt?.active) return;

    const filename = s.ppt.name || "inkyscib-presentation";
    setStatus(`Preparing ${format.toUpperCase()} export on this device...`, "loading");

    try {
      syncCurrentSlidePaths();

      // A PDF that still has its original file is exported by adding ink to
      // that file rather than by rebuilding it from pictures of its pages.
      // Everything else — PPTX decks, and PDFs imported before originals were
      // kept — still goes through the raster path below.
      if (format === "pdf" && window.Inkyscib?.PdfExport?.canExportOntoOriginal(s.ppt)) {
        try {
          const result = await window.Inkyscib.PdfExport.exportDeckOntoOriginal(s.ppt);
          downloadBlob(result.blob, exportFilename(filename, format));
          setStatus(result.notes, "success");
          return;
        } catch (vectorError) {
          console.warn("Lossless PDF export failed; falling back to the raster path.", vectorError);
          setStatus("Falling back to a flattened export...", "loading");
        }
      }

      const slides = await collectExportImages();
      let blob;

      try {
        blob = format === "pptx" ? await buildLocalPptx(slides) : await buildLocalPdf(slides);
      } catch (localError) {
        console.warn("Local PPT export failed, falling back to server.", localError);
        setStatus("Local export failed, trying server export...", "loading");
        blob = await exportDeckViaServer(format, slides, filename);
      }

      downloadBlob(blob, exportFilename(filename, format));
      setStatus(`${format.toUpperCase()} export ready.`, "success");
    } catch (error) {
      setStatus(error.message || "Export failed.", "error");
    }
  }

  function closeDeck() {
    const s = state();
    if (!s?.ppt?.active) return;
    const isPdf = s.ppt.renderMode === "pdf";
    if (!confirm(`Close the imported ${isPdf ? "PDF" : "PPT"} from this canvas?`)) return;

    s.ppt = { active: false, name: "", renderMode: "", slides: [], currentSlide: 0 };
    s.paths = [];
    s.undoStack = [];
    s.redoStack = [];
    s.transform = { scale: 1, offsetX: 0, offsetY: 0 };
    updatePptUi();
    requestRender();
    if (typeof window.saveDrawing === "function") window.saveDrawing();
    if (isPdf) {
      setPdfStatus("PDF closed.", "muted");
    } else {
      setStatus("PPT closed.", "muted");
    }
  }

  function initPptUi() {
    const importBtn = document.getElementById("pptImportBtn");
    const input = document.getElementById("pptImportInput");
    const prev = document.getElementById("pptPrevSlide");
    const next = document.getElementById("pptNextSlide");
    const slideNav = document.getElementById("pptSlideNav");
    const pdf = document.getElementById("pptExportPdf");
    const pptx = document.getElementById("pptExportPptx");
    const close = document.getElementById("pptCloseDeck");
    const exportTool = document.getElementById("pptExportTool");

    if (importBtn && input) {
      importBtn.addEventListener("click", () => {
        if (state()?.notebook?.active) {
          setStatus("Turn off Notebook Mode before importing PPT.", "error");
          return;
        }
        input.click();
      });
      input.addEventListener("change", () => {
        importPpt(input.files?.[0]);
        input.value = "";
      });
    }

    const pdfBtn = document.getElementById("pdfImportBtn");
    const pdfInput = document.getElementById("pdfImportInput");

    if (pdfBtn && pdfInput) {
      pdfBtn.addEventListener("click", () => {
        if (state()?.notebook?.active) {
          setPdfStatus("Turn off Notebook Mode before importing PDF.", "error");
          return;
        }
        pdfInput.click();
      });
      pdfInput.addEventListener("change", () => {
        importPdf(pdfInput.files?.[0]);
        pdfInput.value = "";
      });
    }

    if (slideNav) slideNav.addEventListener("click", (event) => {
      const button = event.target.closest?.("#pptPrevSlide, #pptNextSlide");
      if (!button || button.disabled) return;
      const current = state().ppt.currentSlide || 0;
      switchSlide(current + (button.id === "pptNextSlide" ? 1 : -1));
    });
    else {
      if (prev) prev.addEventListener("click", () => switchSlide((state().ppt.currentSlide || 0) - 1));
      if (next) next.addEventListener("click", () => switchSlide((state().ppt.currentSlide || 0) + 1));
    }
    if (exportTool) {
      exportTool.addEventListener("click", (event) => {
        event.stopPropagation();
        toggleExportPanel();
      });
    }
    if (pdf) pdf.addEventListener("click", () => exportDeck("pdf"));
    if (pptx) pptx.addEventListener("click", () => exportDeck("pptx"));
    if (close) close.addEventListener("click", closeDeck);
    document.addEventListener("click", (event) => {
      const panel = document.getElementById("pptDeckPanel");
      const tool = document.getElementById("pptExportTool");
      if (!exportOpen || !panel || !tool) return;
      if (panel.contains(event.target) || tool.contains(event.target)) return;
      toggleExportPanel(false);
    });

    updatePptUi();
    if (state()?.ppt?.active && typeof window.clampPptTransform === "function") {
      window.clampPptTransform();
      requestRender();
    }
  }

  window.renderPptSlideBackground = renderPptSlideBackground;
  window.activatePptDeck = activateDeck;
  window.syncPptCurrentSlidePaths = syncCurrentSlidePaths;
  window.switchPptSlide = switchSlide;
  window.exportPptDeck = exportDeck;
  window.togglePptExportPanel = toggleExportPanel;
  window.Inkyscib = window.Inkyscib || {};
  window.Inkyscib.PptExport = {
    buildLocalPdf,
    buildLocalPptx,
    downloadBlob,
    exportDeckViaServer
  };

  document.addEventListener("DOMContentLoaded", initPptUi);
  document.addEventListener("canvasRendered", updatePptUi);
})();
