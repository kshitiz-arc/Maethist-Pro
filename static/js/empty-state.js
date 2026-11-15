// Marks the body while the workspace is empty, so the blank canvas can show
// its one line of guidance (#emptyHint) and drop it the moment anything is on
// the page. That is the whole job: no drawing, no animation, no timers.
(function () {
    let wasEmpty = null;

    function hasWorkspaceContent() {
        const state = window.appState;
        return !!(state && (
            (Array.isArray(state.paths) && state.paths.length) ||
            state.ppt?.active ||
            state.notebook?.active ||
            state.pdf?.active
        ));
    }

    // canvasRendered fires on every frame of every stroke, so this has to stay
    // cheap: two array lengths and an early return. Only a change of state
    // touches the DOM. It is dispatched on `document` and does not bubble
    // (core.js dispatchAppEvent), so listening on window would hear nothing.
    function sync() {
        const empty = !hasWorkspaceContent();
        if (empty === wasEmpty) return;
        wasEmpty = empty;
        document.body.classList.toggle('canvas-empty', empty);
    }

    document.addEventListener('canvasRendered', sync);
    sync();
}());
