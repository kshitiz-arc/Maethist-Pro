// The .inkydoc container.
//
// One shareable file that holds a document and the work done on top of it,
// with the two kept apart: the original upload goes in byte-for-byte, and the
// ink, typed text and page state go in beside it as data. Reopening restores
// a pristine source plus annotations you can still move, erase and retype —
// which is the whole point, and the reason this is not just an export.
//
// Layout (a ZIP):
//
//   mimetype                 application/vnd.inkyscib.document, stored first
//   manifest.json            format version, title, mode, source descriptor
//   document.json            the workspace snapshot: drawing, notebook, ppt
//   original/<sha256>.pdf    the upload, unmodified and uncompressed
//   preview.png              thumbnail for the library card
//
// A ZIP rather than one JSON envelope on purpose: JSON would force the PDF
// back through base64, which is the inflation the document store exists to
// avoid. Entries that are already compressed (PDF, PNG) are stored, not
// deflated, so nothing is spent recompressing incompressible bytes.
(function () {
  "use strict";

  const FORMAT = "inkydoc";
  const FORMAT_VERSION = 1;
  const MIMETYPE = "application/vnd.inkyscib.document";
  const EXTENSION = ".inkydoc";

  // ---------- bytes ----------

  const encoder = new TextEncoder();
  const decoder = new TextDecoder();

  function stringToBytes(value) {
    return encoder.encode(value);
  }

  function concatBytes(chunks) {
    const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
    const output = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      output.set(chunk, offset);
      offset += chunk.length;
    }
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

  // Deflate is native in every browser that can run the editor; where it is
  // missing, entries are stored instead. Both are lossless, so this only ever
  // changes file size.
  const canDeflate = typeof CompressionStream === "function";
  const canInflate = typeof DecompressionStream === "function";

  async function deflateRaw(bytes) {
    const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream("deflate-raw"));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  }

  async function inflateRaw(bytes) {
    const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  }

  // ---------- zip ----------

  /**
   * @param {{name: string, data: Uint8Array|string, store?: boolean}[]} entries
   */
  async function writeZip(entries) {
    const localParts = [];
    const centralParts = [];
    const timestamp = dosDateTime();
    let offset = 0;

    for (const entry of entries) {
      const nameBytes = stringToBytes(entry.name);
      const raw = typeof entry.data === "string" ? stringToBytes(entry.data) : entry.data;
      const checksum = crc32(raw);

      // Already-compressed payloads gain nothing from deflate and cost time.
      const useDeflate = canDeflate && !entry.store && raw.length > 256;
      const data = useDeflate ? await deflateRaw(raw) : raw;
      const method = useDeflate ? 8 : 0;

      localParts.push(
        concatBytes([
          uint32LE(0x04034b50),
          uint16LE(20),
          uint16LE(0),
          uint16LE(method),
          uint16LE(timestamp.time),
          uint16LE(timestamp.date),
          uint32LE(checksum),
          uint32LE(data.length),
          uint32LE(raw.length),
          uint16LE(nameBytes.length),
          uint16LE(0),
          nameBytes
        ]),
        data
      );

      centralParts.push(
        concatBytes([
          uint32LE(0x02014b50),
          uint16LE(20),
          uint16LE(20),
          uint16LE(0),
          uint16LE(method),
          uint16LE(timestamp.time),
          uint16LE(timestamp.date),
          uint32LE(checksum),
          uint32LE(data.length),
          uint32LE(raw.length),
          uint16LE(nameBytes.length),
          uint16LE(0),
          uint16LE(0),
          uint16LE(0),
          uint16LE(0),
          uint32LE(0),
          uint32LE(offset),
          nameBytes
        ])
      );

      offset += 30 + nameBytes.length + data.length;
    }

    const centralDirectory = concatBytes(centralParts);
    const eocd = concatBytes([
      uint32LE(0x06054b50),
      uint16LE(0),
      uint16LE(0),
      uint16LE(entries.length),
      uint16LE(entries.length),
      uint32LE(centralDirectory.length),
      uint32LE(offset),
      uint16LE(0)
    ]);

    return concatBytes([...localParts, centralDirectory, eocd]);
  }

  /**
   * Read a ZIP into { name: Uint8Array }.
   *
   * Walks the central directory rather than scanning for local headers, so a
   * file whose entry data happens to contain a header signature — which a PDF
   * easily can — still reads correctly.
   */
  async function readZip(bytes) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

    let eocd = -1;
    const earliest = Math.max(0, bytes.length - 65557);
    for (let index = bytes.length - 22; index >= earliest; index -= 1) {
      if (view.getUint32(index, true) === 0x06054b50) {
        eocd = index;
        break;
      }
    }
    if (eocd < 0) throw new Error("That file is not a readable MAETHIST document.");

    const count = view.getUint16(eocd + 10, true);
    let pointer = view.getUint32(eocd + 16, true);

    const files = {};
    for (let index = 0; index < count; index += 1) {
      if (view.getUint32(pointer, true) !== 0x02014b50) {
        throw new Error("That MAETHIST document is damaged.");
      }
      const method = view.getUint16(pointer + 10, true);
      const compressedSize = view.getUint32(pointer + 20, true);
      const nameLength = view.getUint16(pointer + 28, true);
      const extraLength = view.getUint16(pointer + 30, true);
      const commentLength = view.getUint16(pointer + 32, true);
      const localOffset = view.getUint32(pointer + 42, true);
      const name = decoder.decode(bytes.subarray(pointer + 46, pointer + 46 + nameLength));

      // The local header's own name/extra lengths are authoritative for where
      // the data starts; the central copy can legitimately differ.
      const localNameLength = view.getUint16(localOffset + 26, true);
      const localExtraLength = view.getUint16(localOffset + 28, true);
      const dataStart = localOffset + 30 + localNameLength + localExtraLength;
      const raw = bytes.subarray(dataStart, dataStart + compressedSize);

      if (method === 0) {
        files[name] = raw;
      } else if (method === 8) {
        if (!canInflate) {
          throw new Error("This browser cannot read compressed MAETHIST documents.");
        }
        files[name] = await inflateRaw(raw);
      } else {
        throw new Error("That MAETHIST document uses an unsupported compression method.");
      }

      pointer += 46 + nameLength + extraLength + commentLength;
    }

    return files;
  }

  // ---------- the document ----------

  function state() {
    return window.appState;
  }

  function currentMode() {
    const s = state();
    if (s?.ppt?.active) return "slides";
    if (s?.notebook?.active) return "pages";
    return "canvas";
  }

  function previewBytes() {
    try {
      const canvas = document.getElementById("drawingCanvas");
      if (!canvas || !canvas.width || !canvas.height) return null;

      const scale = Math.min(1, 480 / Math.max(canvas.width, canvas.height));
      const thumb = document.createElement("canvas");
      thumb.width = Math.max(1, Math.round(canvas.width * scale));
      thumb.height = Math.max(1, Math.round(canvas.height * scale));
      const ctx = thumb.getContext("2d");
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(0, 0, thumb.width, thumb.height);
      ctx.drawImage(canvas, 0, 0, thumb.width, thumb.height);

      const dataUrl = thumb.toDataURL("image/png");
      const binary = atob(dataUrl.split(",", 2)[1]);
      const out = new Uint8Array(binary.length);
      for (let index = 0; index < binary.length; index += 1) out[index] = binary.charCodeAt(index);
      return out;
    } catch (error) {
      // A thumbnail is a convenience; never let it stop a save.
      console.warn("Could not capture a preview for the .inkydoc:", error);
      return null;
    }
  }

  /**
   * Build a .inkydoc from the live workspace.
   *
   * Returns { blob, filename, includedOriginal }.
   */
  async function build(options = {}) {
    const library = window.Inkyscib?.Library;
    if (!library?.snapshotActiveWorkspace || !library.readActiveWorkspace) {
      throw new Error("MAETHIST is still loading — try again in a moment.");
    }

    // Flush the in-memory workspace into storage first, so what gets written
    // is what is on screen rather than the last autosave.
    await library.snapshotActiveWorkspace();
    const snapshot = await library.readActiveWorkspace();

    const title = (options.title || snapshot?.ppt?.name || "MAETHIST document")
      .replace(/\.(pdf|pptx?|inkydoc)$/i, "")
      .trim();
    const docId = typeof snapshot?.ppt?.docId === "string" ? snapshot.ppt.docId : null;

    const entries = [];
    // The mimetype entry goes first and uncompressed, so the format is
    // identifiable from the first bytes of the file the way ODF and EPUB do it.
    entries.push({ name: "mimetype", data: MIMETYPE, store: true });

    let source = null;
    let includedOriginal = false;
    if (docId) {
      const record = await window.Inkyscib?.DocStore?.getRecord(docId);
      if (record?.blob) {
        const bytes = new Uint8Array(await record.blob.arrayBuffer());
        // Stored, not deflated: this is the byte-identical upload and it must
        // stay that way. A PDF is already compressed regardless.
        entries.push({ name: "original/" + docId + ".pdf", data: bytes, store: true });
        source = {
          docId,
          name: record.name || null,
          bytes: bytes.length,
          type: record.type || "application/pdf",
          path: "original/" + docId + ".pdf"
        };
        includedOriginal = true;
      }
    }

    const manifest = {
      format: FORMAT,
      version: FORMAT_VERSION,
      app: "inkyscib",
      title,
      mode: currentMode(),
      createdAt: new Date().toISOString(),
      pageCount: snapshot?.ppt?.slides?.length || null,
      source
    };

    entries.push({ name: "manifest.json", data: JSON.stringify(manifest) });
    entries.push({
      name: "document.json",
      data: JSON.stringify({
        drawing: snapshot?.drawing || [],
        notebook: snapshot?.notebook || null,
        ppt: snapshot?.ppt || null
      })
    });

    const preview = previewBytes();
    if (preview) entries.push({ name: "preview.png", data: preview, store: true });

    const zip = await writeZip(entries);
    return {
      blob: new Blob([zip], { type: MIMETYPE }),
      filename: safeFilename(title) + EXTENSION,
      includedOriginal,
      title
    };
  }

  function safeFilename(title) {
    const cleaned = String(title || "MAETHIST document")
      .replace(/[\\/:*?"<>|]+/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    return (cleaned || "MAETHIST document").slice(0, 80);
  }

  /**
   * Parse a .inkydoc without touching the workspace.
   *
   * Returns { manifest, document, original }.
   */
  async function parse(file) {
    const bytes = new Uint8Array(await file.arrayBuffer());
    const files = await readZip(bytes);

    if (!files["manifest.json"] || !files["document.json"]) {
      throw new Error("That file is not an MAETHIST document.");
    }

    let manifest;
    let document_;
    try {
      manifest = JSON.parse(decoder.decode(files["manifest.json"]));
      document_ = JSON.parse(decoder.decode(files["document.json"]));
    } catch (error) {
      throw new Error("That MAETHIST document could not be read.");
    }

    if (manifest?.format !== FORMAT) {
      throw new Error("That file is not an MAETHIST document.");
    }
    if (Number(manifest.version) > FORMAT_VERSION) {
      throw new Error(
        "That document was saved by a newer version of MAETHIST. Update, then open it again."
      );
    }

    const path = manifest.source?.path;
    return {
      manifest,
      document: document_,
      original: path && files[path] ? files[path] : null
    };
  }

  /**
   * Open a .inkydoc into the live workspace.
   *
   * The embedded original is put back into the document store first. Because
   * ids are content hashes, it lands under the same id the annotations already
   * reference, and an identical document already held is reused rather than
   * duplicated.
   */
  async function open(file) {
    const parsed = await parse(file);

    if (parsed.original && window.Inkyscib?.DocStore) {
      try {
        const restored = await window.Inkyscib.DocStore.putDocument(parsed.original, {
          name: parsed.manifest.source?.name || parsed.manifest.title,
          type: parsed.manifest.source?.type || "application/pdf"
        });
        const expected = parsed.manifest.source?.docId;
        if (expected && restored.id !== expected && restored.verifiable) {
          throw new Error("The original inside that document does not match its record.");
        }
      } catch (error) {
        // Without the original the annotations still open and still render
        // from their stored pages; only re-rendering and lossless export lose
        // their source. Worth saying out loud rather than failing the open.
        console.warn("Could not restore the original from the .inkydoc:", error);
      }
    }

    const library = window.Inkyscib?.Library;
    if (!library?.loadDocumentData) {
      throw new Error("MAETHIST is still loading — try again in a moment.");
    }

    await library.loadDocumentData(parsed.document, {
      title: parsed.manifest.title || "MAETHIST document"
    });

    return parsed.manifest;
  }

  function isInkydocName(name) {
    return typeof name === "string" && name.toLowerCase().endsWith(EXTENSION);
  }

  window.Inkyscib = window.Inkyscib || {};
  window.Inkyscib.Inkydoc = {
    EXTENSION,
    MIMETYPE,
    FORMAT_VERSION,
    build,
    parse,
    open,
    isInkydocName,
    // exported for tests
    writeZip,
    readZip
  };
})();
