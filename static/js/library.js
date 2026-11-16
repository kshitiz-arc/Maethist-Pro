// Notebook library: multiple documents plus file-based backup, all stored on
// the user's device (IndexedDB + localStorage). The server is never involved.
//
// Design: the active document always lives in the legacy storage keys
// ('drawing' / 'notebook' / 'ppt') that storage.js already reads and writes,
// so the existing save/load pipeline is untouched and a pre-library user's
// work automatically becomes their first notebook. Switching documents means:
// snapshot the active keys into 'doc:<id>', copy the target document into the
// active keys, then rerun loadDrawing().
(function () {
    'use strict';

    const LIBRARY_KEY = 'library';
    const DOC_PREFIX = 'doc:';
    const BACKUP_KIND = 'inkyscib-backup';
    const BACKUP_VERSION = 1;
    const MAX_BACKUP_FILE_BYTES = 900 * 1024 * 1024;
    const MAX_NAME_LENGTH = 80;
    const DOC_MODES = ['canvas', 'pages', 'slides'];
    const NO_DB_MESSAGE = 'This browser is blocking local storage, so the notebook library is unavailable.';

    let libraryCache = null;
    let busy = false;
    let statusTimer = null;

    function state() {
        return window.appState;
    }

    function storageApiReady() {
        return typeof openInkyscibDb === 'function' &&
            typeof readStoredRecord === 'function' &&
            typeof writeStoredRecord === 'function';
    }

    function newId() {
        return Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
    }

    async function deleteStoredRecord(key) {
        const db = await openInkyscibDb();
        if (!db) return false;

        return new Promise((resolve) => {
            const tx = db.transaction(INKYSCIB_DB_STORE, 'readwrite');
            tx.objectStore(INKYSCIB_DB_STORE).delete(key);
            tx.oncomplete = () => resolve(true);
            tx.onerror = () => resolve(false);
            tx.onabort = () => resolve(false);
        });
    }

    function normalizeEntry(entry) {
        if (!entry || typeof entry !== 'object' || typeof entry.id !== 'string' || !entry.id) return null;

        const name = typeof entry.name === 'string' && entry.name.trim()
            ? entry.name.trim().slice(0, MAX_NAME_LENGTH)
            : 'Untitled notes';

        return {
            id: entry.id,
            name,
            createdAt: Number.isFinite(entry.createdAt) ? entry.createdAt : Date.now(),
            updatedAt: Number.isFinite(entry.updatedAt) ? entry.updatedAt : Date.now(),
            preview: typeof entry.preview === 'string' && entry.preview.startsWith('data:image/') ? entry.preview : null,
            mode: DOC_MODES.includes(entry.mode) ? entry.mode : 'canvas'
        };
    }

    function normalizeLibrary(record) {
        const documents = Array.isArray(record?.documents)
            ? record.documents.map(normalizeEntry).filter(Boolean)
            : [];
        if (documents.length === 0) return null;

        const activeId = documents.some((doc) => doc.id === record.activeId)
            ? record.activeId
            : documents[0].id;

        return { activeId, documents };
    }

    async function ensureLibrary() {
        if (libraryCache) return libraryCache;
        if (!storageApiReady()) return null;

        const db = await openInkyscibDb();
        if (!db) return null;

        const stored = await readStoredRecord(LIBRARY_KEY);
        const normalized = stored.found ? normalizeLibrary(stored.value) : null;

        if (normalized) {
            libraryCache = normalized;
        } else {
            // First run: whatever already lives in the active keys becomes the
            // first document, so nobody's existing work is disturbed.
            const id = newId();
            libraryCache = {
                activeId: id,
                documents: [{
                    id,
                    name: 'My Notes',
                    createdAt: Date.now(),
                    updatedAt: Date.now(),
                    preview: null,
                    mode: 'canvas'
                }]
            };
            await saveLibrary();
        }

        return libraryCache;
    }

    async function saveLibrary() {
        if (!libraryCache) return false;
        const saved = await writeStoredRecord(LIBRARY_KEY, libraryCache);
        syncMenuChip();
        return saved;
    }

    function activeEntry() {
        if (!libraryCache) return null;
        return libraryCache.documents.find((doc) => doc.id === libraryCache.activeId) || null;
    }

    function currentMode() {
        const s = state();
        if (s?.ppt?.active) return 'slides';
        if (s?.notebook?.active) return 'pages';
        return 'canvas';
    }

    function modeLabel(mode) {
        if (mode === 'slides') return 'Slides';
        if (mode === 'pages') return 'Pages';
        return 'Canvas';
    }

    function formatUpdated(timestamp) {
        if (!Number.isFinite(timestamp)) return 'Never edited';

        const diff = Date.now() - timestamp;
        if (diff < 45 * 1000) return 'Edited just now';
        if (diff < 60 * 60 * 1000) return `Edited ${Math.max(1, Math.round(diff / 60000))} min ago`;
        if (diff < 24 * 60 * 60 * 1000) return `Edited ${Math.round(diff / 3600000)} h ago`;

        const date = new Date(timestamp);
        const sameYear = date.getFullYear() === new Date().getFullYear();
        return 'Edited ' + date.toLocaleDateString(undefined, sameYear
            ? { month: 'short', day: 'numeric' }
            : { year: 'numeric', month: 'short', day: 'numeric' });
    }

    // A small composite of the two live canvases (page/slide background +
    // ink) so each card shows exactly what the user last saw.
    function captureThumbnail() {
        try {
            if (typeof window.renderNow === 'function') {
                window.renderNow();
            }

            const pattern = document.getElementById('patternCanvas');
            const drawing = document.getElementById('drawingCanvas');
            if (!drawing || !drawing.width || !drawing.height) return null;

            const width = 300;
            const height = Math.max(60, Math.min(520, Math.round(drawing.height / drawing.width * width)));
            const thumb = document.createElement('canvas');
            thumb.width = width;
            thumb.height = height;
            const ctx = thumb.getContext('2d');

            // The preview sits on the notebook's own canvas ground.
            const ground = window.Inkyscib?.CanvasTheme?.get?.().ground;
            const isLight = (document.documentElement.dataset.theme || 'dark') === 'light';
            ctx.fillStyle = ground || (isLight ? '#f7f3ec' : '#0f1219');
            ctx.fillRect(0, 0, width, height);
            if (pattern && pattern.width && pattern.height) {
                ctx.drawImage(pattern, 0, 0, width, height);
            }
            ctx.drawImage(drawing, 0, 0, width, height);

            return thumb.toDataURL('image/jpeg', 0.72);
        } catch (error) {
            console.warn('Could not capture notebook preview:', error);
            return null;
        }
    }

    function sanitizeDocData(data) {
        const source = data && typeof data === 'object' ? data : {};
        return {
            drawing: Array.isArray(source.drawing) ? source.drawing : [],
            notebook: source.notebook && typeof source.notebook === 'object' ? source.notebook : null,
            ppt: source.ppt && typeof source.ppt === 'object' ? source.ppt : null
        };
    }

    // Persists the live workspace into the active document's own record and
    // refreshes its card metadata. saveDrawing({ force: true }) first flushes
    // the in-memory state into the active keys.
    async function snapshotActiveWorkspace() {
        const library = await ensureLibrary();
        if (!library) return false;

        if (typeof window.saveDrawing === 'function') {
            await window.saveDrawing({ force: true });
        }

        const [drawing, notebook, ppt] = await Promise.all([
            readStoredRecord('drawing'),
            readStoredRecord('notebook'),
            readStoredRecord('ppt')
        ]);

        const record = sanitizeDocData({
            drawing: drawing.found ? drawing.value : [],
            notebook: notebook.found ? notebook.value : null,
            ppt: ppt.found ? ppt.value : null
        });

        const saved = await writeStoredRecord(DOC_PREFIX + library.activeId, record);

        const entry = activeEntry();
        if (entry) {
            entry.updatedAt = Date.now();
            entry.mode = currentMode();
            const preview = captureThumbnail();
            if (preview) entry.preview = preview;
        }
        await saveLibrary();

        return saved;
    }

    async function writeActiveWorkspace(docData) {
        const data = sanitizeDocData(docData);

        await writeStoredRecord('drawing', data.drawing);
        await writeStoredRecord('notebook', data.notebook);
        await writeStoredRecord('ppt', data.ppt);

        // Mirror to localStorage the same way saveDrawing does, so the
        // fallback path never resurrects a previous document.
        if (typeof safeSetItem === 'function') {
            safeSetItem('inkyscib_drawing', JSON.stringify(data.drawing));
            safeSetItem('inkyscib_notebook', JSON.stringify(data.notebook));
        }
    }

    function resetWorkspaceState() {
        const s = state();
        if (!s) return;

        s.isDrawing = false;
        s.isPanning = false;
        s.currentPath = null;
        s.paths = [];
        s.undoStack = [];
        s.redoStack = [];
        s.ppt = { active: false, name: '', renderMode: '', slides: [], currentSlide: 0 };
        s.notebook = {
            active: false,
            paths: [],
            freeformPaths: [],
            transform: null,
            pageWidth: 794,
            pageHeight: 1123,
            pageGap: 96
        };
        s.transform = { scale: 1, offsetX: 0, offsetY: 0 };

        if (window.Inkyscib?.Selection?.clear) {
            window.Inkyscib.Selection.clear({ render: false });
        }
    }

    function finishWorkspaceSwap() {
        const s = state();
        if (s?.ppt?.active && typeof window.fitPptSlideToViewport === 'function') {
            window.fitPptSlideToViewport();
        }
        if (typeof window.render === 'function') {
            window.render();
        }
    }

    // Core switch used by open/create/delete/import. Callers must hold the
    // busy flag. Saves are suspended while the active keys are inconsistent.
    async function switchToDocument(id, { snapshotCurrent = true } = {}) {
        const library = await ensureLibrary();
        if (!library) return false;

        if (snapshotCurrent) {
            await snapshotActiveWorkspace();
        }

        window.__inkyscibSuspendSaves = true;
        try {
            const stored = await readStoredRecord(DOC_PREFIX + id);
            await writeActiveWorkspace(stored.found ? stored.value : null);
            library.activeId = id;
            await saveLibrary();

            resetWorkspaceState();
            if (typeof window.loadDrawing === 'function') {
                await window.loadDrawing();
            }
        } finally {
            window.__inkyscibSuspendSaves = false;
        }

        announceDocumentSwitch();
        finishWorkspaceSwap();
        return true;
    }

    function announceDocumentSwitch() {
        try {
            document.dispatchEvent(new CustomEvent('inkyscibDocumentSwitched'));
        } catch (error) {
            /* nothing depends on this firing */
        }
    }

    async function runExclusive(label, task) {
        if (busy) return;

        if (!state()?.storageReady) {
            setStatus('Inkyscib is still loading — try again in a moment.', 'error');
            return;
        }

        busy = true;
        document.body.classList.add('library-busy');
        try {
            await task();
        } catch (error) {
            console.error(`Notebook library action failed (${label}):`, error);
            setStatus('Something went wrong. Your notes were not changed.', 'error');
        } finally {
            busy = false;
            document.body.classList.remove('library-busy');
            window.__inkyscibSuspendSaves = false;
        }
    }

    // The notebook index, for anything that wants to list or switch documents.
    async function listDocuments() {
        const library = await ensureLibrary();
        if (!library) return { activeId: null, documents: [] };
        return {
            activeId: library.activeId,
            documents: library.documents.map((doc) => ({
                id: doc.id,
                name: doc.name,
                mode: doc.mode,
                updatedAt: doc.updatedAt
            }))
        };
    }

    // Reads the active document's saved records without writing anything.
    // .inkydoc builds on this so a save writes what is on screen rather than
    // whatever the last autosave happened to catch.
    async function readActiveWorkspace() {
        const [drawing, notebook, ppt] = await Promise.all([
            readStoredRecord('drawing'),
            readStoredRecord('notebook'),
            readStoredRecord('ppt')
        ]);

        return sanitizeDocData({
            drawing: drawing.found ? drawing.value : [],
            notebook: notebook.found ? notebook.value : null,
            ppt: ppt.found ? ppt.value : null
        });
    }

    // Loads a workspace snapshot that came from outside the library — an
    // opened .inkydoc — into a notebook of its own.
    //
    // Deliberately a new entry rather than an overwrite: opening a file must
    // never be the thing that loses the work already on screen.
    function loadDocumentData(docData, { title } = {}) {
        return runExclusive('load', async () => {
            const library = await ensureLibrary();
            if (!library) {
                setStatus(NO_DB_MESSAGE, 'error');
                return false;
            }

            await snapshotActiveWorkspace();

            const entry = {
                id: newId(),
                name: uniqueDocumentName(library, title),
                createdAt: Date.now(),
                updatedAt: Date.now(),
                preview: null,
                mode: 'canvas'
            };
            library.documents.push(entry);

            window.__inkyscibSuspendSaves = true;
            try {
                await writeStoredRecord(DOC_PREFIX + entry.id, sanitizeDocData(docData));
                await writeActiveWorkspace(docData);
                library.activeId = entry.id;
                await saveLibrary();

                resetWorkspaceState();
                if (typeof window.loadDrawing === 'function') {
                    await window.loadDrawing();
                }
            } finally {
                window.__inkyscibSuspendSaves = false;
            }

            entry.mode = currentMode();
            await saveLibrary();
            syncMenuChip();
            announceDocumentSwitch();
            finishWorkspaceSwap();
            return true;
        });
    }

    function uniqueDocumentName(library, title) {
        const base = String(title || '').trim().slice(0, MAX_NAME_LENGTH) || nextDocumentName(library);
        const taken = new Set(library.documents.map((doc) => doc.name));
        if (!taken.has(base)) return base;

        let suffix = 2;
        while (taken.has(`${base} (${suffix})`)) suffix += 1;
        return `${base} (${suffix})`;
    }

    function openDocument(id) {
        return runExclusive('open', async () => {
            const library = await ensureLibrary();
            if (!library) {
                setStatus(NO_DB_MESSAGE, 'error');
                return;
            }

            const entry = library.documents.find((doc) => doc.id === id);
            if (!entry) return;
            if (id === library.activeId) {
                closeLibraryModal();
                return;
            }

            setStatus(`Opening “${entry.name}”…`, 'loading');
            await switchToDocument(id);
            renderGrid();
            setStatus('', 'muted');
            // Straight back to writing — no extra tap to dismiss the dialog.
            closeLibraryModal();
        });
    }

    function nextDocumentName(library) {
        const taken = new Set(library.documents.map((doc) => doc.name));
        let index = library.documents.length + 1;
        let name = `Notebook ${index}`;
        while (taken.has(name)) {
            index += 1;
            name = `Notebook ${index}`;
        }
        return name;
    }

    function createDocument() {
        return runExclusive('create', async () => {
            const library = await ensureLibrary();
            if (!library) {
                setStatus(NO_DB_MESSAGE, 'error');
                return;
            }

            setStatus('Creating a fresh notebook…', 'loading');

            const entry = {
                id: newId(),
                name: nextDocumentName(library),
                createdAt: Date.now(),
                updatedAt: Date.now(),
                preview: null,
                mode: 'canvas'
            };
            library.documents.push(entry);

            await switchToDocument(entry.id);

            // A brand-new canvas should open at the default view, not wherever
            // the previous document was panned to.
            const s = state();
            if (s && !s.ppt?.active && !s.notebook?.active) {
                s.transform = { scale: 1, offsetX: 0, offsetY: 0 };
                if (typeof window.render === 'function') window.render();
            }

            setStatus(`Created “${entry.name}”. You're in it now.`, 'success');
            renderGrid();
        });
    }

    // nextName is optional. Without it this still raises its own prompt, which
    // is what the Library modal's pencil relies on; with it the caller has
    // already collected the name its own way (Recents edits it in the row).
    function renameDocument(id, nextName) {
        return runExclusive('rename', async () => {
            const library = await ensureLibrary();
            if (!library) return;

            const entry = library.documents.find((doc) => doc.id === id);
            if (!entry) return;

            const input = typeof nextName === 'string'
                ? nextName
                : window.prompt('Rename notebook', entry.name);
            if (input === null) return;

            const name = input.trim().slice(0, MAX_NAME_LENGTH);
            if (!name || name === entry.name) return;

            entry.name = name;
            entry.updatedAt = Date.now();
            await saveLibrary();
            setStatus(`Renamed to “${name}”.`, 'success');
            renderGrid();
        });
    }

    // Pass { confirmed: true } when the caller has already asked. Recents does,
    // through the app's own confirm dialog: window.confirm looks nothing like
    // the app and Playwright auto-dismisses it, so it cannot be tested.
    function deleteDocument(id, options) {
        return runExclusive('delete', async () => {
            const library = await ensureLibrary();
            if (!library) return;

            const entry = library.documents.find((doc) => doc.id === id);
            if (!entry) return;

            const confirmed = options?.confirmed === true || window.confirm(
                `Delete “${entry.name}”? It will be permanently removed from this device.`
            );
            if (!confirmed) return;

            // Read before the record goes: afterwards there is no way back to
            // what this notebook imported.
            const doomedOriginal = originalIdOf(await readStoredRecord(DOC_PREFIX + id));

            const wasActive = id === library.activeId;
            library.documents = library.documents.filter((doc) => doc.id !== id);
            await deleteStoredRecord(DOC_PREFIX + id);

            if (wasActive) {
                let next = library.documents
                    .slice()
                    .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))[0];

                if (!next) {
                    next = {
                        id: newId(),
                        name: 'My Notes',
                        createdAt: Date.now(),
                        updatedAt: Date.now(),
                        preview: null,
                        mode: 'canvas'
                    };
                    library.documents.push(next);
                }

                // The deleted document must not be snapshotted back into
                // existence, so skip the snapshot on this switch.
                await switchToDocument(next.id, { snapshotCurrent: false });
            } else {
                await saveLibrary();
            }

            // The notebook's imported original used to live on in the
            // documents store with nothing referencing it -- a PDF or deck's
            // worth of bytes kept forever, on a device chosen for being cheap.
            // Released after the library is saved, so a failure here cannot
            // undo the delete.
            await releaseOriginals([doomedOriginal]);

            setStatus(`Deleted “${entry.name}”.`, 'success');
            renderGrid();
        });
    }

    // The imported original a notebook points at, if any. A PDF and a deck
    // both land in the `ppt` slot (pdf-local-import sets renderMode 'pdf' on
    // the same deck object), and storage.js persists only `ppt.docId`.
    function originalIdOf(docData) {
        const id = docData?.ppt?.docId;
        return typeof id === 'string' && id ? id : null;
    }

    // Deliberately NOT DocStore.collectGarbage: a global sweep deletes
    // everything absent from the list it is handed, so one missed reference
    // destroys an original that is still in use. This removes only the ids the
    // deleted notebook held, and only once nothing else points at them -- a
    // mistake here can leave garbage behind, never lose a document.
    async function releaseOriginals(candidateIds) {
        const store = window.Inkyscib?.DocStore;
        if (!store || typeof store.deleteDocument !== 'function') return;
        const wanted = (candidateIds || []).filter(Boolean);
        if (!wanted.length) return;

        try {
            const library = await ensureLibrary();
            const stillUsed = new Set();
            for (const doc of library?.documents || []) {
                const stored = await readStoredRecord(DOC_PREFIX + doc.id);
                const id = originalIdOf(stored);
                if (id) stillUsed.add(id);
            }
            for (const id of new Set(wanted)) {
                if (!stillUsed.has(id)) await store.deleteDocument(id);
            }
        } catch (e) {
            // Reclaiming space must never be the thing that breaks a delete.
            console.warn('Could not release the notebook original:', e);
        }
    }

    function backupFilename() {
        const now = new Date();
        const pad = (value) => String(value).padStart(2, '0');
        return `inkyscib-backup-${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}.inky`;
    }

    function downloadBlob(blob, filename) {
        const helpers = window.Inkyscib?.PptExport;
        if (helpers?.downloadBlob) {
            helpers.downloadBlob(blob, filename);
            return;
        }

        const url = URL.createObjectURL(blob);
        const anchor = document.createElement('a');
        anchor.href = url;
        anchor.download = filename;
        document.body.appendChild(anchor);
        anchor.click();
        anchor.remove();
        window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    }

    function exportBackup() {
        return runExclusive('export', async () => {
            const library = await ensureLibrary();
            if (!library) {
                setStatus(NO_DB_MESSAGE, 'error');
                return;
            }

            setStatus('Packing your notebooks…', 'loading');
            await snapshotActiveWorkspace();

            const documents = [];
            for (const entry of library.documents) {
                const stored = await readStoredRecord(DOC_PREFIX + entry.id);
                documents.push({
                    id: entry.id,
                    name: entry.name,
                    createdAt: entry.createdAt,
                    updatedAt: entry.updatedAt,
                    preview: entry.preview,
                    mode: entry.mode,
                    data: sanitizeDocData(stored.found ? stored.value : null)
                });
            }

            const payload = {
                app: 'inkyscib',
                kind: BACKUP_KIND,
                version: BACKUP_VERSION,
                exportedAt: new Date().toISOString(),
                activeId: library.activeId,
                documents
            };

            const blob = new Blob([JSON.stringify(payload)], { type: 'application/json' });
            downloadBlob(blob, backupFilename());
            // Read by backup-reminder.js, which nudges when this gets old.
            try { localStorage.setItem('inkyscib-last-backup', new Date().toISOString()); } catch (error) { /* blocked */ }
            document.dispatchEvent(new CustomEvent('inkyscibBackupSaved'));

            const count = documents.length;
            setStatus(`Backup saved · ${count} notebook${count === 1 ? '' : 's'}. Keep the .inky file somewhere safe.`, 'success');
        });
    }

    function importBackup(file) {
        return runExclusive('import', async () => {
            if (!file) return;

            if (file.size > MAX_BACKUP_FILE_BYTES) {
                setStatus('That backup file is too large to import.', 'error');
                return;
            }

            const library = await ensureLibrary();
            if (!library) {
                setStatus(NO_DB_MESSAGE, 'error');
                return;
            }

            setStatus('Reading backup…', 'loading');

            let payload;
            try {
                payload = JSON.parse(await file.text());
            } catch (error) {
                setStatus('That file is not a valid Inkyscib backup.', 'error');
                return;
            }

            if (payload?.app !== 'inkyscib' || payload?.kind !== BACKUP_KIND || !Array.isArray(payload.documents)) {
                setStatus('That file is not a valid Inkyscib backup.', 'error');
                return;
            }

            const docs = payload.documents.filter((doc) => doc && typeof doc === 'object');
            if (docs.length === 0) {
                setStatus('This backup has no notebooks in it.', 'error');
                return;
            }

            const confirmed = window.confirm(
                `Restore ${docs.length} notebook${docs.length === 1 ? '' : 's'} from this backup? ` +
                'They will be added to your library without touching your current notes.'
            );
            if (!confirmed) return;

            // Keep the current document safe before anything else happens.
            await snapshotActiveWorkspace();

            const idMap = new Map();
            for (const doc of docs) {
                const entry = normalizeEntry({ ...doc, id: newId() });
                if (!entry) continue;

                const saved = await writeStoredRecord(DOC_PREFIX + entry.id, sanitizeDocData(doc.data));
                if (!saved) {
                    setStatus('Import failed while writing to browser storage.', 'error');
                    return;
                }

                library.documents.push(entry);
                if (typeof doc.id === 'string') idMap.set(doc.id, entry.id);
            }

            await saveLibrary();

            const openId = idMap.get(payload.activeId) || idMap.values().next().value;
            if (openId) {
                await switchToDocument(openId, { snapshotCurrent: false });
            }

            setStatus(`Imported ${idMap.size} notebook${idMap.size === 1 ? '' : 's'} from the backup.`, 'success');
            renderGrid();
        });
    }

    // ------------------------------------------------------------------ UI

    function setStatus(text, tone = 'muted') {
        const status = document.getElementById('libraryStatus');
        if (!status) return;

        window.clearTimeout(statusTimer);
        status.textContent = text || '';
        status.dataset.tone = text ? tone : 'muted';

        if (text && tone === 'success') {
            statusTimer = window.setTimeout(() => {
                status.textContent = '';
                status.dataset.tone = 'muted';
            }, 4500);
        }
    }

    function syncMenuChip() {
        const chip = document.getElementById('libraryMenuChip');
        const entry = activeEntry();
        if (!chip) return;
        chip.textContent = entry
            ? (entry.name.length > 16 ? entry.name.slice(0, 15) + '…' : entry.name)
            : 'Open';
    }

    function ensureLibraryModal() {
        let modal = document.getElementById('libraryModal');
        if (modal) return modal;

        modal = document.createElement('div');
        modal.id = 'libraryModal';
        modal.className = 'library-modal';
        modal.setAttribute('aria-hidden', 'true');
        modal.setAttribute('role', 'dialog');
        modal.setAttribute('aria-modal', 'true');
        modal.setAttribute('aria-labelledby', 'libraryTitle');
        modal.innerHTML = `
            <div class="library-panel">
                <button class="library-close" type="button" aria-label="Close notebooks">
                    <i class="fa-times"></i>
                </button>
                <p class="library-kicker">Stored on this device</p>
                <h3 id="libraryTitle">My Notebooks</h3>
                <p class="library-copy">Every notebook lives in your browser. Nothing is uploaded anywhere — export a backup file to move or protect your work.</p>
                <div class="library-actions">
                    <button id="libraryNewBtn" class="library-action-btn library-action-primary" type="button">
                        <i class="fa-plus"></i>
                        <span>New notebook</span>
                    </button>
                    <button id="libraryExportBtn" class="library-action-btn" type="button" title="Download all notebooks as one .inky file">
                        <i class="fa-download"></i>
                        <span>Export backup</span>
                    </button>
                    <button id="libraryImportBtn" class="library-action-btn" type="button" title="Restore notebooks from a .inky file">
                        <i class="fa-upload"></i>
                        <span>Import backup</span>
                    </button>
                    <input id="libraryImportInput" type="file" accept=".inky,.json,application/json" hidden>
                </div>
                <div id="libraryStatus" class="library-status" data-tone="muted" aria-live="polite"></div>
                <div id="libraryGrid" class="library-grid"></div>
            </div>
        `;

        modal.addEventListener('click', (event) => {
            if (event.target === modal) closeLibraryModal();
        });
        modal.querySelector('.library-close').addEventListener('click', closeLibraryModal);
        modal.querySelector('#libraryNewBtn').addEventListener('click', createDocument);
        modal.querySelector('#libraryExportBtn').addEventListener('click', exportBackup);

        const importInput = modal.querySelector('#libraryImportInput');
        modal.querySelector('#libraryImportBtn').addEventListener('click', () => importInput.click());
        importInput.addEventListener('change', () => {
            importBackup(importInput.files?.[0]);
            importInput.value = '';
        });

        document.body.appendChild(modal);
        return modal;
    }

    function isLibraryModalOpen() {
        const modal = document.getElementById('libraryModal');
        return !!modal && modal.classList.contains('active');
    }

    async function openLibraryModal() {
        const modal = ensureLibraryModal();
        modal.classList.add('active');
        modal.setAttribute('aria-hidden', 'false');
        document.body.classList.add('library-open');
        setStatus('');

        const library = await ensureLibrary();
        if (!library) {
            setStatus(NO_DB_MESSAGE, 'error');
            renderGrid();
            return;
        }

        // Refresh the active card so its preview matches the canvas right now.
        const entry = activeEntry();
        if (entry) {
            entry.mode = currentMode();
            const preview = captureThumbnail();
            if (preview) entry.preview = preview;
            saveLibrary();
        }

        renderGrid();

        const closeBtn = modal.querySelector('.library-close');
        if (closeBtn) window.requestAnimationFrame(() => closeBtn.focus());
    }

    function closeLibraryModal() {
        const modal = document.getElementById('libraryModal');
        if (!modal) return;
        modal.classList.remove('active');
        modal.setAttribute('aria-hidden', 'true');
        document.body.classList.remove('library-open');
    }

    function buildCardAction(iconClass, label) {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'library-card-action';
        button.title = label;
        button.setAttribute('aria-label', label);
        button.innerHTML = `<i class="${iconClass}"></i>`;
        return button;
    }

    function buildCard(entry, isActive) {
        const card = document.createElement('div');
        card.className = 'library-card' + (isActive ? ' is-active' : '');
        card.setAttribute('role', 'button');
        card.tabIndex = 0;
        card.setAttribute('aria-label', isActive ? `${entry.name} (open now)` : `Open ${entry.name}`);

        const preview = document.createElement('div');
        preview.className = 'library-card-preview';
        if (entry.preview) {
            const img = document.createElement('img');
            img.src = entry.preview;
            img.alt = '';
            img.loading = 'lazy';
            img.draggable = false;
            preview.appendChild(img);
        } else {
            preview.innerHTML = '<i class="fa-pen library-card-placeholder"></i>';
        }
        if (isActive) {
            const badge = document.createElement('span');
            badge.className = 'library-card-badge';
            badge.textContent = 'Open now';
            preview.appendChild(badge);
        }
        card.appendChild(preview);

        const body = document.createElement('div');
        body.className = 'library-card-body';

        const name = document.createElement('div');
        name.className = 'library-card-name';
        name.textContent = entry.name;
        name.title = entry.name;

        const meta = document.createElement('div');
        meta.className = 'library-card-meta';
        meta.textContent = `${modeLabel(entry.mode)} · ${formatUpdated(entry.updatedAt)}`;

        body.appendChild(name);
        body.appendChild(meta);
        card.appendChild(body);

        const actions = document.createElement('div');
        actions.className = 'library-card-actions';
        const renameBtn = buildCardAction('fa-pen', `Rename ${entry.name}`);
        const deleteBtn = buildCardAction('fa-trash', `Delete ${entry.name}`);
        actions.appendChild(renameBtn);
        actions.appendChild(deleteBtn);
        card.appendChild(actions);

        card.addEventListener('click', () => openDocument(entry.id));
        card.addEventListener('keydown', (event) => {
            if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault();
                openDocument(entry.id);
            }
        });
        renameBtn.addEventListener('click', (event) => {
            event.stopPropagation();
            renameDocument(entry.id);
        });
        deleteBtn.addEventListener('click', (event) => {
            event.stopPropagation();
            deleteDocument(entry.id);
        });

        return card;
    }

    function renderGrid() {
        const grid = document.getElementById('libraryGrid');
        if (!grid) return;

        grid.innerHTML = '';
        if (!libraryCache) return;

        libraryCache.documents
            .slice()
            .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))
            .forEach((entry) => {
                grid.appendChild(buildCard(entry, entry.id === libraryCache.activeId));
            });

        syncMenuChip();
    }

    function initLibraryUi() {
        const menuButton = document.getElementById('libraryBtn');
        if (menuButton) {
            menuButton.addEventListener('click', () => {
                document.body.classList.remove('menu-open');
                document.getElementById('sideMenu')?.setAttribute('aria-hidden', 'true');
                openLibraryModal();
            });
        }

        document.addEventListener('keydown', (event) => {
            if (event.key === 'Escape' && isLibraryModalOpen()) {
                closeLibraryModal();
            }
        });

        // Create the index early so the menu chip can show the active name.
        ensureLibrary().then(syncMenuChip);
    }

    window.Inkyscib = window.Inkyscib || {};
    window.Inkyscib.Library = {
        openLibraryModal,
        closeLibraryModal,
        openDocument,
        createDocument,
        renameDocument,
        deleteDocument,
        exportBackup,
        importBackup,
        snapshotActiveWorkspace,
        listDocuments,
        readActiveWorkspace,
        loadDocumentData,
        currentMode
    };

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', initLibraryUi, { once: true });
    } else {
        initLibraryUi();
    }
})();
