(function () {
  "use strict";

  const DEFAULT_PAGE_WIDTH = 794;
  const DEFAULT_PAGE_HEIGHT = 1123;
  const DEFAULT_PAGE_GAP = 96;
  const EXPORT_WIDTH = 1240;

  function state() {
    return window.appState;
  }

  function notebook() {
    const s = state();
    if (!s.notebook) {
      s.notebook = {
        active: false,
        paths: [],
        freeformPaths: [],
        transform: null,
        freeformTransform: null,
        pageWidth: DEFAULT_PAGE_WIDTH,
        pageHeight: DEFAULT_PAGE_HEIGHT,
        pageGap: DEFAULT_PAGE_GAP
      };
    }
    if (!Array.isArray(s.notebook.paths)) s.notebook.paths = [];
    if (!Array.isArray(s.notebook.freeformPaths)) s.notebook.freeformPaths = [];
    return s.notebook;
  }

  function dims() {
    const n = notebook();
    return {
      pageWidth: Number.isFinite(n.pageWidth) ? n.pageWidth : DEFAULT_PAGE_WIDTH,
      pageHeight: Number.isFinite(n.pageHeight) ? n.pageHeight : DEFAULT_PAGE_HEIGHT,
      pageGap: Number.isFinite(n.pageGap) ? n.pageGap : DEFAULT_PAGE_GAP
    };
  }

  function clonePaths(paths) {
    return JSON.parse(JSON.stringify(paths || []));
  }

  function cloneTransform(transform) {
    return {
      scale: Number.isFinite(transform?.scale) ? transform.scale : 1,
      offsetX: Number.isFinite(transform?.offsetX) ? transform.offsetX : 0,
      offsetY: Number.isFinite(transform?.offsetY) ? transform.offsetY : 0
    };
  }

  function requestRender() {
    if (typeof window.render === "function") window.render();
  }

  function safeSave() {
    if (typeof window.saveDrawing === "function") window.saveDrawing();
  }

  function pageStride() {
    const { pageHeight, pageGap } = dims();
    return pageHeight + pageGap;
  }

  function pageTop(index) {
    return index * pageStride();
  }

  function finitePoint(point) {
    return point && Number.isFinite(point.x) && Number.isFinite(point.y);
  }

  function pathBounds(path) {
    if (!path) return null;
    if (typeof window.Inkyscib?.Geometry?.pathBounds === "function") {
      const bounds = window.Inkyscib.Geometry.pathBounds(path);
      if (bounds) return bounds;
    }

    const points = (path.points || []).filter(finitePoint);
    if (!points.length) return null;

    let left = points[0].x;
    let right = points[0].x;
    let top = points[0].y;
    let bottom = points[0].y;
    points.forEach((point) => {
      left = Math.min(left, point.x);
      right = Math.max(right, point.x);
      top = Math.min(top, point.y);
      bottom = Math.max(bottom, point.y);
    });

    const pad = Math.max(4, (path.size || 2) * 1.2);
    return { left: left - pad, right: right + pad, top: top - pad, bottom: bottom + pad };
  }

  function activeNotebookPaths(options = {}) {
    const s = state();
    const paths = [...(s?.paths || [])];
    if (options.includeCurrent && s?.currentPath) paths.push(s.currentPath);
    return paths;
  }

  function writtenPageCount(paths = activeNotebookPaths({ includeCurrent: true })) {
    const { pageHeight } = dims();
    const stride = pageStride();
    let maxPage = -1;

    (paths || []).forEach((path) => {
      const bounds = pathBounds(path);
      if (!bounds) return;
      const topPage = Math.max(0, Math.floor(Math.max(0, bounds.top) / stride));
      const bottomPage = Math.max(0, Math.floor(Math.max(0, bounds.bottom) / stride));

      for (let index = topPage; index <= bottomPage; index += 1) {
        const localTop = bounds.top - pageTop(index);
        const localBottom = bounds.bottom - pageTop(index);
        if (localBottom >= 0 && localTop <= pageHeight) {
          maxPage = Math.max(maxPage, index);
        }
      }
    });

    return maxPage + 1;
  }

  // Blank pages added deliberately past the end of the writing. Content alone
  // cannot imply them, so the notebook carries a floor.
  function addedPageCount() {
    const value = notebook().pageCount;
    return Number.isFinite(value) ? Math.max(0, Math.round(value)) : 0;
  }

  // How many pages the pager treats as existing: whatever has been written on,
  // or whatever was added by hand, whichever reaches further.
  function totalPageCount() {
    return Math.max(1, writtenPageCount(), addedPageCount());
  }

  function scrollPageCount() {
    const s = state();
    const metrics = typeof window.getCanvasMetrics === "function" ? window.getCanvasMetrics() : { height: 0 };
    const { pageHeight } = dims();
    const scale = Math.max(0.05, s?.transform?.scale || 1);
    const pagesForViewport = Math.ceil((metrics.height || 1) / Math.max(1, pageHeight * scale));
    return Math.max(2, writtenPageCount() + 1, pagesForViewport + 1, addedPageCount() + 1);
  }

  // Which page is being read: the one under the middle of the viewport, so a
  // page half-scrolled off the top does not still count as current.
  function currentPageIndex() {
    const s = state();
    const metrics = typeof window.getCanvasMetrics === "function" ? window.getCanvasMetrics() : { height: 0 };
    const scale = Math.max(0.05, s?.transform?.scale || 1);
    const offsetY = Number.isFinite(s?.transform?.offsetY) ? s.transform.offsetY : 0;
    const worldMiddle = ((metrics.height || 0) / 2 - offsetY) / scale;
    const index = Math.floor(worldMiddle / pageStride());
    return Math.max(0, Math.min(index, totalPageCount() - 1));
  }

  // Park the page just under the top of the viewport rather than flush against
  // it, so the first line is not touching the chrome.
  const PAGE_TOP_MARGIN = 24;

  function goToPage(index) {
    const s = state();
    if (!notebook().active) return false;

    const target = Math.max(0, Math.min(index, totalPageCount() - 1));
    const scale = Math.max(0.05, s?.transform?.scale || 1);
    s.transform.offsetY = PAGE_TOP_MARGIN - pageTop(target) * scale;
    clampNotebookTransform();
    requestRender();
    updateNotebookUi();
    safeSave();
    return true;
  }

  function addPage() {
    if (!notebook().active) return false;
    const next = totalPageCount();
    notebook().pageCount = next + 1;
    goToPage(next);
    setNotebookStatus(`Page ${next + 1} added`, "success");
    return true;
  }

  function documentHeight(pageCount = scrollPageCount()) {
    const { pageHeight } = dims();
    return pageCount * pageHeight + Math.max(0, pageCount - 1) * dims().pageGap;
  }

  function normalizeNotebookPoint(point, options = {}) {
    if (!finitePoint(point)) return null;

    const { pageWidth, pageHeight } = dims();
    const stride = pageStride();
    const clamp = !!options.clamp;
    let x = point.x;
    let y = Math.max(0, point.y);
    let page = Math.floor(y / stride);
    let localY = y - pageTop(page);

    if (x < 0 || x > pageWidth) {
      if (!clamp) return null;
      x = Math.max(0, Math.min(pageWidth, x));
    }

    if (localY > pageHeight) {
      if (!clamp) return null;
      const intoGap = localY - pageHeight;
      if (intoGap < dims().pageGap / 2) {
        localY = pageHeight;
      } else {
        page += 1;
        localY = 0;
      }
      y = pageTop(page) + localY;
    }

    return { ...point, x, y };
  }

  function fitNotebookToViewport() {
    const s = state();
    const metrics = typeof window.getCanvasMetrics === "function" ? window.getCanvasMetrics() : { width: 0 };
    const { pageWidth } = dims();
    const pad = (metrics.width || 0) < 720 ? 32 : 96;
    const scale = Math.max(0.18, Math.min(1.25, ((metrics.width || pageWidth) - pad) / pageWidth));

    s.transform.scale = scale;
    s.transform.offsetX = ((metrics.width || pageWidth) - pageWidth * scale) / 2;
    s.transform.offsetY = 24;
    clampNotebookTransform();
  }

  function clampNotebookTransform(target = null) {
    const s = state();
    if (!s?.notebook?.active) return;

    const tr = target || s.transform;
    const metrics = typeof window.getCanvasMetrics === "function" ? window.getCanvasMetrics() : { width: 0, height: 0 };
    const { pageWidth } = dims();
    const edge = (metrics.width || 0) < 720 ? 18 : 34;
    const minScale = Math.max(0.16, Math.min(1, ((metrics.width || pageWidth) - edge * 2) / pageWidth) * 0.72);
    const maxScale = 3.2;

    tr.scale = Math.max(minScale, Math.min(maxScale, tr.scale || 1));

    const pageViewWidth = pageWidth * tr.scale;
    if (pageViewWidth <= (metrics.width || 0) - edge * 2) {
      tr.offsetX = ((metrics.width || pageWidth) - pageViewWidth) / 2;
    } else {
      tr.offsetX = Math.min(edge, Math.max((metrics.width || 0) - pageViewWidth - edge, tr.offsetX));
    }

    const docViewHeight = documentHeight() * tr.scale;
    const topEdge = 24;
    const bottomEdge = 24;
    if (docViewHeight <= (metrics.height || 0) - topEdge - bottomEdge) {
      tr.offsetY = topEdge;
    } else {
      const minY = (metrics.height || 0) - docViewHeight - bottomEdge;
      tr.offsetY = Math.min(topEdge, Math.max(minY, tr.offsetY));
    }
  }

  function themeColors() {
    const light = (document.documentElement.dataset.theme || "dark") === "light";
    return {
      light,
      page: light ? "rgba(255,255,255,0.96)" : "rgba(7,10,15,0.96)",
      border: light ? "rgba(71,85,105,0.22)" : "rgba(255,255,255,0.12)",
      shadow: light ? "rgba(71,85,105,0.12)" : "rgba(0,0,0,0.28)",
      minor: light ? "rgba(15,23,42,0.10)" : "rgba(255,255,255,0.10)",
      major: light ? "rgba(15,23,42,0.17)" : "rgba(255,255,255,0.17)",
      dot: light ? "rgba(15,23,42,0.16)" : "rgba(255,255,255,0.16)"
    };
  }

  function drawPagePattern(ctx, x, y, width, height, options = {}) {
    const pattern = document.documentElement.dataset.pattern || "dot";
    const colors = themeColors();
    const scale = Math.max(0.05, state()?.transform?.scale || 1);
    const lineWidth = options.export ? 1 : 1 / scale;

    ctx.save();
    ctx.beginPath();
    ctx.rect(x, y, width, height);
    ctx.clip();

    if (pattern === "dot") {
      const step = 28;
      const radius = options.export ? 1.2 : Math.max(0.8 / scale, 1.05);
      ctx.fillStyle = colors.dot;
      for (let py = y + step; py < y + height; py += step) {
        for (let px = x + step; px < x + width; px += step) {
          ctx.beginPath();
          ctx.arc(px, py, radius, 0, Math.PI * 2);
          ctx.fill();
        }
      }
    }

    if (pattern === "lines" || pattern === "graph") {
      const step = 32;
      ctx.lineCap = "butt";
      ctx.strokeStyle = colors.minor;
      ctx.lineWidth = lineWidth;

      for (let py = y + step; py < y + height; py += step) {
        ctx.beginPath();
        ctx.moveTo(x, py);
        ctx.lineTo(x + width, py);
        ctx.stroke();
      }

      if (pattern === "graph") {
        for (let px = x + step; px < x + width; px += step) {
          ctx.beginPath();
          ctx.moveTo(px, y);
          ctx.lineTo(px, y + height);
          ctx.stroke();
        }

        ctx.strokeStyle = colors.major;
        ctx.lineWidth = lineWidth * 1.25;
        for (let py = y + step * 5; py < y + height; py += step * 5) {
          ctx.beginPath();
          ctx.moveTo(x, py);
          ctx.lineTo(x + width, py);
          ctx.stroke();
        }
        for (let px = x + step * 5; px < x + width; px += step * 5) {
          ctx.beginPath();
          ctx.moveTo(px, y);
          ctx.lineTo(px, y + height);
          ctx.stroke();
        }
      }
    }

    ctx.restore();
  }

  function drawNotebookPage(ctx, index, options = {}) {
    const { pageWidth, pageHeight } = dims();
    const y = options.export ? 0 : pageTop(index);
    const colors = themeColors();
    const scale = Math.max(0.05, state()?.transform?.scale || 1);
    const lineWidth = options.export ? 1.3 : 1.2 / scale;

    ctx.save();
    if (!options.export) {
      ctx.shadowColor = colors.shadow;
      ctx.shadowBlur = 22 / scale;
      ctx.shadowOffsetY = 10 / scale;
    }
    ctx.fillStyle = colors.page;
    ctx.fillRect(0, y, pageWidth, pageHeight);
    ctx.restore();

    drawPagePattern(ctx, 0, y, pageWidth, pageHeight, options);

    ctx.save();
    ctx.lineWidth = lineWidth;
    ctx.strokeStyle = colors.border;
    ctx.strokeRect(0, y, pageWidth, pageHeight);
    ctx.restore();
  }

  function renderNotebookBackground(ctx, canvas) {
    const s = state();
    if (!s?.notebook?.active) return;

    const tr = s.transform;
    // canvas.height is in device pixels; page layout works in CSS pixels.
    const ratio = typeof window.getCanvasPixelRatio === 'function' ? window.getCanvasPixelRatio() : 1;
    const top = (-tr.offsetY) / tr.scale;
    const bottom = (canvas.height / ratio - tr.offsetY) / tr.scale;
    const stride = pageStride();
    const first = Math.max(0, Math.floor((top - dims().pageGap) / stride));
    const last = Math.min(scrollPageCount() - 1, Math.ceil(bottom / stride));

    for (let index = first; index <= last; index += 1) {
      drawNotebookPage(ctx, index);
    }
  }

  function syncCurrentNotebookPaths() {
    const s = state();
    if (!s?.notebook?.active) return;
    notebook().paths = clonePaths(s.paths);
    notebook().transform = cloneTransform(s.transform);
  }

  function setNotebookStatus(message, tone = "muted") {
    const status = document.getElementById("notebookModeStatus");
    if (!status) return;
    status.textContent = message;
    status.dataset.tone = tone;
  }

  function updateNotebookUi() {
    const s = state();
    const n = notebook();
    const active = !!n.active;
    const toggle = document.getElementById("notebookModeToggle");
    const exportTool = document.getElementById("notebookExportTool");

    document.body.classList.toggle("notebook-active", active);
    if (toggle) toggle.setAttribute("aria-pressed", active ? "true" : "false");
    if (exportTool) {
      exportTool.hidden = !active;
      exportTool.classList.toggle("active", active);
    }

    syncPager(active);

    const status = document.getElementById("notebookModeStatus");
    if (status?.dataset.tone === "loading") return;

    if (active) {
      const count = Math.max(1, writtenPageCount(s.paths));
      setNotebookStatus(`On · ${count} page${count === 1 ? "" : "s"}`, "success");
    } else {
      setNotebookStatus("Off · infinite canvas", "muted");
    }
  }

  // The pager shares the slide navigator's shell so the two read as the same
  // control in the same corner. Slides and notebook pages never coexist, so
  // only one of them is ever on screen.
  function syncPager(active) {
    const nav = document.getElementById("notebookPageNav");
    if (!nav) return;

    const pptActive = !!state()?.ppt?.active;
    const visible = active && !pptActive;
    nav.hidden = !visible;
    if (!visible) return;

    const total = totalPageCount();
    const current = currentPageIndex();

    const counter = document.getElementById("notebookPageCounter");
    if (counter) counter.textContent = `${current + 1} / ${total}`;

    const prev = document.getElementById("notebookPrevPage");
    const next = document.getElementById("notebookNextPage");
    if (prev) prev.disabled = current <= 0;
    if (next) next.disabled = current >= total - 1;
  }

  function setNotebookMode(active, options = {}) {
    const s = state();
    const n = notebook();
    const next = !!active;
    if (next === !!n.active) {
      updateNotebookUi();
      return true;
    }

    if (next && s.ppt?.active) {
      setNotebookStatus("Close PPT before Notebook Mode.", "error");
      return false;
    }

    if (next) {
      n.freeformPaths = clonePaths(s.paths);
      n.freeformTransform = cloneTransform(s.transform);
      n.active = true;
      s.paths = clonePaths(n.paths);
      s.undoStack = [];
      s.redoStack = [];
      s.currentPath = null;
      s.transform = n.transform ? cloneTransform(n.transform) : { scale: 1, offsetX: 0, offsetY: 24 };
      fitNotebookToViewport();
    } else {
      syncCurrentNotebookPaths();
      n.active = false;
      s.paths = clonePaths(n.freeformPaths);
      s.undoStack = [];
      s.redoStack = [];
      s.currentPath = null;
      s.transform = n.freeformTransform ? cloneTransform(n.freeformTransform) : { scale: 1, offsetX: 0, offsetY: 0 };
    }

    if (window.Inkyscib?.Selection?.clear) {
      window.Inkyscib.Selection.clear({ render: false });
    }

    updateNotebookUi();
    requestRender();
    if (options.persist !== false) safeSave();
    return true;
  }

  // `width` is the backing bitmap width in pixels. Callers that know what
  // resolution they need — a PNG export at a chosen DPI — pass their own;
  // everything else gets EXPORT_WIDTH.
  async function renderNotebookPageImage(index, width) {
    const { pageWidth, pageHeight } = dims();
    const targetWidth = Number.isFinite(width) && width > 0
      ? Math.round(width)
      : EXPORT_WIDTH;
    const exportHeight = Math.round(targetWidth * (pageHeight / pageWidth));
    const canvas = document.createElement("canvas");
    canvas.width = targetWidth;
    canvas.height = exportHeight;

    const ctx = canvas.getContext("2d");
    const scale = targetWidth / pageWidth;
    const top = pageTop(index);

    ctx.setTransform(scale, 0, 0, scale, 0, 0);
    drawNotebookPage(ctx, index, { export: true });

    ctx.save();
    ctx.setTransform(scale, 0, 0, scale, 0, -top * scale);
    ctx.beginPath();
    ctx.rect(0, top, pageWidth, pageHeight);
    ctx.clip();
    activeNotebookPaths().forEach((path) => {
      if (typeof window.drawInkyscibPathForExport === "function") {
        window.drawInkyscibPathForExport(ctx, path);
      }
    });
    ctx.restore();

    return canvas.toDataURL("image/png");
  }

  async function exportNotebookPdf() {
    const s = state();
    if (!s?.notebook?.active) return;

    syncCurrentNotebookPaths();
    const pageCount = writtenPageCount(s.paths);
    if (!pageCount) {
      setNotebookStatus("Write notes before exporting.", "error");
      return;
    }

    const exportTool = document.getElementById("notebookExportTool");
    exportTool?.classList.add("active");
    setNotebookStatus("Preparing PDF...", "loading");

    try {
      const images = [];
      const { pageWidth, pageHeight } = dims();
      for (let index = 0; index < pageCount; index += 1) {
        images.push({
          image: await renderNotebookPageImage(index),
          width: pageWidth,
          height: pageHeight,
          unit: "px"
        });
      }

      let blob;
      const helpers = window.Inkyscib?.PptExport;
      if (helpers?.buildLocalPdf) {
        blob = await helpers.buildLocalPdf(images);
      } else if (helpers?.exportDeckViaServer) {
        blob = await helpers.exportDeckViaServer("pdf", images, "inkyscib-notebook");
      } else {
        const response = await fetch("/api/ppt/export/pdf", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ filename: "inkyscib-notebook", slides: images })
        });
        if (!response.ok) throw new Error("PDF export failed.");
        blob = await response.blob();
      }

      if (helpers?.downloadBlob) {
        helpers.downloadBlob(blob, "inkyscib-notebook.pdf");
      } else {
        const url = URL.createObjectURL(blob);
        const anchor = document.createElement("a");
        anchor.href = url;
        anchor.download = "inkyscib-notebook.pdf";
        document.body.appendChild(anchor);
        anchor.click();
        anchor.remove();
        window.setTimeout(() => URL.revokeObjectURL(url), 1000);
      }

      setNotebookStatus(`PDF ready · ${pageCount} page${pageCount === 1 ? "" : "s"}`, "success");
      window.setTimeout(updateNotebookUi, 1800);
    } catch (error) {
      console.error("Notebook PDF export failed", error);
      setNotebookStatus(error.message || "PDF export failed.", "error");
    } finally {
      exportTool?.classList.remove("active");
    }
  }

  function initNotebookUi() {
    const toggle = document.getElementById("notebookModeToggle");
    const exportTool = document.getElementById("notebookExportTool");

    document.getElementById("notebookPrevPage")?.addEventListener("click", () => {
      goToPage(currentPageIndex() - 1);
    });
    document.getElementById("notebookNextPage")?.addEventListener("click", () => {
      goToPage(currentPageIndex() + 1);
    });
    document.getElementById("notebookAddPage")?.addEventListener("click", () => addPage());

    if (toggle) {
      toggle.addEventListener("click", () => setNotebookMode(!notebook().active, { persist: true }));
    }
    if (exportTool) {
      exportTool.addEventListener("click", (event) => {
        event.stopPropagation();
        exportNotebookPdf();
      });
    }

    if (notebook().active) {
      state().paths = clonePaths(notebook().paths);
      state().transform = notebook().transform ? cloneTransform(notebook().transform) : state().transform;
      if (!notebook().transform) fitNotebookToViewport();
    }

    updateNotebookUi();
    if (notebook().active) requestRender();
  }

  window.renderNotebookBackground = renderNotebookBackground;
  window.clampNotebookTransform = clampNotebookTransform;
  window.fitNotebookToViewport = fitNotebookToViewport;
  window.normalizeNotebookPoint = normalizeNotebookPoint;
  window.setNotebookMode = setNotebookMode;
  window.syncNotebookCurrentPaths = syncCurrentNotebookPaths;
  window.exportNotebookPdf = exportNotebookPdf;
  window.getNotebookWrittenPageCount = writtenPageCount;
  window.Inkyscib = window.Inkyscib || {};
  window.Inkyscib.Notebook = {
    dims,
    pageTop,
    writtenPageCount,
    scrollPageCount,
    normalizeNotebookPoint,
    setNotebookMode,
    exportNotebookPdf,
    syncCurrentNotebookPaths,
    updateNotebookUi,
    totalPageCount,
    currentPageIndex,
    goToPage,
    addPage,
    renderPageImage: renderNotebookPageImage
  };

  document.addEventListener("DOMContentLoaded", initNotebookUi);
  document.addEventListener("canvasRendered", updateNotebookUi);
})();
