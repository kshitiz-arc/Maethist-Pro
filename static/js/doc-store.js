// The original file, kept.
//
// Everything Inkyscib shows you for an imported document is a picture of that
// document, and until now the picture was all that survived the import — the
// uploaded bytes were read once, rasterised, and dropped. That is why a
// download is a photograph of a photograph, and why re-importing one degrades
// it again.
//
// This store keeps the upload itself. A document goes in as a Blob and comes
// back byte-identical, so rendering can be re-done at any resolution and an
// export can be written by copying the original's own pages instead of
// redrawing them.
//
// Blobs, deliberately, not data URLs: base64 inflates by a third and the save
// layer caps media strings at 2 MB (INKYSCIB_MAX_MEDIA_DATA_URL_LENGTH), which
// is the constraint every compressor in this codebase was written to satisfy.
// Binary in IndexedDB has no such ceiling.
(function () {
  "use strict";

  const STORE = "documents";

  // Documents are keyed by the SHA-256 of their contents, so the same textbook
  // opened in five notebooks costs one copy and an id doubles as a checksum.
  // crypto.subtle needs a secure context; on a plain-HTTP LAN origin we fall
  // back to a random id, which loses deduplication and verification but is
  // never wrong. Identity must not depend on a weaker hash.
  function canHash() {
    return typeof crypto !== "undefined" && !!crypto.subtle;
  }

  async function digestOf(buffer) {
    const digest = await crypto.subtle.digest("SHA-256", buffer);
    return Array.from(new Uint8Array(digest))
      .map((byte) => byte.toString(16).padStart(2, "0"))
      .join("");
  }

  function randomId() {
    if (typeof crypto !== "undefined" && crypto.randomUUID) return "r-" + crypto.randomUUID();
    return "r-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 10);
  }

  async function db() {
    // openInkyscibDb is defined in storage.js and owns the schema, including
    // the object store this module uses.
    if (typeof window.openInkyscibDb !== "function") return null;
    const database = await window.openInkyscibDb();
    if (!database || !database.objectStoreNames.contains(STORE)) return null;
    return database;
  }

  /**
   * Run one transaction and report both whether it committed and what it read.
   *
   * The two are genuinely different answers — a lookup that finds nothing
   * still commits — and collapsing them into one truthy return is how a
   * missing document starts looking like a stored one.
   *
   * Resolves { ok, value }.
   */
  function run(database, mode, work) {
    return new Promise((resolve) => {
      let value;
      let tx;
      try {
        tx = database.transaction(STORE, mode);
      } catch (error) {
        console.warn("Inkyscib document store unavailable:", error);
        resolve({ ok: false, value: undefined });
        return;
      }
      const request = work(tx.objectStore(STORE));
      if (request) request.onsuccess = () => { value = request.result; };
      tx.oncomplete = () => resolve({ ok: true, value });
      tx.onerror = () => {
        console.warn("Inkyscib document store transaction failed:", tx.error);
        resolve({ ok: false, value: undefined });
      };
      tx.onabort = () => {
        console.warn("Inkyscib document store transaction aborted:", tx.error);
        resolve({ ok: false, value: undefined });
      };
    });
  }

  // ---------- writing ----------

  /**
   * Accepts whatever the caller happens to be holding.
   *
   * An import has a File; opening a .inkydoc has the raw bytes unpacked from
   * the archive. Both are the same document, and only one of them has an
   * .arrayBuffer() method.
   */
  async function toArrayBuffer(source) {
    if (source instanceof ArrayBuffer) return source;
    if (ArrayBuffer.isView(source)) {
      // Copy out of the view's own window into the buffer, since a subarray
      // shares its parent's memory and would otherwise carry the whole archive.
      return source.buffer.slice(
        source.byteOffset,
        source.byteOffset + source.byteLength
      );
    }
    if (typeof source?.arrayBuffer === "function") return source.arrayBuffer();
    throw new Error("That is not a file Inkyscib can store.");
  }

  /**
   * Store a file exactly as uploaded.
   *
   * Returns { id, bytes, deduped, verifiable } — `deduped` when the same
   * contents were already held, `verifiable` when the id is a real content
   * hash and so can be checked on load.
   */
  async function putDocument(file, meta = {}) {
    if (!file) throw new Error("No file to store.");

    const buffer = await toArrayBuffer(file);
    const verifiable = canHash();
    const id = verifiable ? await digestOf(buffer) : randomId();

    const database = await db();
    if (!database) {
      // Without IndexedDB the original cannot be kept. Say so rather than
      // pretending — callers fall back to the old raster-only behaviour.
      throw new Error("This browser will not let Inkyscib store the original file.");
    }

    if (verifiable) {
      const found = await run(database, "readonly", (store) => store.get(id));
      if (found.ok && found.value) {
        return { id, bytes: found.value.bytes, deduped: true, verifiable };
      }
    }

    const type = file.type || meta.type || "application/pdf";
    const record = {
      id,
      blob: new Blob([buffer], { type }),
      bytes: buffer.byteLength,
      type,
      name: meta.name || file.name || "document.pdf",
      pageCount: Number.isFinite(meta.pageCount) ? meta.pageCount : null,
      verifiable,
      createdAt: Date.now()
    };

    const stored = await run(database, "readwrite", (store) => store.put(record, id));
    if (!stored.ok) {
      throw new Error("There was not enough room to store the original file.");
    }

    return { id, bytes: record.bytes, deduped: false, verifiable };
  }

  // ---------- reading ----------

  async function getRecord(id) {
    if (!id) return null;
    const database = await db();
    if (!database) return null;
    const found = await run(database, "readonly", (store) => store.get(id));
    return found.ok ? (found.value || null) : null;
  }

  async function getDocumentBytes(id) {
    const record = await getRecord(id);
    if (!record?.blob) return null;
    return record.blob.arrayBuffer();
  }

  async function getDocumentBlob(id) {
    const record = await getRecord(id);
    return record?.blob || null;
  }

  async function hasDocument(id) {
    return !!(await getRecord(id));
  }

  async function listDocuments() {
    const database = await db();
    if (!database) return [];
    const found = await run(database, "readonly", (store) => store.getAll());
    return (found.value || []).map((record) => ({
      id: record.id,
      name: record.name,
      bytes: record.bytes,
      type: record.type,
      pageCount: record.pageCount,
      createdAt: record.createdAt
    }));
  }

  /**
   * Re-hash a stored document and compare against its id.
   *
   * This is the contract's first invariant made checkable: what comes out is
   * what went in. Returns { ok, reason }.
   */
  async function verifyDocument(id) {
    const record = await getRecord(id);
    if (!record) return { ok: false, reason: "missing" };
    if (!record.verifiable || !canHash()) return { ok: false, reason: "not-verifiable" };

    const actual = await digestOf(await record.blob.arrayBuffer());
    return actual === id
      ? { ok: true, reason: "match" }
      : { ok: false, reason: "digest-mismatch" };
  }

  // ---------- housekeeping ----------

  async function deleteDocument(id) {
    const database = await db();
    if (!database) return false;
    return (await run(database, "readwrite", (store) => store.delete(id))).ok;
  }

  /**
   * Drop stored originals nothing points at any more.
   *
   * Callers pass every id still referenced across all notebooks; anything else
   * is unreachable. Deliberately explicit rather than reference-counted, so a
   * bug in one deck can never delete a document another deck still uses.
   */
  async function collectGarbage(referencedIds) {
    const keep = new Set(referencedIds || []);
    const documents = await listDocuments();
    const removed = [];
    for (const document of documents) {
      if (!keep.has(document.id)) {
        if (await deleteDocument(document.id)) removed.push(document.id);
      }
    }
    return removed;
  }

  async function usage() {
    const documents = await listDocuments();
    return {
      count: documents.length,
      bytes: documents.reduce((total, document) => total + (document.bytes || 0), 0)
    };
  }

  window.Inkyscib = window.Inkyscib || {};
  window.Inkyscib.DocStore = {
    putDocument,
    getDocumentBytes,
    getDocumentBlob,
    getRecord,
    hasDocument,
    listDocuments,
    verifyDocument,
    deleteDocument,
    collectGarbage,
    usage
  };
})();
