// The File ribbon: New, Open, Save, Save As, Import and Export in one place.
//
// Everything here already existed somewhere in the app — PDF import behind a
// side-menu button, deck export in a floating panel, notebooks in a modal —
// which meant the answer to "how do I save this?" depended on which mode you
// happened to be in. This puts the document commands where a document
// application puts them, and makes each one say what it will actually do.
//
// The commands are thin: they delegate to Library, Inkydoc, the deck exporter
// and the notebook exporter. What this module owns is availability (a command
// that cannot work is disabled with the reason), the quality readout, and the
// keyboard shortcuts.
(function () {
  "use strict";

  const TABS = ["file", "insert", "export", "tools", "recent"];
  // The File panel's own sections. Insert, Export and Tools are tabs on the
  // ribbon itself, and listing them in this rail as well offered each twice.
  const RAIL_TABS = ["file", "recent"];

  // Recent is part of File, so it keeps the File tab marked as open.
  function ribbonTabFor(tab) {
    return RAIL_TABS.includes(tab) ? "file" : tab;
  }

  let root = null;
  let scrim = null;
  let backstage = null;
  let openTab = null;
  let statusTimer = null;

  // ---------- small helpers ----------

  function state() {
    return window.appState;
  }

  function library() {
    return window.Inkyscib?.Library || null;
  }

  function mode() {
    const s = state();
    if (s?.ppt?.active) return "slides";
    if (s?.notebook?.active) return "pages";
    return "canvas";
  }

  function deck() {
    const s = state();
    return s?.ppt?.active ? s.ppt : null;
  }

  // Lucide, from the vendored registry (static/js/icon-set.js, rendered by
  // static/js/icons.js). The keys are the names the panes and commands use.
  const ICON_REFS = {
    file: "file", insert: "plus", export: "upload", recent: "clock-arrow-down",
    tools: "sliders-horizontal", timer: "timer", planner: "calendar-check",
    video: "tv-minimal-play", camera: "camera", guide: "map", open: "folder-open",
    save: "save", saveAs: "save-all", plus: "plus", pdf: "file-text", slides: "presentation",
    image: "image", package: "package", backup: "hard-drive-download", book: "book-open",
    trash: "trash", rename: "pencil-line", ocr: "scan-text"
  };
  const ICONS = {};
  Object.keys(ICON_REFS).forEach((key) => {
    ICONS[key] = window.Inkyscib?.Icon?.svg?.("lucide:" + ICON_REFS[key]) || "";
  });

  function setStatus(message, tone = "muted") {
    // The status line is inside the sheet. When the sheet is closed -- which
    // most commands do before they finish -- the outcome goes to the shared
    // on-screen notice instead (static/js/notify.js).
    const sheetOpen = !!document.querySelector(".file-backstage.is-open");
    if (message && !sheetOpen && (tone === "error" || tone === "success")) {
      window.Inkyscib?.notify?.(message, { tone });
    }
    const element = document.getElementById("fileBackstageStatus");
    if (!element) return;
    window.clearTimeout(statusTimer);
    element.textContent = message || "";
    element.dataset.tone = message ? tone : "muted";
    if (message && tone !== "loading") {
      statusTimer = window.setTimeout(() => {
        if (element.textContent === message) element.textContent = "";
      }, 6000);
    }
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

  function pickFile(accept) {
    return new Promise((resolve) => {
      const input = document.createElement("input");
      input.type = "file";
      input.accept = accept;
      input.hidden = true;
      document.body.appendChild(input);
      input.addEventListener("change", () => {
        const file = input.files && input.files[0];
        input.remove();
        resolve(file || null);
      }, { once: true });
      // A cancelled picker fires nothing in most browsers, so the promise is
      // simply never settled and the input is cleaned up on the next open.
      input.click();
    });
  }

  function clickExisting(id) {
    const button = document.getElementById(id);
    if (!button) return false;
    button.click();
    return true;
  }

  // ---------- the commands ----------

  // Each command reports why it cannot run, so the button can be disabled with
  // that reason rather than failing after the click.
  const COMMANDS = {
    new: {
      title: "New notebook",
      note: "Start a fresh canvas. The current one is kept in My Notebooks.",
      key: "Ctrl+N",
      icon: "plus",
      run: async () => {
        await library()?.createDocument();
        setStatus("New notebook created.", "success");
      }
    },

    open: {
      title: "Open",
      note: "Open a .maedoc document or restore a .mae library backup.",
      key: "Ctrl+O",
      icon: "open",
      run: async () => {
        const file = await pickFile(".maedoc,.mae,.json");
        if (!file) return;

        if (window.Inkyscib?.Inkydoc?.isInkydocName(file.name)) {
          setStatus("Opening " + file.name + "…", "loading");
          const manifest = await window.Inkyscib.Inkydoc.open(file);
          setStatus("Opened “" + (manifest.title || file.name) + "”.", "success");
          return;
        }

        setStatus("Restoring library backup…", "loading");
        await library()?.importBackup(file);
        setStatus("Backup restored.", "success");
      }
    },

    save: {
      title: "Save",
      note: "Write the current work into this notebook straight away.",
      key: "Ctrl+S",
      icon: "save",
      run: async () => {
        setRibbonState("working");
        await library()?.snapshotActiveWorkspace();
        setRibbonState("saved");
        setStatus("Saved.", "success");
      }
    },

    saveAs: {
      title: "Save as",
      note: "One .maedoc file holding the original document and every stroke, still editable when reopened.",
      key: "Ctrl+Shift+S",
      icon: "saveAs",
      run: async () => {
        setStatus("Packing document…", "loading");
        const built = await window.Inkyscib.Inkydoc.build();
        downloadBlob(built.blob, built.filename);
        setStatus(
          built.includedOriginal
            ? "Saved " + built.filename + " with the original PDF inside."
            : "Saved " + built.filename + ".",
          "success"
        );
      }
    },

    clear: {
      title: "Clear canvas",
      note: "Wipes every stroke on this canvas. Undo can bring them back.",
      icon: "trash",
      run: async () => {
        close();
        // Lives here rather than in the top bar, where it sat one control away
        // from Undo. clearCanvas() raises its own confirm modal.
        if (typeof window.clearCanvasAction === "function") {
          window.clearCanvasAction();
        }
      }
    },

    notebooks: {
      title: "My Notebooks",
      note: "Switch between notebooks, rename them, or delete one.",
      icon: "book",
      run: async () => {
        close();
        library()?.openLibraryModal();
      }
    },

    pages: {
      title: "Notebook pages",
      note: "Switch between one infinite canvas and A4-style pages.",
      icon: "book",
      run: async () => {
        close();
        // Pages changes the shape of the document, so it belongs with the
        // document commands rather than in a settings drawer.
        clickExisting("notebookModeToggle");
      }
    },

    backup: {
      title: "Back up everything",
      note: "Download every notebook as a single .mae file.",
      icon: "backup",
      run: async () => {
        setStatus("Building backup…", "loading");
        await library()?.exportBackup();
        setStatus("Backup downloaded.", "success");
      }
    },

    importPdf: {
      title: "PDF",
      note: "Write on a textbook, worksheet or question paper.",
      icon: "pdf",
      run: async () => {
        close();
        clickExisting("pdfImportBtn");
      }
    },

    importPpt: {
      title: "PowerPoint",
      note: "Annotate a .ppt or .pptx deck slide by slide.",
      icon: "slides",
      run: async () => {
        close();
        clickExisting("pptImportBtn");
      }
    },

    importImage: {
      title: "Image",
      note: "Drop a picture onto the canvas and move or resize it.",
      icon: "image",
      run: async () => {
        close();
        clickExisting("imageInsertBtn");
      }
    },

    planner: {
      title: "Planner",
      note: "Plan your day. Everything stays in this browser.",
      icon: "planner",
      run: async () => {
        close();
        // Its own menu button does not respond to a programmatic click, so go
        // through the module's API and keep the button only as a fallback.
        if (window.Inkyscib?.Planner?.open) window.Inkyscib.Planner.open();
        else clickExisting("plannerBtn");
      }
    },

    pomodoro: {
      title: "Pomodoro",
      note: "A focus timer with breaks, and a count of what you got through.",
      icon: "timer",
      run: async () => {
        close();
        clickExisting("pomodoroBtn");
      }
    },

    ocr: {
      title: "Image to text",
      note: "Box handwriting on the page, or pick a photo, and get it back as LaTeX or text.",
      icon: "ocr",
      run: async () => {
        close();
        window.Inkyscib?.Ocr?.start?.();
      }
    },

    youtube: {
      title: "YouTube",
      note: "A movable player you can take a frame from onto the page.",
      icon: "video",
      run: async () => {
        close();
        clickExisting("ytToggleBtn");
      }
    },

    arInky: {
      title: "Sora Sketch",
      note: "Pinch to draw in the air over what the camera sees.",
      icon: "camera",
      run: async () => {
        close();
        if (window.Inkyscib?.AR?.toggleAR) window.Inkyscib.AR.toggleAR();
        else clickExisting("arBtn");
      }
    },

    featureTour: {
      title: "Feature tour",
      note: "A short guided pass over the workspace.",
      icon: "guide",
      run: async () => {
        close();
        if (window.Inkyscib?.FeatureTour?.open) window.Inkyscib.FeatureTour.open();
        else clickExisting("featureTourBtn");
      }
    },

    exportPdf: {
      title: "PDF",
      note: "The whole document or notebook as a PDF.",
      icon: "pdf",
      blockedBy: () => {
        if (mode() === "slides") return null;
        if (mode() === "pages") return null;
        return "Import a document or turn on Pages first.";
      },
      run: async () => {
        close();
        if (mode() === "slides") {
          await window.exportPptDeck("pdf");
        } else {
          await window.exportNotebookPdf();
        }
      }
    },

    exportPptx: {
      title: "PowerPoint",
      note: "Each page as a slide in a .pptx deck.",
      icon: "slides",
      blockedBy: () => (mode() === "slides" ? null : "Import a PDF or deck first."),
      run: async () => {
        close();
        await window.exportPptDeck("pptx");
      }
    },

    exportPng: {
      title: "PNG image",
      note: "The current page, lossless, at 300 DPI.",
      icon: "image",
      blockedBy: () => (hasAnythingToExport() ? null : "There is nothing on the page yet."),
      run: async () => {
        setStatus("Rendering image…", "loading");
        const result = await exportCurrentPagePng();
        downloadBlob(result.blob, result.filename);
        setStatus("Saved " + result.filename + " at " + result.width + " px wide.", "success");
      }
    },

    exportInkydoc: {
      title: ".maedoc",
      note: "Keeps everything editable. The format to use if you will come back to this.",
      icon: "package",
      run: () => COMMANDS.saveAs.run()
    }
  };

  // ---------- PNG export ----------

  const PNG_DPI = 300;

  function hasAnythingToExport() {
    const s = state();
    if (!s) return false;
    if (s.ppt?.active) return true;
    if (s.notebook?.active) return true;
    return Array.isArray(s.paths) && s.paths.length > 0;
  }

  function loadImage(src) {
    return new Promise((resolve, reject) => {
      const image = new Image();
      image.onload = () => resolve(image);
      image.onerror = () => reject(new Error("That page image could not be read."));
      image.src = src;
    });
  }

  function canvasToPngBlob(canvas) {
    return new Promise((resolve, reject) => {
      // PNG only, and no quality argument: an export must never be the step
      // that introduces a lossy codec.
      canvas.toBlob((blob) => {
        if (blob) resolve(blob);
        else reject(new Error("The image could not be encoded."));
      }, "image/png");
    });
  }

  async function exportCurrentPagePng() {
    const s = state();
    const paintPaths = (ctx, paths) => {
      (paths || []).forEach((path) => {
        if (typeof window.drawInkyscibPathForExport === "function") {
          window.drawInkyscibPathForExport(ctx, path);
        }
      });
    };

    if (s?.ppt?.active) {
      if (typeof window.syncPptCurrentSlidePaths === "function") window.syncPptCurrentSlidePaths();
      const slide = s.ppt.slides[s.ppt.currentSlide || 0];
      const image = await loadImage(slide.image);

      // Export at whichever is sharper: the page's backing bitmap, or the
      // requested DPI. Never below the source, never a resample down.
      const dpiWidth = Math.round((slide.width / 72) * PNG_DPI);
      const width = Math.max(image.naturalWidth || 0, dpiWidth);
      const scale = width / slide.width;
      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = Math.round(slide.height * scale);

      const ctx = canvas.getContext("2d");
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
      ctx.scale(scale, scale);
      paintPaths(ctx, slide.paths);

      return {
        blob: await canvasToPngBlob(canvas),
        filename: pageFilename(s.ppt.name, (s.ppt.currentSlide || 0) + 1),
        width: canvas.width
      };
    }

    if (s?.notebook?.active) {
      const notebook = window.Inkyscib?.Notebook;
      if (!notebook?.renderPageImage) throw new Error("Pages are still loading.");
      notebook.syncCurrentNotebookPaths?.();

      const index = notebook.currentPageIndex?.() || 0;
      const { pageWidth } = notebook.dims();
      // Notebook pages are sized in CSS pixels, which are 96 to the inch.
      const width = Math.round((pageWidth / 96) * PNG_DPI);
      const dataUrl = await notebook.renderPageImage(index, width);
      const image = await loadImage(dataUrl);

      const canvas = document.createElement("canvas");
      canvas.width = image.naturalWidth;
      canvas.height = image.naturalHeight;
      canvas.getContext("2d").drawImage(image, 0, 0);

      return {
        blob: await canvasToPngBlob(canvas),
        filename: pageFilename("Notebook", index + 1),
        width: canvas.width
      };
    }

    // Plain canvas: crop to what has actually been drawn, with a margin, so
    // the file is the work rather than an ocean of empty grid.
    const bounds = drawnBounds(s?.paths);
    if (!bounds) throw new Error("There is nothing on the canvas yet.");

    const margin = 48;
    const worldWidth = bounds.maxX - bounds.minX + margin * 2;
    const worldHeight = bounds.maxY - bounds.minY + margin * 2;
    const scale = PNG_DPI / 96;

    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(worldWidth * scale));
    canvas.height = Math.max(1, Math.round(worldHeight * scale));

    const ctx = canvas.getContext("2d");
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.scale(scale, scale);
    ctx.translate(-(bounds.minX - margin), -(bounds.minY - margin));
    paintPaths(ctx, s.paths);

    return {
      blob: await canvasToPngBlob(canvas),
      filename: pageFilename("Canvas", null),
      width: canvas.width
    };
  }

  function drawnBounds(paths) {
    const geometry = window.Inkyscib?.Geometry;
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;

    (paths || []).forEach((path) => {
      const bounds = geometry?.pathBounds?.(path);
      if (bounds) {
        minX = Math.min(minX, bounds.minX);
        minY = Math.min(minY, bounds.minY);
        maxX = Math.max(maxX, bounds.maxX);
        maxY = Math.max(maxY, bounds.maxY);
        return;
      }
      (path?.points || []).forEach((point) => {
        if (!Number.isFinite(point?.x) || !Number.isFinite(point?.y)) return;
        minX = Math.min(minX, point.x);
        minY = Math.min(minY, point.y);
        maxX = Math.max(maxX, point.x);
        maxY = Math.max(maxY, point.y);
      });
    });

    if (!Number.isFinite(minX) || !Number.isFinite(maxX)) return null;
    return { minX, minY, maxX, maxY };
  }

  function pageFilename(base, pageNumber) {
    const cleaned = String(base || "MAETHIST")
      .replace(/\.(pdf|pptx?|maedoc)$/i, "")
      .replace(/[\\/:*?"<>|]+/g, " ")
      .replace(/\s+/g, " ")
      .trim() || "MAETHIST";
    return pageNumber ? cleaned + " - page " + pageNumber + ".png" : cleaned + ".png";
  }

  // ---------- panes ----------

  const PANES = {
    file: {
      label: "File",
      icon: "file",
      heading: "File",
      blurb: "Everything to do with this document as a whole.",
      commands: ["new", "open", "save", "saveAs", "notebooks", "pages", "backup", "clear"]
    },
    insert: {
      label: "Insert",
      icon: "insert",
      heading: "Bring something in",
      blurb: "Imported pages keep their original file, so what you export later stays as sharp as what you brought in.",
      commands: ["importPdf", "importPpt", "importImage"]
    },
    export: {
      label: "Export",
      icon: "export",
      heading: "Send it out",
      blurb: "Pick a destination. The line below says exactly what each one will do to the quality.",
      commands: ["exportPdf", "exportPptx", "exportPng", "exportInkydoc"],
      quality: true
    },
    tools: {
      label: "Tools",
      icon: "tools",
      heading: "Extra tools",
      blurb: "The things that sit beside the drawing rather than on it. Each one opens over the canvas and closes again.",
      commands: ["ocr", "planner", "pomodoro", "youtube", "arInky", "featureTour"]
    },
    recent: {
      label: "Recent",
      icon: "recent",
      heading: "Recent notebooks",
      blurb: "Every notebook lives in this browser. Nothing is uploaded anywhere.",
      recent: true
    }
  };

  // The export pane's honesty line. It has to describe the pipeline as it
  // actually is, not as it is meant to become — a readout that overstates is
  // worse than none.
  function qualityReadout() {
    const active = deck();
    if (active) {
      return active.docId && window.Inkyscib?.PdfExport?.canExportOntoOriginal(active)
        ? {
            tone: "ok",
            text:
              "Vector. Your original PDF's pages are copied through untouched — text stays selectable and searchable — and your ink is added on top as real vector geometry. A page you have not drawn on comes back byte-identical to the one you uploaded."
          }
        : {
            tone: "warn",
            text:
              "This deck has no stored original, so PDF export has to rebuild pages from their rendered bitmaps and the text layer will not survive. Re-import the file to keep the source with it."
          };
    }

    if (mode() === "pages") {
      return {
        tone: "warn",
        text: "Pages still export as images inside a PDF. PNG export is lossless at 300 DPI, and .maedoc keeps every stroke editable."
      };
    }

    return {
      tone: "ok",
      text: "Nothing on this canvas is compressed. PNG exports at 300 DPI, cropped to your work; .maedoc keeps it all editable."
    };
  }

  // ---------- rendering ----------

  function commandButton(key) {
    const command = COMMANDS[key];
    if (!command) return "";

    const blocked = command.blockedBy ? command.blockedBy() : null;
    const note = blocked || command.note;

    return (
      '<button class="file-command" type="button" data-command="' + key + '"' +
      (blocked ? " disabled" : "") +
      ' title="' + escapeAttribute(note) + '">' +
      '<span class="file-command-icon" aria-hidden="true">' + (ICONS[command.icon] || "") + "</span>" +
      '<span class="file-command-copy">' +
      '<span class="file-command-title">' + escapeHtml(command.title) +
      (command.key ? '<span class="file-command-key">' + escapeHtml(command.key) + "</span>" : "") +
      "</span>" +
      '<span class="file-command-note">' + escapeHtml(note) + "</span>" +
      "</span></button>"
    );
  }

  function escapeHtml(value) {
    return String(value == null ? "" : value)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");
  }

  function escapeAttribute(value) {
    return escapeHtml(value).replace(/"/g, "&quot;");
  }

  async function renderPane(name) {
    const pane = PANES[name];
    const container = document.getElementById("fileBackstagePane");
    if (!pane || !container) return;

    const parts = [
      '<div class="file-pane-head"><h2>' + escapeHtml(pane.heading) + "</h2>" +
      "<p>" + escapeHtml(pane.blurb) + "</p></div>"
    ];

    if (pane.commands) {
      parts.push('<div class="file-command-grid">' + pane.commands.map(commandButton).join("") + "</div>");
    }

    if (pane.quality) {
      const quality = qualityReadout();
      parts.push(
        '<div class="file-quality" data-tone="' + (quality.tone === "warn" ? "warn" : "ok") + '">' +
        '<span class="file-quality-label">What this costs</span>' +
        '<span class="file-quality-text">' + escapeHtml(quality.text) + "</span></div>"
      );
    }

    if (pane.recent) {
      parts.push('<div class="file-recent" id="fileRecentList"><p class="file-recent-empty">Loading…</p></div>');
    }

    parts.push('<div class="file-backstage-status" id="fileBackstageStatus" aria-live="polite"></div>');
    container.innerHTML = parts.join("");

    if (pane.recent) await renderRecent();

    container.querySelectorAll("[data-command]").forEach((button) => {
      button.addEventListener("click", () => runCommand(button.dataset.command));
    });
  }

  async function renderRecent() {
    const list = document.getElementById("fileRecentList");
    if (!list) return;

    const index = (await library()?.listDocuments?.()) || { documents: [] };
    if (!index.documents.length) {
      list.innerHTML = '<p class="file-recent-empty">No notebooks yet.</p>';
      return;
    }

    const sorted = index.documents.slice().sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
    // The row used to BE the button. Rename and delete cannot be nested inside
    // one -- HTML forbids interactive controls inside a button -- so the row is
    // now a container holding an open button that fills it, with the two
    // actions at the trailing edge. The open button keeps the row's centre,
    // which is both what test_file_ribbon.py clicks and the only safe place
    // for a mis-click to land.
    list.innerHTML = sorted
      .map((doc) => {
        const active = doc.id === index.activeId;
        const id = escapeAttribute(doc.id);
        const name = escapeHtml(doc.name);
        return (
          '<div class="file-recent-item"' + (active ? ' aria-current="true"' : "") +
          ' data-recent-row="' + id + '">' +
            '<button class="file-recent-open" type="button" data-doc="' + id + '">' +
              '<span class="file-recent-name">' + name + "</span>" +
              '<span class="file-recent-meta">' +
              escapeHtml(active ? "Open now" : relativeTime(doc.updatedAt)) +
              "</span>" +
            "</button>" +
            '<div class="file-recent-actions">' +
              '<button class="file-recent-action" type="button" data-recent-rename="' + id + '"' +
              ' title="Rename" aria-label="Rename ' + escapeAttribute(doc.name) + '">' +
              ICONS.rename + "</button>" +
              '<button class="file-recent-action is-destructive" type="button"' +
              ' data-recent-delete="' + id + '"' +
              ' title="Delete" aria-label="Delete ' + escapeAttribute(doc.name) + '">' +
              ICONS.trash + "</button>" +
            "</div>" +
          "</div>"
        );
      })
      .join("");

    list.querySelectorAll("[data-doc]").forEach((button) => {
      button.addEventListener("click", async () => {
        const id = button.dataset.doc;
        if (id === index.activeId) {
          close();
          return;
        }
        close();
        await library()?.openDocument(id);
      });
    });

    list.querySelectorAll("[data-recent-rename]").forEach((button) => {
      button.addEventListener("click", (event) => {
        event.stopPropagation();
        beginRecentRename(button.dataset.recentRename);
      });
    });

    list.querySelectorAll("[data-recent-delete]").forEach((button) => {
      button.addEventListener("click", async (event) => {
        event.stopPropagation();
        await confirmRecentDelete(button.dataset.recentDelete);
      });
    });
  }

  function recentRow(id) {
    return document.querySelector('[data-recent-row="' + escapeAttribute(id) + '"]');
  }

  // Renaming happens in the row. A second dialog for one short string is more
  // ceremony than the job needs, and window.prompt -- which Library.renameDocument
  // raises on its own when given no name -- looks nothing like the app.
  function beginRecentRename(id) {
    const row = recentRow(id);
    const label = row?.querySelector(".file-recent-name");
    if (!row || !label || row.querySelector(".file-recent-rename-input")) return;

    const original = label.textContent;
    const field = document.createElement("input");
    field.type = "text";
    field.className = "file-recent-rename-input";
    field.value = original;
    field.maxLength = 80;
    field.setAttribute("aria-label", "Notebook name");
    label.replaceWith(field);
    field.focus();
    field.select();

    let settled = false;
    const restore = (text) => {
      if (settled) return;
      settled = true;
      const span = document.createElement("span");
      span.className = "file-recent-name";
      span.textContent = text;
      field.replaceWith(span);
    };

    const commit = async () => {
      if (settled) return;
      const next = field.value.trim().slice(0, 80);
      if (!next || next === original) {
        restore(original);
        return;
      }
      // Claimed before awaiting so the blur that fires when the row is
      // replaced cannot re-enter this.
      settled = true;
      // Storage first, then re-render from it. Painting the new name straight
      // into the row would show a rename that had not happened -- and if
      // renameDocument bailed (runExclusive returns silently while busy, or
      // before storageReady) the row would keep a name nothing had saved.
      await library()?.renameDocument?.(id, next);
      syncDocumentName();
      await renderRecent();
      const saved = (await library()?.listDocuments?.())?.documents
        ?.some((doc) => doc.id === id && doc.name === next);
      setStatus(
        saved ? "Renamed to “" + next + "”." : "Could not rename that notebook.",
        saved ? "success" : "error"
      );
    };

    field.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        commit();
      } else if (event.key === "Escape") {
        event.preventDefault();
        restore(original);
      }
    });
    field.addEventListener("blur", commit);
  }

  async function confirmRecentDelete(id) {
    const row = recentRow(id);
    const name = row?.querySelector(".file-recent-name")?.textContent || "this notebook";
    const ask = window.showDestructiveConfirm || window.showClearCanvasConfirm;
    if (typeof ask !== "function") return;

    const confirmed = await ask({
      title: "Delete “" + name + "”?",
      body: "The notebook and everything written in it goes, on this device. This cannot be undone.",
      confirmLabel: "Delete it",
      cancelLabel: "Keep it"
    });
    if (!confirmed) return;

    await library()?.deleteDocument?.(id, { confirmed: true });
    setStatus("Deleted “" + name + "”.", "success");
    syncDocumentName();
    await renderRecent();
  }

  function relativeTime(timestamp) {
    if (!Number.isFinite(timestamp)) return "";
    const minutes = Math.round((Date.now() - timestamp) / 60000);
    if (minutes < 1) return "Just now";
    if (minutes < 60) return minutes + " min ago";
    const hours = Math.round(minutes / 60);
    if (hours < 24) return hours + (hours === 1 ? " hour ago" : " hours ago");
    const days = Math.round(hours / 24);
    return days + (days === 1 ? " day ago" : " days ago");
  }

  async function runCommand(key) {
    const command = COMMANDS[key];
    if (!command) return;
    if (command.blockedBy && command.blockedBy()) return;

    try {
      await command.run();
    } catch (error) {
      console.error("File command failed (" + key + "):", error);
      setStatus(error?.message || "That did not work.", "error");
      setRibbonState("unsaved");
    }
  }

  // ---------- open / close ----------

  // The control to hand focus back to when the panel closes.
  let lastTrigger = null;

  function open(tab) {
    if (!TABS.includes(tab)) tab = "file";
    openTab = tab;
    const ribbonTab = ribbonTabFor(tab);
    lastTrigger =
      document.querySelector('[data-ribbon-tab="' + ribbonTab + '"]') ||
      (document.activeElement instanceof HTMLElement ? document.activeElement : null);

    document.querySelectorAll("[data-ribbon-tab]").forEach((button) => {
      button.setAttribute("aria-expanded", String(button.dataset.ribbonTab === ribbonTab));
    });
    document.querySelectorAll("[data-rail-tab]").forEach((button) => {
      button.setAttribute("aria-selected", String(button.dataset.railTab === tab));
    });

    // The rail only lists File's own sections, so a pane opened from Insert,
    // Export or Tools stands alone rather than beside a rail it is not in.
    const railShown = RAIL_TABS.includes(tab);
    const rail = backstage?.querySelector(".file-backstage-rail");
    if (rail) rail.hidden = !railShown;
    backstage?.classList.toggle("is-rail-hidden", !railShown);
    backstage?.setAttribute("aria-label", PANES[ribbonTab]?.label || "File");

    renderPane(tab);
    // Opening is the one moment the name is definitely worth re-reading.
    syncDocumentName();
    scrim?.classList.add("is-open");
    backstage?.classList.add("is-open");
    backstage?.setAttribute("aria-hidden", "false");
    backstage?.removeAttribute("inert");
    document.dispatchEvent(new CustomEvent("inkyscib:surface-open", { detail: { id: "file-sheet" } }));
    // Out of the tab that opened it, with its commands arriving in order
    // (DESIGN.md: origin awareness, staggering).
    const motion = window.Inkyscib?.Motion;
    if (motion && backstage) {
      motion.originFrom(backstage, lastTrigger);
      new Set([...backstage.querySelectorAll(".file-command")].map((el) => el.parentElement)).forEach(motion.stagger);
    }

    // Focus the first thing in the pane so the keyboard works immediately.
    window.requestAnimationFrame(() => {
      // .file-recent-open, not .file-recent-item: the row is a container now
      // and focusing it would be a no-op, leaving focus on whatever opened
      // the backstage.
      backstage?.querySelector(".file-command, .file-recent-open")?.focus();
    });
  }

  function close() {
    // Read this before going inert: marking the panel inert blurs whatever was
    // focused inside it and the browser drops focus to <body>, so a keyboard
    // user pressing Escape would lose their place entirely. Only take focus
    // back if it was actually in here -- closing by clicking the canvas should
    // leave the canvas focused.
    const focusWasInside = !!backstage && backstage.contains(document.activeElement);
    openTab = null;
    document.querySelectorAll("[data-ribbon-tab]").forEach((button) => {
      button.setAttribute("aria-expanded", "false");
    });
    scrim?.classList.remove("is-open");
    backstage?.classList.remove("is-open", "mx-origin");
    backstage?.setAttribute("aria-hidden", "true");
    // aria-hidden alone is not enough: closed, this panel is only opacity:0,
    // so it stays laid out under the ribbon and its four buttons stayed in the
    // tab order. Focus moving into a subtree marked aria-hidden is the one
    // combination the spec calls out, because the reader announces nothing
    // while the focus ring is visibly gone. `inert` takes it out of both.
    backstage?.setAttribute("inert", "");

    if (focusWasInside) lastTrigger?.focus?.();
  }

  function toggle(tab) {
    // Recent shows under the File tab, so tapping File there closes the panel.
    if (openTab && ribbonTabFor(openTab) === tab) close();
    else open(tab);
  }

  // ---------- document identity ----------

  function setRibbonState(next) {
    if (!root) return;
    root.dataset.state = next;
    const label = root.querySelector(".file-ribbon-state");
    if (label) {
      label.textContent =
        next === "working" ? "Saving" : next === "unsaved" ? "Unsaved" : "Saved";
    }
  }

  async function syncDocumentName() {
    const nameElement = root?.querySelector(".file-ribbon-name");
    if (!nameElement) return;

    const index = await library()?.listDocuments?.();
    const current = index?.documents?.find((doc) => doc.id === index.activeId);
    nameElement.textContent = current?.name || "Untitled";
    nameElement.dataset.documentId = index?.activeId || "";

    // An imported deck is what you are working ON; it is not what the notebook
    // is called. Putting its filename in the name slot told people their
    // notebook had been renamed when the library still held the old name, and
    // exports and the notebook list went on using the real one.
    const active = deck();
    const source = active?.name ? active.name.replace(/\.(pdf|pptx?)$/i, "") : "";
    const sourceElement = root?.querySelector(".file-ribbon-source");
    if (sourceElement) {
      sourceElement.textContent = source;
      sourceElement.hidden = !source;
      sourceElement.title = source ? "Open file: " + source : "";
    }
  }

  // ---------- build ----------

  function build() {
    root = document.createElement("div");
    root.className = "file-ribbon";
    root.dataset.state = "saved";
    root.setAttribute("role", "toolbar");
    root.setAttribute("aria-label", "File commands");

    root.innerHTML =
      // The way back to the homepage. Notebooks save as you write, so leaving
      // loses nothing; the mark is the same one the homepage header carries.
      '<a class="file-ribbon-home" href="/" title="MAETHIST home" aria-label="MAETHIST home">' +
      '<img src="/static/img/maethist-mark.png" alt="" width="24" height="24" decoding="async"></a>' +
      ["file", "insert", "export", "tools"]
        .map(
          (tab) =>
            '<button class="file-ribbon-tab" type="button" data-ribbon-tab="' + tab + '"' +
            ' aria-expanded="false" aria-haspopup="menu">' +
            ICONS[PANES[tab].icon] +
            "<span>" + PANES[tab].label + "</span></button>"
        )
        .join("") +
      // Sits after Tools and before the divider, so a job the app is doing
      // appears where the commands are rather than over the canvas. Takes no
      // room until something is running.
      '<span class="file-ribbon-progress" id="fileRibbonProgress" role="status"' +
      ' aria-live="polite" hidden>' +
      '<span class="file-ribbon-progress-spinner" aria-hidden="true"></span>' +
      '<span class="file-ribbon-progress-label"></span>' +
      '<button type="button" class="file-ribbon-progress-stop" aria-label="Stop" title="Stop" hidden>' +
      '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="7" y="7" width="10" height="10" rx="2"/></svg></button>' +
      "</span>" +
      '<span class="file-ribbon-sep" aria-hidden="true"></span>' +
      '<span class="file-ribbon-doc">' +
      '<button type="button" class="file-ribbon-name" title="Rename this notebook">Untitled</button>' +
      '<span class="file-ribbon-source" hidden></span>' +
      '<span class="file-ribbon-state">Saved</span>' +
      "</span>";

    scrim = document.createElement("div");
    scrim.className = "file-backstage-scrim";

    backstage = document.createElement("div");
    backstage.className = "file-backstage";
    backstage.setAttribute("role", "dialog");
    backstage.setAttribute("aria-modal", "false");
    backstage.setAttribute("aria-label", "File");
    backstage.setAttribute("aria-hidden", "true");
    backstage.setAttribute("inert", "");
    backstage.innerHTML =
      '<div class="file-backstage-rail" role="tablist" aria-label="File sections">' +
      '<p class="file-backstage-kicker">Document</p>' +
      RAIL_TABS.map(
        (tab) =>
          '<button class="file-rail-btn" type="button" role="tab" data-rail-tab="' + tab + '"' +
          ' aria-selected="false">' + ICONS[PANES[tab].icon] +
          "<span>" + PANES[tab].label + "</span></button>"
      ).join("") +
      "</div>" +
      '<div class="file-backstage-pane" id="fileBackstagePane"></div>';

    document.body.append(root, scrim, backstage);

    // The name looked editable and was not: renaming only existed in the
    // library modal. Reuse renameDocument() rather than growing a second
    // prompt, so both entry points share one validation and status message.
    root.querySelector(".file-ribbon-name")?.addEventListener("click", async () => {
      const api = library();
      if (!api?.renameDocument) return;
      const index = await api.listDocuments?.();
      const id = index?.activeId;
      if (!id) return;
      await api.renameDocument(id);
      syncDocumentName();
    });

    root.querySelectorAll("[data-ribbon-tab]").forEach((button) => {
      button.addEventListener("click", () => toggle(button.dataset.ribbonTab));
    });
    backstage.querySelectorAll("[data-rail-tab]").forEach((button) => {
      button.addEventListener("click", () => open(button.dataset.railTab));
    });
    scrim.addEventListener("click", close);

    // One floating surface at a time (tool-dock.js, SURFACE_EVENT). The sheet
    // announces itself so a floating tool panel and the canvas-theme popover
    // step aside, and it closes when one of them is opened from the keyboard.
    document.addEventListener("inkyscib:surface-open", (event) => {
      if (event.detail?.id !== "file-sheet" && openTab) close();
    });
  }

  function bindShortcuts() {
    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape" && openTab) {
        close();
        return;
      }

      if (!event.ctrlKey && !event.metaKey) return;
      // Never steal a shortcut from a field the user is typing in.
      const target = event.target;
      if (target?.matches?.("input, textarea, [contenteditable='true']")) return;

      const key = event.key.toLowerCase();
      if (key === "s") {
        event.preventDefault();
        runCommand(event.shiftKey ? "saveAs" : "save");
      } else if (key === "o") {
        event.preventDefault();
        runCommand("open");
      } else if (key === "n") {
        event.preventDefault();
        runCommand("new");
      }
    });
  }

  function init() {
    if (document.querySelector(".file-ribbon")) return;
    build();
    bindShortcuts();
    syncDocumentName();

    // Save state comes from storage.js's own events rather than from watching
    // the canvas: `canvasRendered` fires on every pan and zoom, and reading the
    // notebook index once a frame would put an IndexedDB round trip inside the
    // render loop.
    document.addEventListener("inkyscibDocumentDirty", () => setRibbonState("unsaved"));
    document.addEventListener("inkyscibDocumentSaved", () => setRibbonState("saved"));

    // The name only changes when the document does, which is rare and always
    // follows one of these.
    document.addEventListener("inkyscibDeckChanged", syncDocumentName);
    document.addEventListener("inkyscibDocumentSwitched", syncDocumentName);
  }

  // ---------- progress ----------
  //
  // One job at a time, named. Anything slow enough to wonder about says so
  // here: importing a YouTube frame takes a couple of seconds while the server
  // decodes the video, and without this the button just sits there.
  let progressToken = 0;

  function progressElements() {
    const host = document.getElementById("fileRibbonProgress");
    return host
      ? { host, label: host.querySelector(".file-ribbon-progress-label"), stop: host.querySelector(".file-ribbon-progress-stop") }
      : null;
  }

  // options.onCancel puts a Stop button on the chip: a job you can walk away
  // from (a frame import) should never hold the ribbon hostage.
  function startProgress(text, options = {}) {
    const parts = progressElements();
    if (!parts) return null;
    const token = ++progressToken;
    parts.label.textContent = text || "Working";
    parts.host.dataset.tone = "busy";
    parts.host.hidden = false;
    if (parts.stop) {
      parts.stop.hidden = typeof options.onCancel !== "function";
      parts.stop.onclick = parts.stop.hidden ? null : () => {
        if (token !== progressToken) return;
        parts.stop.hidden = true;
        options.onCancel();
        finish("done", "Stopped");
      };
    }

    const finish = (tone, held) => {
      // A later job has taken the chip; leave it to that one.
      if (token !== progressToken) return;
      const current = progressElements();
      if (!current) return;
      current.host.dataset.tone = tone;
      if (current.stop) { current.stop.hidden = true; current.stop.onclick = null; }
      if (!held) {
        current.host.hidden = true;
        return;
      }
      current.label.textContent = held;
      window.setTimeout(() => {
        if (token === progressToken) {
          const last = progressElements();
          if (last) last.host.hidden = true;
        }
      }, 2200);
    };

    return {
      update: (next) => {
        if (token === progressToken) {
          const current = progressElements();
          if (current) current.label.textContent = next;
        }
      },
      done: () => finish("done", ""),
      fail: () => finish("error", "Could not finish that")
    };
  }

  window.Inkyscib = window.Inkyscib || {};
  window.Inkyscib.RibbonProgress = { start: startProgress };
  window.Inkyscib.FileRibbon = {
    commands: () => Object.entries(COMMANDS).map(([id, c]) => ({ id, title: c.title, note: c.note, key: c.key || "", icon: c.icon })),
    open,
    close,
    runCommand,
    exportCurrentPagePng,
    setRibbonState
  };

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init, { once: true });
  } else {
    init();
  }
})();
