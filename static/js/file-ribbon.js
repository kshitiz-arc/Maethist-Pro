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

  const TABS = ["file", "insert", "export", "recent"];

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

  function icon(paths) {
    return (
      '<svg viewBox="0 0 24 24" aria-hidden="true">' +
      paths.map((d) => '<path d="' + d + '"></path>').join("") +
      "</svg>"
    );
  }

  const ICONS = {
    file: icon(["M14 3v5h5", "M6 3h8l5 5v13H6z"]),
    insert: icon(["M12 6v12", "M6 12h12"]),
    export: icon(["M12 16V4", "m8 8 4-4 4 4", "M5 16v3h14v-3"]),
    recent: icon(["M12 7v5l3 2", "M12 21a9 9 0 1 0-9-9"]),
    open: icon(["M3 7h6l2 2h10v10H3z"]),
    save: icon(["M5 4h11l3 3v13H5z", "M8 4v6h7V4", "M8 20v-6h8v6"]),
    saveAs: icon(["M5 4h10l4 4v8H5z", "M8 4v5h6V4", "m15 21 3-3 3 3", "M18 18v-4"]),
    plus: icon(["M12 5v14", "M5 12h14"]),
    pdf: icon(["M14 3v5h5", "M6 3h8l5 5v13H6z", "M9 13h6", "M9 17h4"]),
    slides: icon(["M3 5h18v11H3z", "M12 16v4", "M8 20h8"]),
    image: icon(["M3 5h18v14H3z", "m3 15 5-4 4 3 3-3 6 5", "M8.5 9.5h.01"]),
    package: icon(["m12 3 8 4.5v9L12 21l-8-4.5v-9z", "M12 12 4 7.5", "m12 12 8-4.5", "M12 12v9"]),
    backup: icon(["M4 7c0-1.7 3.6-3 8-3s8 1.3 8 3-3.6 3-8 3-8-1.3-8-3z", "M4 7v10c0 1.7 3.6 3 8 3s8-1.3 8-3V7"]),
    book: icon(["M4 5.5A2.5 2.5 0 0 1 6.5 3H20v15H6.5A2.5 2.5 0 0 0 4 20.5z", "M4 5.5v15"]),
    trash: icon(["M4 7h16", "M10 11v6", "M14 11v6", "M6 7l1 13h10l1-13", "M9 7V4h6v3"])
  };

  function setStatus(message, tone = "muted") {
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
      note: "Open a .inkydoc document or restore a .inky library backup.",
      key: "Ctrl+O",
      icon: "open",
      run: async () => {
        const file = await pickFile(".inkydoc,.inky,.json");
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
      note: "One .inkydoc file holding the original document and every stroke, still editable when reopened.",
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

    backup: {
      title: "Back up everything",
      note: "Download every notebook as a single .inky file.",
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
      title: ".inkydoc",
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
    const cleaned = String(base || "Inkyscib")
      .replace(/\.(pdf|pptx?|inkydoc)$/i, "")
      .replace(/[\\/:*?"<>|]+/g, " ")
      .replace(/\s+/g, " ")
      .trim() || "Inkyscib";
    return pageNumber ? cleaned + " - page " + pageNumber + ".png" : cleaned + ".png";
  }

  // ---------- panes ----------

  const PANES = {
    file: {
      label: "File",
      icon: "file",
      heading: "File",
      blurb: "Everything to do with this document as a whole.",
      commands: ["new", "open", "save", "saveAs", "notebooks", "backup", "clear"]
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
        text: "Pages still export as images inside a PDF. PNG export is lossless at 300 DPI, and .inkydoc keeps every stroke editable."
      };
    }

    return {
      tone: "ok",
      text: "Nothing on this canvas is compressed. PNG exports at 300 DPI, cropped to your work; .inkydoc keeps it all editable."
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
    list.innerHTML = sorted
      .map((doc) => {
        const active = doc.id === index.activeId;
        return (
          '<button class="file-recent-item" type="button" data-doc="' + escapeAttribute(doc.id) + '"' +
          (active ? ' aria-current="true"' : "") + ">" +
          '<span class="file-recent-name">' + escapeHtml(doc.name) + "</span>" +
          '<span class="file-recent-meta">' +
          escapeHtml(active ? "Open now" : relativeTime(doc.updatedAt)) +
          "</span></button>"
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

  function open(tab) {
    if (!TABS.includes(tab)) tab = "file";
    openTab = tab;

    document.querySelectorAll("[data-ribbon-tab]").forEach((button) => {
      button.setAttribute("aria-expanded", String(button.dataset.ribbonTab === tab));
    });
    document.querySelectorAll("[data-rail-tab]").forEach((button) => {
      button.setAttribute("aria-selected", String(button.dataset.railTab === tab));
    });

    renderPane(tab);
    // Opening is the one moment the name is definitely worth re-reading.
    syncDocumentName();
    scrim?.classList.add("is-open");
    backstage?.classList.add("is-open");
    backstage?.setAttribute("aria-hidden", "false");

    // Focus the first thing in the pane so the keyboard works immediately.
    window.requestAnimationFrame(() => {
      backstage?.querySelector(".file-command, .file-recent-item")?.focus();
    });
  }

  function close() {
    openTab = null;
    document.querySelectorAll("[data-ribbon-tab]").forEach((button) => {
      button.setAttribute("aria-expanded", "false");
    });
    scrim?.classList.remove("is-open");
    backstage?.classList.remove("is-open");
    backstage?.setAttribute("aria-hidden", "true");
  }

  function toggle(tab) {
    if (openTab === tab) close();
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

    const active = deck();
    if (active?.name) {
      nameElement.textContent = active.name.replace(/\.(pdf|pptx?)$/i, "");
      return;
    }

    const index = await library()?.listDocuments?.();
    const current = index?.documents?.find((doc) => doc.id === index.activeId);
    nameElement.textContent = current?.name || "Untitled";
  }

  // ---------- build ----------

  function build() {
    root = document.createElement("div");
    root.className = "file-ribbon";
    root.dataset.state = "saved";
    root.setAttribute("role", "toolbar");
    root.setAttribute("aria-label", "File commands");

    root.innerHTML =
      ["file", "insert", "export"]
        .map(
          (tab) =>
            '<button class="file-ribbon-tab" type="button" data-ribbon-tab="' + tab + '"' +
            ' aria-expanded="false" aria-haspopup="menu">' +
            ICONS[PANES[tab].icon] +
            "<span>" + PANES[tab].label + "</span></button>"
        )
        .join("") +
      '<span class="file-ribbon-sep" aria-hidden="true"></span>' +
      '<span class="file-ribbon-doc">' +
      '<span class="file-ribbon-name">Untitled</span>' +
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
    backstage.innerHTML =
      '<div class="file-backstage-rail" role="tablist" aria-label="File sections">' +
      '<p class="file-backstage-kicker">Document</p>' +
      TABS.map(
        (tab) =>
          '<button class="file-rail-btn" type="button" role="tab" data-rail-tab="' + tab + '"' +
          ' aria-selected="false">' + ICONS[PANES[tab].icon] +
          "<span>" + PANES[tab].label + "</span></button>"
      ).join("") +
      "</div>" +
      '<div class="file-backstage-pane" id="fileBackstagePane"></div>';

    document.body.append(root, scrim, backstage);

    root.querySelectorAll("[data-ribbon-tab]").forEach((button) => {
      button.addEventListener("click", () => toggle(button.dataset.ribbonTab));
    });
    backstage.querySelectorAll("[data-rail-tab]").forEach((button) => {
      button.addEventListener("click", () => open(button.dataset.railTab));
    });
    scrim.addEventListener("click", close);
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

  window.Inkyscib = window.Inkyscib || {};
  window.Inkyscib.FileRibbon = {
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
