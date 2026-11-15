(function () {
  "use strict";

  // Render PDFs entirely in the browser with PDF.js so import works the same
  // way (and just as fast) in production as the local PPTX importer does.
  // The server endpoint is only ever used as a localhost fallback.

  // Pages are rasterised well above their on-screen size so they stay legible
  // at 1:1 and survive a couple of zoom steps without turning to mush. The
  // page's own coordinate system is unchanged; this only sizes the bitmap.
  const TARGET_RENDER_WIDTH = 2400; // backing-image width; not the PDF page size
  const MAX_SCALE = 4;
  const MIN_SCALE = 1.5;
  const JPEG_QUALITY = 0.9;
  // Every page is held in memory as a data URL, so very large PDFs can crash
  // the tab. Matches the server-side import limit.
  const MAX_PAGES = 300;

  let workerConfigured = false;

  // Capture this script's URL at load time (document.currentScript is null later)
  // so the worker resolves to the same vendored folder regardless of mount path.
  const scriptSrc = document.currentScript?.src || "";

  let pdfjsPromise = null;

  // pdf.min.js is ~312 KB and only an import needs it, so it is fetched on
  // first use rather than at page load -- the same bargain pdf-export.js makes
  // for pdf-lib, and the same one pdf.worker.min.js has always made. It used
  // to be a deferred <script> in write.html, which every visitor paid for and
  // only the ones who opened a PDF used. Vendored, not from a CDN, so this
  // keeps working offline.
  function loadPdfjs() {
    if (window.pdfjsLib) return Promise.resolve(window.pdfjsLib);
    if (pdfjsPromise) return pdfjsPromise;

    pdfjsPromise = new Promise((resolve, reject) => {
      const script = document.createElement("script");
      script.src = scriptSrc
        ? scriptSrc.replace(/pdf-local-import\.js.*$/, "vendor/pdf.min.js")
        : "/static/js/vendor/pdf.min.js";
      script.onload = () => {
        if (window.pdfjsLib) resolve(window.pdfjsLib);
        else reject(new Error("The PDF reader failed to start."));
      };
      script.onerror = () => reject(new Error("The PDF reader could not be loaded."));
      document.head.appendChild(script);
    });
    // A failed load must not be remembered, or a flaky network disables PDF
    // import for the rest of the session with no way to retry.
    pdfjsPromise.catch(() => { pdfjsPromise = null; });
    return pdfjsPromise;
  }

  async function ensureWorker() {
    const lib = await loadPdfjs();
    if (!lib) {
      throw new Error("Fast PDF import is unavailable (PDF.js failed to load).");
    }
    if (!workerConfigured) {
      // Vendored alongside pdf.min.js so there is no runtime CDN dependency.
      const workerUrl = scriptSrc
        ? scriptSrc.replace(/pdf-local-import\.js.*$/, "vendor/pdf.worker.min.js")
        : "/static/js/vendor/pdf.worker.min.js";
      lib.GlobalWorkerOptions.workerSrc = workerUrl;
      workerConfigured = true;
    }
    return lib;
  }

  function scaleForViewport(viewport) {
    const base = viewport.width || TARGET_RENDER_WIDTH;
    const scale = TARGET_RENDER_WIDTH / base;
    return Math.max(MIN_SCALE, Math.min(MAX_SCALE, scale));
  }

  function placeholderSlide(index, width, height) {
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(width));
    canvas.height = Math.max(1, Math.round(height));
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.strokeStyle = "rgba(15, 23, 42, 0.14)";
    ctx.lineWidth = 2;
    ctx.strokeRect(1, 1, canvas.width - 2, canvas.height - 2);
    ctx.fillStyle = "#64748b";
    ctx.font = "600 30px Arial, sans-serif";
    ctx.textAlign = "center";
    ctx.fillText(`Rendering page ${index + 1}...`, canvas.width / 2, canvas.height / 2);
    return {
      index,
      pageIndex: index,
      width: canvas.width,
      height: canvas.height,
      image: canvas.toDataURL("image/png"),
      paths: []
    };
  }

  async function renderPage(page, index) {
    const baseViewport = page.getViewport({ scale: 1 });
    const scale = scaleForViewport(baseViewport);
    const viewport = page.getViewport({ scale });
    const nativeWidth = Math.max(1, baseViewport.width);
    const nativeHeight = Math.max(1, baseViewport.height);

    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(viewport.width));
    canvas.height = Math.max(1, Math.round(viewport.height));
    const ctx = canvas.getContext("2d");

    // PDF pages may be transparent; paint white so annotations sit on paper.
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    await page.render({ canvasContext: ctx, viewport, background: "#ffffff" }).promise;

    const slide = {
      index,
      pageIndex: index,
      // PDF.js' scale-1 viewport is the page's native point-sized coordinate
      // system. Keep annotations in that space while retaining the sharper
      // high-resolution canvas above as the backing image.
      width: nativeWidth,
      height: nativeHeight,
      image: canvas.toDataURL("image/jpeg", JPEG_QUALITY),
      paths: []
    };

    // Free the page's internal resources promptly to keep memory flat on big PDFs.
    if (typeof page.cleanup === "function") page.cleanup();
    canvas.width = canvas.height = 0;
    return slide;
  }

  function yieldToUi() {
    return new Promise((resolve) => window.setTimeout(resolve, 0));
  }

  async function importPdfLocally(file, callbacks = {}) {
    if (!file?.name?.toLowerCase().endsWith(".pdf")) {
      throw new Error("Fast local import supports .pdf files.");
    }

    const lib = await ensureWorker();
    const buffer = await file.arrayBuffer();

    // Keep the upload itself before a single page is rasterised. Everything
    // rendered below is a cache of this; exports and re-renders read from it.
    // A browser that will not store it still gets the old raster-only import,
    // so a failure here degrades quality rather than blocking the import.
    let docId = null;
    try {
      const stored = await window.Inkyscib?.DocStore?.putDocument(file, {
        name: file.name,
        type: "application/pdf"
      });
      docId = stored?.id || null;
    } catch (error) {
      console.warn("Could not keep the original PDF; falling back to raster-only import.", error);
      callbacks.onOriginalUnavailable?.(error);
    }

    const task = lib.getDocument({
      data: new Uint8Array(buffer),
      disableAutoFetch: true,
      disableStream: true,
      isEvalSupported: false
    });

    let pdf;
    try {
      pdf = await task.promise;
    } catch (error) {
      throw new Error("Could not open this PDF.");
    }

    try {
      const total = pdf.numPages;
      if (!total) throw new Error("No pages were found in this PDF.");
      if (total > MAX_PAGES) {
        throw new Error(`This PDF has ${total} pages; the import limit is ${MAX_PAGES}.`);
      }

      // Use the first page's dimensions for placeholders; each rendered page
      // overwrites with its own true size (PDF pages can vary).
      const firstPage = await pdf.getPage(1);
      const firstBase = firstPage.getViewport({ scale: 1 });
      const phW = firstBase.width;
      const phH = firstBase.height;

      const slides = Array.from({ length: total }, (_, index) =>
        placeholderSlide(index, phW, phH)
      );

      let deckActivated = false;

      for (let index = 0; index < total; index += 1) {
        const page = index === 0 ? firstPage : await pdf.getPage(index + 1);
        const slide = await renderPage(page, index);
        slides[index] = slide;

        if (!deckActivated) {
          deckActivated = true;
          callbacks.onDeckReady?.({
            active: true,
            name: file.name,
            renderMode: "pdf",
            docId,
            slides,
            currentSlide: 0
          });
        }

        callbacks.onSlideRendered?.(index, slide, total);
        callbacks.onProgress?.(index + 1, total);
        await yieldToUi();
      }

      return {
        active: true,
        name: file.name,
        renderMode: "pdf",
        docId,
        slides,
        currentSlide: 0
      };
    } finally {
      try {
        await pdf.destroy();
      } catch (error) {
        /* ignore cleanup errors */
      }
    }
  }

  window.importPdfLocally = importPdfLocally;
})();
