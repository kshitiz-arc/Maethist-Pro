// Lossless PDF export.
//
// The old export drew every page into a canvas, JPEGed it, and wrapped the
// result in a new PDF — so a textbook came back as a photograph of itself, 62
// times larger, with its text layer gone.
//
// This one opens the *original* file kept by doc-store.js and appends ink to
// the pages it already has. The page objects are copied through untouched, so
// text stays selectable and searchable, vector figures stay vector, embedded
// images keep their own encoding, and a page you did not draw on comes out
// byte-identical to the one you uploaded.
//
// Where a path cannot be reproduced as vector geometry — a calligraphy nib, a
// stroke that has been erased into, a compass construction — that path alone
// is rendered to a lossless PNG at print resolution and placed over its own
// bounding box. The page underneath is still untouched, and the export reports
// what it had to do so the UI can say so rather than quietly rounding down.
(function () {
  "use strict";

  // Rasterised fallbacks are placed at this resolution. High enough that a
  // fallback is indistinguishable in print from the vector it replaces.
  const FALLBACK_DPI = 400;
  const POINTS_PER_INCH = 72;

  let pdfLibPromise = null;

  // pdf-lib is ~525 KB and only an export needs it, so it is fetched on first
  // use rather than at page load. Vendored, not from a CDN, so this keeps
  // working offline.
  function loadPdfLib() {
    if (window.PDFLib) return Promise.resolve(window.PDFLib);
    if (pdfLibPromise) return pdfLibPromise;

    pdfLibPromise = new Promise((resolve, reject) => {
      const script = document.createElement("script");
      script.src = pdfLibUrl();
      script.onload = () => {
        if (window.PDFLib) resolve(window.PDFLib);
        else reject(new Error("The PDF writer failed to start."));
      };
      script.onerror = () => reject(new Error("The PDF writer could not be loaded."));
      document.head.appendChild(script);
    });
    return pdfLibPromise;
  }

  function pdfLibUrl() {
    const existing = document.querySelector('script[src*="pdf-export.js"]');
    const src = existing?.getAttribute("src") || "/static/js/pdf-export.js";
    return src.replace(/pdf-export\.js.*$/, "vendor/pdf-lib.min.js");
  }

  function vector() {
    return window.Inkyscib?.PdfVector || null;
  }

  // ---------- per-page resources ----------

  /**
   * Registers the ExtGStates a page's ink needs and hands back their names.
   *
   * Alpha and blend mode are graphics-state parameters in PDF, not path
   * parameters, so each distinct combination becomes one dictionary in the
   * page's resources and is referenced by name from the content stream.
   */
  function makeResources(PDFLib, page) {
    const cache = new Map();
    return {
      alpha(fillAlpha, strokeAlpha, blendMode) {
        const key = [fillAlpha, strokeAlpha, blendMode].join("|");
        if (cache.has(key)) return cache.get(key);

        const entries = { Type: "ExtGState" };
        if (Number.isFinite(fillAlpha)) entries.ca = fillAlpha;
        if (Number.isFinite(strokeAlpha)) entries.CA = strokeAlpha;
        if (blendMode) entries.BM = blendMode;

        const name = page.node.newExtGState(
          "InkyGS",
          page.doc.context.obj(entries)
        );
        const text = name.asString().replace(/^\//, "");
        cache.set(key, text);
        return text;
      }
    };
  }

  // ---------- raster fallback for one path ----------

  function pathBounds(path) {
    const geometry = window.Inkyscib?.Geometry;
    const bounds = geometry?.pathBounds?.(path);
    if (bounds && Number.isFinite(bounds.minX)) return bounds;

    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    (path?.points || []).forEach((point) => {
      if (!Number.isFinite(point?.x) || !Number.isFinite(point?.y)) return;
      minX = Math.min(minX, point.x);
      minY = Math.min(minY, point.y);
      maxX = Math.max(maxX, point.x);
      maxY = Math.max(maxY, point.y);
    });
    return Number.isFinite(minX) ? { minX, minY, maxX, maxY } : null;
  }

  function canvasToPngBytes(canvas) {
    return new Promise((resolve, reject) => {
      canvas.toBlob(async (blob) => {
        if (!blob) {
          reject(new Error("A page overlay could not be encoded."));
          return;
        }
        resolve(new Uint8Array(await blob.arrayBuffer()));
      }, "image/png");
    });
  }

  /**
   * One path, rendered alone to a transparent PNG covering just its own box.
   *
   * Transparent so the page beneath shows through: the fallback replaces the
   * stroke, never the document under it.
   */
  async function rasterisePath(path) {
    const bounds = pathBounds(path);
    if (!bounds) return null;

    // Ink is wider than its centreline, and pen styles bloom past their size.
    const pad = Math.max(8, (path.size || 2) * 3);
    const left = bounds.minX - pad;
    const top = bounds.minY - pad;
    const width = bounds.maxX - bounds.minX + pad * 2;
    const height = bounds.maxY - bounds.minY + pad * 2;
    if (!(width > 0) || !(height > 0)) return null;

    const scale = FALLBACK_DPI / POINTS_PER_INCH;
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.min(8000, Math.round(width * scale)));
    canvas.height = Math.max(1, Math.min(8000, Math.round(height * scale)));

    const ctx = canvas.getContext("2d");
    ctx.setTransform(canvas.width / width, 0, 0, canvas.height / height, 0, 0);
    ctx.translate(-left, -top);
    if (typeof window.drawInkyscibPathForExport === "function") {
      window.drawInkyscibPathForExport(ctx, path);
    }

    return { bytes: await canvasToPngBytes(canvas), left, top, width, height };
  }

  // ---------- the export ----------

  /**
   * Write the deck out as a PDF built on its own original file.
   *
   * Returns { blob, mode, pagesInked, vectorPaths, rasterPaths, notes }.
   */
  async function exportDeckOntoOriginal(deck) {
    const docStore = window.Inkyscib?.DocStore;
    const vec = vector();
    if (!deck?.docId || !docStore || !vec) {
      throw new Error("This document has no stored original to export onto.");
    }

    const original = await docStore.getDocumentBytes(deck.docId);
    if (!original) throw new Error("The original file for this document is no longer stored.");

    const PDFLib = await loadPdfLib();
    const pdf = await PDFLib.PDFDocument.load(original);

    let pagesInked = 0;
    let vectorPaths = 0;
    let rasterPaths = 0;

    for (const slide of deck.slides || []) {
      const paths = (slide.paths || []).filter((path) => path && path.tool !== "eraser");
      if (!paths.length) continue;

      const index = Number.isFinite(slide.pageIndex) ? slide.pageIndex : slide.index;
      if (!(index >= 0 && index < pdf.getPageCount())) continue;

      const page = pdf.getPage(index);
      const resources = makeResources(PDFLib, page);

      const viewBox = readViewBox(page);
      const rotation = page.getRotation()?.angle || 0;
      const matrix = vec.viewportToPdfMatrix(rotation, viewBox);

      const body = [];
      const overlays = [];

      for (const path of paths) {
        const ops = vec.pathToOperators(path, resources);
        if (ops) {
          body.push("q", ops, "Q");
          vectorPaths += 1;
        } else {
          const raster = await rasterisePath(path);
          if (raster) {
            overlays.push(raster);
            rasterPaths += 1;
          }
        }
      }

      for (const overlay of overlays) {
        const image = await pdf.embedPng(overlay.bytes);
        const name = page.node.newXObject("InkyImg", image.ref);
        const tag = name.asString().replace(/^\//, "");
        // Images draw into a unit square, so scale and move it into place. The
        // extra -1 on y and the shift by height flip it back the right way up
        // inside the y-down space this content stream works in.
        body.push(
          "q",
          `${fixed(overlay.width)} 0 0 ${fixed(-overlay.height)} ` +
            `${fixed(overlay.left)} ${fixed(overlay.top + overlay.height)} cm`,
          `/${tag} Do`,
          "Q"
        );
      }

      if (!body.length) continue;

      // Wrap whatever the page already draws so its graphics state cannot leak
      // into ours, then append. Pages with no ink are never touched at all,
      // which is what keeps them byte-identical.
      page.node.wrapContentStreams(
        pdf.context.getPushGraphicsStateContentStream(),
        pdf.context.getPopGraphicsStateContentStream()
      );

      const content = ["q", matrix.map(fixed).join(" ") + " cm", ...body, "Q"].join("\n");
      page.node.addContentStream(pdf.context.register(pdf.context.flateStream(content)));
      pagesInked += 1;
    }

    const bytes = await pdf.save();
    return {
      blob: new Blob([bytes], { type: "application/pdf" }),
      mode: "vector",
      pagesInked,
      vectorPaths,
      rasterPaths,
      notes: buildNotes(vectorPaths, rasterPaths)
    };
  }

  function buildNotes(vectorPaths, rasterPaths) {
    if (!rasterPaths) return "Original pages untouched; every stroke exported as vector.";
    return (
      "Original pages untouched. " +
      vectorPaths + " stroke" + (vectorPaths === 1 ? "" : "s") + " exported as vector; " +
      rasterPaths + " that PDF cannot draw exactly " +
      (rasterPaths === 1 ? "was" : "were") + " placed as " + FALLBACK_DPI + " DPI images."
    );
  }

  function fixed(value) {
    if (!Number.isFinite(value)) return "0";
    const rounded = Math.round(value * 1000) / 1000;
    return Object.is(rounded, -0) ? "0" : String(rounded);
  }

  /**
   * The box PDF.js laid this page out in: its CropBox clipped to its MediaBox.
   *
   * Annotations are stored in viewport coordinates, and PDF.js builds that
   * viewport from `Page#view` — not from the MediaBox. The two are the same
   * only on an uncropped page; where they differ, using the MediaBox here
   * moves every stroke on the page by the offset between the boxes, which on
   * a page cropped at the top reads as ink sitting slightly too high.
   *
   * Mirrors PDF.js' own rule: a missing CropBox, one with no area, or one that
   * misses the MediaBox entirely is ignored in favour of the MediaBox.
   */
  function readViewBox(page) {
    const mediaBox = readPageBox(page, "MediaBox") || fallbackBox(page);
    const cropBox = readPageBox(page, "CropBox");
    if (!cropBox) return mediaBox;
    return intersectBoxes(cropBox, mediaBox) || mediaBox;
  }

  /** One page box as a normalised [x0, y0, x1, y1], or null if unusable. */
  function readPageBox(page, name) {
    let raw = null;
    try {
      const box = name === "CropBox" ? page.node.CropBox() : page.node.MediaBox();
      if (box && typeof box.asRectangle === "function") {
        const rect = box.asRectangle();
        raw = [rect.x, rect.y, rect.x + rect.width, rect.y + rect.height];
      } else if (box && typeof box.size === "function" && box.size() >= 4) {
        raw = [0, 1, 2, 3].map((index) => box.lookup(index).asNumber());
      }
    } catch (error) {
      console.warn("Could not read a page's " + name + ".", error);
      return null;
    }
    if (!raw || !raw.every((value) => Number.isFinite(value))) return null;

    const normalised = [
      Math.min(raw[0], raw[2]),
      Math.min(raw[1], raw[3]),
      Math.max(raw[0], raw[2]),
      Math.max(raw[1], raw[3])
    ];
    // A box with no area would collapse the page to a point.
    if (!(normalised[2] > normalised[0]) || !(normalised[3] > normalised[1])) return null;
    return normalised;
  }

  function intersectBoxes(a, b) {
    const x0 = Math.max(a[0], b[0]);
    const y0 = Math.max(a[1], b[1]);
    const x1 = Math.min(a[2], b[2]);
    const y1 = Math.min(a[3], b[3]);
    return x1 > x0 && y1 > y0 ? [x0, y0, x1, y1] : null;
  }

  function fallbackBox(page) {
    const size = page.getSize();
    return [0, 0, size.width, size.height];
  }

  function canExportOntoOriginal(deck) {
    return !!(deck?.docId && window.Inkyscib?.DocStore && vector());
  }

  window.Inkyscib = window.Inkyscib || {};
  window.Inkyscib.PdfExport = {
    exportDeckOntoOriginal,
    canExportOntoOriginal,
    loadPdfLib,
    // exported for tests
    readViewBox
  };
})();
