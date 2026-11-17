(function () {
  "use strict";

  const ytPlayer = document.getElementById("ytPlayer");
  const ytToggleBtn = document.getElementById("ytToggleBtn");
  const ytSearchInput = document.getElementById("ytSearchInput");
  const ytSearchBtn = document.getElementById("ytSearchBtn");
  const ytEmbedSlot = document.getElementById("ytEmbedSlot");
  const ytMinimize = document.getElementById("ytMinimize");
  const ytClose = document.getElementById("ytClose");
  const ytDragHandle = document.getElementById("ytDragHandle");
  const ytResizeHandles = Array.from(document.querySelectorAll("[data-yt-resize]"));
  const ytPlaceholder = document.getElementById("ytPlaceholder");
  const ytPlayerTitle = document.querySelector(".yt-player-title");
  const ytSearchResults = document.getElementById("ytSearchResults");
  const ytBackBtn = document.getElementById("ytBackBtn");
  const ytSaveFrame = document.getElementById("ytSaveFrame");

  if (!ytPlayer || !ytToggleBtn || !ytEmbedSlot) return;

  const STORAGE_KEY = "inkyscib-yt-player";
  // Room for the lecture controls under a 16:9 picture.
  const DEFAULT_SIZE = { width: 460, height: 400 };
  const MIN_SIZE = { width: 280, height: 200 };
  // A 4K frame at JPEG quality 95 is about 3-5 MB as a data URL. Matches
  // INKYSCIB_MAX_FRAME_DATA_URL_LENGTH in storage.js and
  // YOUTUBE_FRAME_MAX_DATA_URL in app.py.
  const MAX_FRAME_DATA_URL = 12 * 1024 * 1024;

  let isOpen = false;
  let isMinimized = false;
  let isPlaying = false;
  let dragState = null;
  let dragFrame = null;
  let pendingDragPoint = null;
  let resizeState = null;
  let resizeFrame = null;
  let pendingResizePoint = null;
  let expandedSize = { ...DEFAULT_SIZE };
  let closeTimer = null;

  let youtubeApiPromise = null;
  let apiPlayer = null;
  let playerReady = false;
  let playbackReady = false;
  let playerBooting = false;
  let pendingLoad = null;
  let currentVideoId = "";
  let currentVideoTitle = "";
  let requestedStartSeconds = 0;
  let requestedStartAt = 0;
  let captureInFlight = false;
  let resumeAfterSearch = false;

  let searchController = null;
  let searchRequestId = 0;

  function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
  }

  function finiteNumber(value, fallback) {
    const number = Number(value);
    return Number.isFinite(number) ? number : fallback;
  }

  function loadState() {
    const fallback = { x: null, y: null, ...DEFAULT_SIZE, lastUrl: "" };
    try {
      const saved = JSON.parse(localStorage.getItem(STORAGE_KEY));
      if (!saved || typeof saved !== "object") return fallback;
      return {
        x: saved.x === null ? null : finiteNumber(saved.x, null),
        y: saved.y === null ? null : finiteNumber(saved.y, null),
        width: finiteNumber(saved.width, DEFAULT_SIZE.width),
        height: finiteNumber(saved.height, DEFAULT_SIZE.height),
        lastUrl: typeof saved.lastUrl === "string" ? saved.lastUrl : ""
      };
    } catch (_) {
      return fallback;
    }
  }

  function saveState() {
    const rect = ytPlayer.getBoundingClientRect();
    const styledLeft = Number.parseFloat(ytPlayer.style.left);
    const styledTop = Number.parseFloat(ytPlayer.style.top);
    const width = isMinimized ? expandedSize.width : rect.width;
    const height = isMinimized ? expandedSize.height : rect.height;

    if (!isMinimized && rect.width > 0 && rect.height > 0) {
      expandedSize = { width: rect.width, height: rect.height };
    }

    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({
        x: Number.isFinite(styledLeft) ? styledLeft : rect.left,
        y: Number.isFinite(styledTop) ? styledTop : rect.top,
        width: Math.round(width || DEFAULT_SIZE.width),
        height: Math.round(height || DEFAULT_SIZE.height),
        lastUrl: ytSearchInput?.value || ""
      }));
    } catch (_) {
      // The player remains usable when browser storage is blocked.
    }
  }

  function viewportPlayerSize(width, height) {
    const margin = 8;
    const maxWidth = Math.max(240, Math.min(960, window.innerWidth - margin * 2));
    // Never taller than the room under the tool bar. A player taller than
    // that had to choose between staying on screen and staying below the
    // chrome; staying on screen won, and on a 768px laptop its title bar and
    // the top of the video sat under the tool bar.
    const maxHeight = Math.max(180, Math.min(720, window.innerHeight - chromeFloor() - margin * 2));
    const minWidth = Math.min(MIN_SIZE.width, maxWidth);
    const minHeight = Math.min(MIN_SIZE.height, maxHeight);
    return {
      width: clamp(width, minWidth, maxWidth),
      height: clamp(height, minHeight, maxHeight)
    };
  }

  // The lowest point of the chrome along the top of the screen: the tool bar
  // and the File ribbon. The player's title bar has to stay below it. The
  // ribbon stacks above the player (9996 against 100), and every way the
  // player got a position -- the 100px default, the viewport clamp and the
  // drag -- let its top go as high as 0-8px, so wherever the ribbon happened
  // to fall at a given width it covered half the title bar and the handle you
  // move the player by. Only chrome in the top half counts: with the tool bar
  // docked at the bottom it is not above the player at all.
  function chromeFloor() {
    let floor = 0;
    document.querySelectorAll(".toolbar, .file-ribbon").forEach((element) => {
      const rect = element.getBoundingClientRect();
      if (!rect.height || rect.top > window.innerHeight / 2) return;
      floor = Math.max(floor, rect.bottom);
    });
    return Math.round(floor);
  }

  // The highest the player may sit, given its height. Where the screen is too
  // short to keep it clear of the chrome and still fully on screen, staying on
  // screen wins -- a player you cannot see the bottom of is worse.
  function minPlayerTop(height) {
    const margin = 8;
    const wanted = chromeFloor() + margin;
    return Math.max(margin, Math.min(wanted, window.innerHeight - height - margin));
  }

  function clampPlayerToViewport() {
    if (!isOpen) return;
    const margin = 8;
    // The size that was set, not the one on screen: the player animates its
    // height, and reading offsetHeight mid-animation wrote the half-way height
    // back as the new size (a 400px player opened at 300px).
    const layoutWidth = Number.parseFloat(ytPlayer.style.width) || ytPlayer.offsetWidth || expandedSize.width;
    const layoutHeight = Number.parseFloat(ytPlayer.style.height) || ytPlayer.offsetHeight || expandedSize.height;
    const size = viewportPlayerSize(
      isMinimized ? expandedSize.width : layoutWidth,
      isMinimized ? expandedSize.height : layoutHeight
    );

    if (!isMinimized) {
      ytPlayer.style.width = `${size.width}px`;
      ytPlayer.style.height = `${size.height}px`;
      expandedSize = size;
    }

    const width = isMinimized ? (ytPlayer.offsetWidth || size.width) : size.width;
    const height = isMinimized ? (ytPlayer.offsetHeight || 46) : size.height;
    const styledLeft = Number.parseFloat(ytPlayer.style.left);
    const styledTop = Number.parseFloat(ytPlayer.style.top);
    const x = clamp(
      Number.isFinite(styledLeft) ? styledLeft : ytPlayer.offsetLeft,
      margin,
      Math.max(margin, window.innerWidth - width - margin)
    );
    const y = clamp(
      Number.isFinite(styledTop) ? styledTop : ytPlayer.offsetTop,
      minPlayerTop(height),
      Math.max(margin, window.innerHeight - height - margin)
    );
    ytPlayer.style.left = `${x}px`;
    ytPlayer.style.top = `${y}px`;
    ytPlayer.style.right = "auto";
  }

  function parseTimeValue(value) {
    if (!value) return 0;
    const text = String(value).trim().toLowerCase();
    if (/^\d+(?:\.\d+)?$/.test(text)) return Math.max(0, Number(text));

    let seconds = 0;
    let matched = false;
    const pattern = /(\d+(?:\.\d+)?)(h|m|s)/g;
    let part;
    while ((part = pattern.exec(text))) {
      matched = true;
      const amount = Number(part[1]);
      if (part[2] === "h") seconds += amount * 3600;
      if (part[2] === "m") seconds += amount * 60;
      if (part[2] === "s") seconds += amount;
    }
    return matched ? Math.max(0, seconds) : 0;
  }

  function extractVideo(input) {
    if (!input) return null;
    const value = input.trim();
    if (/^[A-Za-z0-9_-]{11}$/.test(value)) return { id: value, start: 0 };

    try {
      const url = new URL(/^https?:\/\//i.test(value) ? value : `https://${value}`);
      const host = url.hostname.toLowerCase().replace(/^www\./, "");
      let id = "";
      if (host === "youtu.be") {
        id = url.pathname.split("/").filter(Boolean)[0] || "";
      } else if (host === "youtube.com" || host.endsWith(".youtube.com")) {
        const parts = url.pathname.split("/").filter(Boolean);
        if (url.pathname === "/watch") id = url.searchParams.get("v") || "";
        if (["embed", "shorts", "live", "v"].includes(parts[0])) id = parts[1] || "";
      }
      if (/^[A-Za-z0-9_-]{11}$/.test(id)) {
        const start = parseTimeValue(
          url.searchParams.get("t") || url.searchParams.get("start") || url.hash.replace(/^#t=/, "")
        );
        return { id, start };
      }
    } catch (_) {
      // Non-URL text is handled as a search query below.
    }

    return null;
  }

  function formatVideoTime(seconds) {
    const total = Math.max(0, Math.floor(Number(seconds) || 0));
    const hours = Math.floor(total / 3600);
    const minutes = Math.floor((total % 3600) / 60);
    const secs = total % 60;
    return hours
      ? `${hours}:${String(minutes).padStart(2, "0")}:${String(secs).padStart(2, "0")}`
      : `${minutes}:${String(secs).padStart(2, "0")}`;
  }

  function canonicalVideoUrl(videoId, seconds) {
    const time = Math.max(0, Math.floor(Number(seconds) || 0));
    return `https://youtu.be/${videoId}${time ? `?t=${time}s` : ""}`;
  }

  function openPlayer(options = {}) {
    if (closeTimer) {
      clearTimeout(closeTimer);
      closeTimer = null;
    }

    isOpen = true;
    document.body.classList.add("yt-runtime-active");
    ytPlayer.hidden = false;
    ytPlayer.classList.remove("yt-closing", "yt-minimized");
    ytPlayer.classList.add("yt-opening");
    ytToggleBtn.classList.add("yt-active");
    isMinimized = false;
    if (ytMinimize) {
      ytMinimize.title = "Minimize";
      ytMinimize.setAttribute("aria-label", "Minimize YouTube player");
    }

    const saved = loadState();
    const size = viewportPlayerSize(saved.width, saved.height);
    expandedSize = size;
    ytPlayer.style.width = `${size.width}px`;
    ytPlayer.style.height = `${size.height}px`;
    ytPlayer.style.right = "auto";

    if (saved.x !== null && saved.y !== null) {
      ytPlayer.style.left = `${saved.x}px`;
      ytPlayer.style.top = `${saved.y}px`;
    } else {
      ytPlayer.style.left = `${Math.max(8, window.innerWidth - size.width - 80)}px`;
      // Below the chrome rather than a fixed 100px, which put the title bar
      // under the ribbon on any screen where the ribbon sat lower than that.
      ytPlayer.style.top = `${minPlayerTop(size.height)}px`;
    }

    if (saved.lastUrl && ytSearchInput && !ytSearchInput.value) {
      ytSearchInput.value = saved.lastUrl;
    }

    requestAnimationFrame(clampPlayerToViewport);
    renderRecent();
    if (pollTimer === null && apiPlayer && playerReady) startPolling();
    if (options.focus !== false && !isPlaying) {
      requestAnimationFrame(() => { if (!isPlaying) ytSearchInput?.focus(); });
    }
    setTimeout(() => {
      ytPlayer.classList.remove("yt-opening");
      clampPlayerToViewport();
    }, 500);
  }

  function ensurePlayerMount() {
    ytEmbedSlot.innerHTML = '<div id="ytIframe"></div>';
  }

  function destroyApiPlayer() {
    if (apiPlayer) {
      try { apiPlayer.destroy(); } catch (_) { /* player was already gone */ }
    }
    apiPlayer = null;
    playerReady = false;
    playbackReady = false;
    playerBooting = false;
    pendingLoad = null;
    ensurePlayerMount();
  }

  function closePlayer() {
    if (!isOpen && ytPlayer.hidden) return;
    rememberPosition();
    stopPolling();
    setNotesOpen(false);
    clearLoop(true);
    setDocked(false);
    saveState();
    isOpen = false;
    document.body.classList.remove("yt-runtime-active");
    ytPlayer.classList.add("yt-closing");
    ytToggleBtn.classList.remove("yt-active", "yt-playing");
    try { apiPlayer?.pauseVideo(); } catch (_) { /* not ready */ }
    if (searchController) searchController.abort();
    closeTimer = setTimeout(() => {
      closeTimer = null;
      if (isOpen) return;
      ytPlayer.hidden = true;
      ytPlayer.classList.remove("yt-closing", "yt-opening", "yt-minimized");
      isMinimized = false;
      isPlaying = false;
      currentVideoId = "";
      currentVideoTitle = "";
      resumeAfterSearch = false;
      destroyApiPlayer();
      setEmbedVisible(false);
      if (ytPlaceholder) ytPlaceholder.style.display = "flex";
      if (ytSearchResults) ytSearchResults.hidden = true;
      if (ytBackBtn) ytBackBtn.style.display = "none";
      if (ytPlayerTitle) ytPlayerTitle.textContent = "YouTube";
      syncCaptureButton();
      renderTransport();
      renderRecent();
    }, 380);
  }

  function toggleMinimize() {
    if (!isMinimized && ytPlayer.classList.contains("yt-docked")) setDocked(false);
    if (!isMinimized) {
      const rect = ytPlayer.getBoundingClientRect();
      expandedSize = { width: rect.width, height: rect.height };
    }
    isMinimized = !isMinimized;
    ytPlayer.classList.toggle("yt-minimized", isMinimized);
    if (!isMinimized) {
      ytPlayer.style.width = `${expandedSize.width}px`;
      ytPlayer.style.height = `${expandedSize.height}px`;
      requestAnimationFrame(clampPlayerToViewport);
    }
    if (ytMinimize) {
      ytMinimize.title = isMinimized ? "Restore player" : "Minimize";
      ytMinimize.setAttribute("aria-label", isMinimized ? "Restore YouTube player" : "Minimize YouTube player");
    }
    saveState();
  }

  function setEmbedVisible(visible) {
    ytEmbedSlot.style.display = visible ? "block" : "none";
  }

  function pauseForSearchResults() {
    if (!apiPlayer || !playerReady) return;
    try {
      resumeAfterSearch = apiPlayer.getPlayerState() === window.YT?.PlayerState?.PLAYING;
      apiPlayer.pauseVideo();
    } catch (_) {
      resumeAfterSearch = false;
    }
  }

  function syncCaptureButton() {
    if (!ytSaveFrame) return;
    ytSaveFrame.disabled = captureInFlight || !isPlaying || !playerReady || !playbackReady || !currentVideoId;
    ytSaveFrame.classList.toggle("is-capturing", captureInFlight);
    ytSaveFrame.title = captureInFlight ? "Saving frame..." : "Save this frame to the canvas";
  }

  function ensureYouTubeApi() {
    if (window.YT?.Player) return Promise.resolve(window.YT);
    if (youtubeApiPromise) return youtubeApiPromise;

    youtubeApiPromise = new Promise((resolve, reject) => {
      const previousReady = window.onYouTubeIframeAPIReady;
      const timeout = setTimeout(() => reject(new Error("YouTube player API timed out")), 12000);
      window.onYouTubeIframeAPIReady = () => {
        clearTimeout(timeout);
        if (typeof previousReady === "function") previousReady();
        resolve(window.YT);
      };

      let script = document.getElementById("inkyscibYouTubeApi");
      if (!script) {
        script = document.createElement("script");
        script.id = "inkyscibYouTubeApi";
        script.src = "https://www.youtube.com/iframe_api";
        script.async = true;
        document.head.appendChild(script);
      }
      script.addEventListener("error", () => {
        clearTimeout(timeout);
        reject(new Error("YouTube player API failed to load"));
      }, { once: true });
    }).catch((error) => {
      youtubeApiPromise = null;
      throw error;
    });

    return youtubeApiPromise;
  }

  function updateVideoData(player) {
    try {
      const data = player.getVideoData();
      if (data?.video_id) currentVideoId = data.video_id;
      if (data?.title) currentVideoTitle = data.title;
    } catch (_) {
      // Video data becomes available shortly after onReady on some devices.
    }
  }

  function loadIntoReadyPlayer(load) {
    if (!apiPlayer || !playerReady || !load) return false;
    currentVideoId = load.videoId;
    currentVideoTitle = load.title || currentVideoTitle;
    requestedStartSeconds = load.start || 0;
    requestedStartAt = performance.now();
    playbackReady = false;
    apiPlayer.loadVideoById({ videoId: load.videoId, startSeconds: load.start || 0 });
    pendingLoad = null;
    return true;
  }

  async function bootApiPlayer() {
    if (playerBooting || apiPlayer) return;
    playerBooting = true;
    try {
      const YT = await ensureYouTubeApi();
      const initialLoad = pendingLoad;
      if (!initialLoad) {
        playerBooting = false;
        return;
      }
      pendingLoad = null;
      requestedStartSeconds = initialLoad.start || 0;
      requestedStartAt = performance.now();
      playbackReady = false;
      ensurePlayerMount();
      apiPlayer = new YT.Player("ytIframe", {
        width: "100%",
        height: "100%",
        videoId: initialLoad.videoId,
        // The no-cookie host: YouTube then sets no tracking cookie unless the
        // lecture is actually played. The API script itself still comes from
        // www.youtube.com -- there is no nocookie build of it -- but that
        // request only happens once someone opens a lecture, which is the
        // interaction the cookie policy describes. frame-src in
        // CONTENT_SECURITY_POLICY already allows this origin.
        host: "https://www.youtube-nocookie.com",
        playerVars: {
          autoplay: 1,
          start: Math.max(0, Math.floor(initialLoad.start || 0)),
          rel: 0,
          playsinline: 1,
          origin: window.location.origin
        },
        events: {
          onReady(event) {
            playerReady = true;
            playerBooting = false;
            updateVideoData(event.target);
            if (pendingLoad) {
              loadIntoReadyPlayer(pendingLoad);
            } else if (requestedStartSeconds > 0) {
              event.target.seekTo(requestedStartSeconds, true);
              event.target.playVideo();
            }
            if (ytPlayerTitle) ytPlayerTitle.textContent = "Now Playing";
            syncCaptureButton();
            applySpeed();
            startPolling();
            renderTransport();
          },
          onStateChange(event) {
            updateVideoData(event.target);
            playbackReady = [
              window.YT?.PlayerState?.ENDED,
              window.YT?.PlayerState?.PLAYING,
              window.YT?.PlayerState?.PAUSED,
              window.YT?.PlayerState?.CUED
            ].includes(event.data);
            syncCaptureButton();
            if (event.data === window.YT?.PlayerState?.PLAYING) applySpeed();
            if (event.data === window.YT?.PlayerState?.PAUSED) rememberPosition();
            renderTransport();
          },
          onError() {
            // The API object is still ready even when one particular video is
            // unavailable. Keeping it ready lets the next search result load
            // without rebuilding the whole player.
            playerReady = true;
            playbackReady = false;
            syncCaptureButton();
            showToast("YouTube could not play this video", true);
          }
        }
      });
    } catch (error) {
      console.error("YouTube player error:", error);
      playerBooting = false;
      playerReady = false;
      playbackReady = false;
      isPlaying = false;
      setEmbedVisible(false);
      if (ytPlaceholder) ytPlaceholder.style.display = "flex";
      if (ytPlayerTitle) ytPlayerTitle.textContent = "YouTube";
      syncCaptureButton();
      showToast("Could not load the YouTube player", true);
    }
  }

  // Warms the server's frame cut for a video the moment it is loaded, so the
  // first "save frame" pays only for the frame: resolving the stream is ~3s
  // and happens here, while the video is being watched, instead of after the
  // button is pressed. Measured: first capture 0.6s with this, 4.8s without.
  // Fire and forget -- a failure costs nothing, the capture tries again.
  const preparedVideos = new Set();
  function prepareFrames(videoId) {
    if (preparedVideos.has(videoId)) return;
    preparedVideos.add(videoId);
    fetch(`/api/youtube/prepare?v=${encodeURIComponent(videoId)}`)
      .then((response) => (response.ok ? response.json() : null))
      .then((body) => { if (!body?.ready) preparedVideos.delete(videoId); })
      .catch(() => preparedVideos.delete(videoId));
  }

  function loadVideo(videoId, startSeconds = 0, title = "", options = {}) {
    if (!/^[A-Za-z0-9_-]{11}$/.test(videoId)) return;
    prepareFrames(videoId);
    if (currentVideoId && currentVideoId !== videoId) rememberPosition();
    if (currentVideoId !== videoId) clearLoop(true);
    // A link without a time picks up where you stopped last time.
    let start = Math.max(0, finiteNumber(startSeconds, 0));
    let resumed = false;
    if (!start && options.resume !== false) {
      start = resumePoint(videoId);
      resumed = start > 0;
    }
    const known = libraryEntry(videoId, false);
    const load = {
      videoId,
      start,
      title: typeof title === "string" && title ? title : (known?.title || "")
    };
    if (resumed) showToast(`Picking up at ${formatVideoTime(start)} - press J to go back, or drag the bar`);

    currentVideoId = videoId;
    currentVideoTitle = load.title;
    resumeAfterSearch = false;
    requestedStartSeconds = load.start;
    requestedStartAt = performance.now();
    playbackReady = false;
    isPlaying = true;
    pendingLoad = load;
    setEmbedVisible(true);
    ytPlayer.classList.remove("yt-searching");
    // The link has been used: leave the box, so the player's keys (K, J, L,
    // B...) control the lecture instead of typing into the search field.
    if (document.activeElement === ytSearchInput) ytSearchInput.blur();
    if (ytPlaceholder) ytPlaceholder.style.display = "none";
    if (ytSearchResults) ytSearchResults.hidden = true;
    ytToggleBtn.classList.add("yt-playing");
    if (ytPlayerTitle) ytPlayerTitle.textContent = playerReady ? "Now Playing" : "Loading Video";

    if (ytBackBtn) {
      const hasResults = !!ytSearchResults?.querySelector(".yt-result-item");
      ytBackBtn.style.display = hasResults ? "flex" : "none";
    }

    if (!loadIntoReadyPlayer(load)) bootApiPlayer();
    syncCaptureButton();
    saveState();
    knownTime = load.start;
    lastRendered = "";
    marksFor = "";
    renderTransport();
    renderNotes();
    if (playerReady) applySpeed();
  }

  function handleSearch() {
    const value = ytSearchInput?.value?.trim();
    if (!value) return;
    const video = extractVideo(value);
    if (video) {
      loadVideo(video.id, video.start);
      return;
    }
    performSearch(value);
  }

  function performSearch(query) {
    if (!ytSearchResults) return;
    const requestId = ++searchRequestId;
    if (searchController) searchController.abort();
    searchController = new AbortController();
    pauseForSearchResults();

    ytSearchResults.hidden = false;
    setEmbedVisible(false);
    ytPlayer.classList.add("yt-searching");
    if (ytPlaceholder) ytPlaceholder.style.display = "none";
    if (ytBackBtn) ytBackBtn.style.display = "none";
    if (ytPlayerTitle) ytPlayerTitle.textContent = "YouTube";
    ytSearchResults.innerHTML = `
      <div class="yt-search-loading">
        <i class="fas fa-spinner fa-spin"></i>
        <span>Searching YouTube...</span>
      </div>`;

    fetch(`/api/youtube/search?q=${encodeURIComponent(query)}`, { signal: searchController.signal })
      .then((response) => {
        if (!response.ok) throw new Error(`Search failed (${response.status})`);
        const available = response.headers.get("X-Inkyscib-YouTube-Status") !== "unavailable";
        return response.json().then((payload) => ({ payload, available }));
      })
      .then(({ payload, available }) => {
        if (!available) {
          if (requestId === searchRequestId) renderSearchUnavailable(query);
          return;
        }
        const videos = Array.isArray(payload) ? payload : payload?.videos;
        if (requestId === searchRequestId) renderSearchResults(videos, query);
      })
      .catch((error) => {
        if (error.name === "AbortError" || requestId !== searchRequestId) return;
        console.error("YouTube search error:", error);
        renderSearchUnavailable(query);
      });
  }

  function renderSearchUnavailable(query) {
    if (!ytSearchResults) return;
    ytSearchResults.innerHTML = `
      <div class="yt-search-error">
        <i class="fas fa-exclamation-triangle"></i>
        <span>In-app search is temporarily unavailable</span>
        <small>Open the search on YouTube, then paste a video link above.</small>
        <button id="ytSearchExternalBtn" type="button">Search on YouTube</button>
        <button id="ytSearchRetryBtn" type="button">Retry here</button>
      </div>`;
    document.getElementById("ytSearchExternalBtn")?.addEventListener("click", () => {
      const searchUrl = `https://www.youtube.com/results?search_query=${encodeURIComponent(query)}`;
      window.open(searchUrl, "_blank", "noopener,noreferrer");
    });
    document.getElementById("ytSearchRetryBtn")?.addEventListener("click", () => performSearch(query));
  }

  function renderSearchResults(videos, query) {
    if (!ytSearchResults) return;
    if (ytBackBtn) ytBackBtn.style.display = "none";
    if (ytPlayerTitle) ytPlayerTitle.textContent = "YouTube";

    const header = `
      <div class="yt-results-header">
        <span>Search Results</span>
        <button class="yt-results-close" id="ytResultsCloseBtn" title="Back" type="button">
          <i class="fas fa-arrow-left"></i> Back
        </button>
      </div>`;

    if (!Array.isArray(videos) || videos.length === 0) {
      ytSearchResults.innerHTML = `${header}
        <div class="yt-search-empty">
          <i class="fas fa-search"></i>
          <span>No videos found for "${escapeHtml(query)}"</span>
        </div>`;
      document.getElementById("ytResultsCloseBtn")?.addEventListener("click", hideSearchResults);
      return;
    }

    ytSearchResults.innerHTML = header + videos.map((video) => `
      <button class="yt-result-item" data-video-id="${escapeHtml(video.id)}" type="button">
        <span class="yt-result-thumb">
          <img src="${escapeHtml(video.thumbnail)}" alt="" loading="lazy" />
          <span class="yt-result-duration">${escapeHtml(video.duration)}</span>
        </span>
        <span class="yt-result-info">
          <span class="yt-result-title" title="${escapeHtml(video.title)}">${escapeHtml(video.title)}</span>
          <span class="yt-result-channel">${escapeHtml(video.channel)}</span>
        </span>
      </button>`).join("");

    document.getElementById("ytResultsCloseBtn")?.addEventListener("click", hideSearchResults);
    ytSearchResults.querySelectorAll(".yt-result-item").forEach((item, index) => {
      item.addEventListener("click", () => {
        const video = videos[index];
        if (!video?.id) return;
        ytSearchInput.value = canonicalVideoUrl(video.id, 0);
        loadVideo(video.id, 0, video.title || "");
      });
    });
  }

  function hideSearchResults() {
    if (!ytSearchResults) return;
    ytSearchResults.hidden = true;
    ytPlayer.classList.remove("yt-searching");
    if (isPlaying) {
      setEmbedVisible(true);
      if (ytPlaceholder) ytPlaceholder.style.display = "none";
      if (ytPlayerTitle) ytPlayerTitle.textContent = "Now Playing";
      if (resumeAfterSearch) {
        try { apiPlayer?.playVideo(); } catch (_) { /* player is no longer available */ }
      }
      resumeAfterSearch = false;
    } else {
      setEmbedVisible(false);
      if (ytPlaceholder) ytPlaceholder.style.display = "flex";
      if (ytPlayerTitle) ytPlayerTitle.textContent = "YouTube";
    }
    if (ytBackBtn) {
      const hasResults = !!ytSearchResults.querySelector(".yt-result-item");
      ytBackBtn.style.display = isPlaying && hasResults ? "flex" : "none";
    }
  }

  function escapeHtml(value) {
    return String(value ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#039;");
  }

  // ---------- capturing a frame ----------
  //
  // The player is a cross-origin iframe, so the page can never read its pixels.
  // The server cuts the frame instead, in two grades:
  //
  //   1. The video itself: yt-dlp resolves the stream, PyAV seeks to the exact
  //      timestamp and decodes one frame. 1920x1080, the moment asked for.
  //   2. YouTube's storyboard: the preview frame nearest the time, up to
  //      320x180. Quantised to the sheet's interval, so it can be a second or
  //      two off. Only used when the video cannot be read.
  //
  // There is deliberately no third option. The thumbnail used to stand in when
  // both failed, so "save frame" saved the same picture every time.
  //
  // Frames are cut by the server now, not captured off the screen.
  //
  // What used to be here: getDisplayMedia (a full-screen-share prompt), Region
  // or Element Capture cropped to the player's iframe, and a grab off that
  // track. It could never be sharp -- the browser cannot read pixels out of a
  // cross-origin iframe, so the only thing to photograph was the player's own
  // box, and at ~420px wide YouTube serves it about 360p. A crop cannot put
  // back detail that was never painted.
  //
  // /api/youtube/frame decodes the real frame at the exact timestamp instead:
  // up to 3840x2160 in place of ~420x215, no permission prompt, nothing moving on
  // screen. It takes a couple of seconds, which is what the ribbon's progress
  // chip is for.

  async function requestFrame(videoId, videoTime) {
    let response;
    try {
      response = await fetch(
        `/api/youtube/frame?v=${encodeURIComponent(videoId)}&t=${encodeURIComponent(videoTime.toFixed(3))}`
      );
    } catch (_) {
      throw new Error("Could not reach MAETHIST to get this frame");
    }
    let body = null;
    try {
      body = await response.json();
    } catch (_) {
      body = null;
    }
    if (!response.ok || typeof body?.image !== "string" || !body.image.startsWith("data:image/")) {
      throw new Error(body?.error || "Could not get this frame");
    }
    return {
      image: body.image,
      dimensions: { width: Number(body.width) || 320, height: Number(body.height) || 180 },
      // The server reports the timestamp it actually landed on. For a decoded
      // video frame that is the one asked for; a storyboard is quantised to
      // its sheet's interval and can be a second or two off.
      frameTime: Number.isFinite(Number(body.frameTime)) ? Number(body.frameTime) : videoTime,
      source: body.source === "video" ? "video" : "storyboard"
    };
  }

  function canvasPlacement(width, height) {
    const state = window.appState;
    const metrics = typeof window.getCanvasMetrics === "function"
      ? window.getCanvasMetrics()
      : { width: window.innerWidth, height: window.innerHeight };
    const scale = Math.max(0.05, state?.transform?.scale || 1);
    const center = {
      x: (metrics.width / 2 - (state?.transform?.offsetX || 0)) / scale,
      y: (metrics.height / 2 - (state?.transform?.offsetY || 0)) / scale
    };

    let frameWidth = Math.min(width, (metrics.width / scale) * 0.62);
    if (state?.notebook?.active) {
      frameWidth = Math.min(frameWidth, (state.notebook.pageWidth || 794) * 0.78);
    }
    let frameHeight = frameWidth * (height / width);
    const maxFrameHeight = state?.notebook?.active
      ? Math.min((metrics.height / scale) * 0.72, (state.notebook.pageHeight || 1123) * 0.78)
      : (metrics.height / scale) * 0.72;
    if (frameHeight > maxFrameHeight) {
      const shrink = maxFrameHeight / frameHeight;
      frameWidth *= shrink;
      frameHeight *= shrink;
    }

    if (state?.notebook?.active) {
      const pageWidth = state.notebook.pageWidth || 794;
      const pageHeight = state.notebook.pageHeight || 1123;
      const pageGap = state.notebook.pageGap || 96;
      const stride = pageHeight + pageGap;
      const page = Math.max(0, Math.floor(Math.max(0, center.y) / stride));
      const pageTop = page * stride;
      center.x = clamp(center.x, frameWidth / 2 + 20, pageWidth - frameWidth / 2 - 20);
      center.y = clamp(center.y, pageTop + frameHeight / 2 + 20, pageTop + pageHeight - frameHeight / 2 - 20);
    }

    return {
      left: center.x - frameWidth / 2,
      top: center.y - frameHeight / 2,
      right: center.x + frameWidth / 2,
      bottom: center.y + frameHeight / 2
    };
  }

  function addFrameToCanvas(image, videoTime, frameTime, title, dimensions = { width: 16, height: 9 }, videoId = currentVideoId) {
    const state = window.appState;
    if (!state || !Array.isArray(state.paths)) throw new Error("Canvas is not ready");
    const sourceWidth = Math.max(1, Number(dimensions.width) || 16);
    const sourceHeight = Math.max(1, Number(dimensions.height) || 9);
    // The captured size used to be read for its aspect ratio and then thrown
    // away, with every frame placed at a hard-coded 360 units wide and
    // upscaled again at paint time. Place it at what was actually captured --
    // canvasPlacement still clamps to a fraction of the page, and the floor
    // keeps a low-resolution storyboard frame no smaller than it used to be.
    const placeWidth = Math.max(360, sourceWidth);
    const placement = canvasPlacement(placeWidth, placeWidth * (sourceHeight / sourceWidth));
    const path = {
      tool: "youtube-frame",
      points: [
        { x: placement.left, y: placement.top },
        { x: placement.right, y: placement.bottom }
      ],
      image,
      videoId,
      videoTitle: title || "YouTube video",
      videoTime: Math.max(0, Number(videoTime) || 0),
      frameTime: Math.max(0, Number(frameTime) || 0),
      aspectRatio: sourceWidth / sourceHeight,
      timestamp: Date.now()
    };

    if (typeof window.commitHistory === "function") window.commitHistory();
    state.paths.push(path);
    const index = state.paths.length - 1;
    if (typeof window.setTool === "function") window.setTool("select");
    window.Inkyscib?.Selection?.selectIndex?.(index);
    if (typeof window.render === "function") window.render();
    if (typeof window.saveDrawing === "function") window.saveDrawing();
    return path;
  }

  async function saveCurrentFrame() {
    if (captureInFlight || !apiPlayer || !playerReady || !currentVideoId) return;
    let videoTime = 0;
    try {
      videoTime = Math.max(0, Number(apiPlayer.getCurrentTime()) || 0);
      if (
        videoTime < 0.5 &&
        requestedStartSeconds > 0.5 &&
        performance.now() - requestedStartAt < 8000
      ) {
        videoTime = requestedStartSeconds;
      }
      updateVideoData(apiPlayer);
    } catch (_) {
      showToast("The video is not ready yet", true);
      return;
    }

    captureInFlight = true;
    syncCaptureButton();
    // The exact moment the button was pressed. Reading it once, here, is what
    // makes the saved frame the frame that was on screen: the video keeps
    // playing while the server works.
    const captureVideoId = currentVideoId;
    const captureVideoTitle = currentVideoTitle;
    shutter();
    const progress = window.Inkyscib?.RibbonProgress?.start?.("Importing YT frame");

    try {
      const captured = await requestFrame(captureVideoId, videoTime);
      if (typeof captured.image !== "string" || captured.image.length > MAX_FRAME_DATA_URL) {
        throw new Error("The captured frame is too large to store");
      }
      addFrameToCanvas(
        captured.image,
        videoTime,
        captured.frameTime ?? videoTime,
        captureVideoTitle,
        captured.dimensions,
        captureVideoId
      );
      progress?.done?.();
      const at = formatVideoTime(videoTime);
      showToast(
        captured.source === "video"
          ? `Frame saved at ${at} - double-tap it to reopen`
          : `Saved YouTube's preview frame near ${at} - double-tap it to reopen`
      );
    } catch (error) {
      progress?.fail?.();
      console.error("YouTube frame capture error:", error);
      showToast(error.message || "Could not save this frame", true);
    } finally {
      captureInFlight = false;
      syncCaptureButton();
    }
  }

  // The click is answered on the same frame it lands: a brief shutter over
  // the video, so pressing the button never feels like nothing happened even
  // before the frame arrives. Restarted on each press, and gone for anyone who
  // asked the system for less motion (the CSS handles that).
  function shutter() {
    const slot = ytEmbedSlot?.parentElement || ytPlayer;
    if (!slot) return;
    slot.classList.remove("yt-shutter");
    // Reading layout here restarts the animation when presses come quickly.
    void slot.offsetWidth;
    slot.classList.add("yt-shutter");
    window.setTimeout(() => slot.classList.remove("yt-shutter"), 400);
  }

  function openFrame(path) {
    if (!path || path.tool !== "youtube-frame" || !/^[A-Za-z0-9_-]{11}$/.test(path.videoId || "")) return;
    if (!isOpen) openPlayer({ focus: false });
    if (isMinimized) toggleMinimize();
    const time = Math.max(0, Number(path.videoTime) || 0);
    if (ytSearchInput) ytSearchInput.value = canonicalVideoUrl(path.videoId, time);
    loadVideo(path.videoId, time, path.videoTitle || "", { resume: false });
    showToast(`Opening video at ${formatVideoTime(time)}`);
  }

  function showToast(message, isError = false) {
    let host = document.getElementById("ytFrameToastHost");
    if (!host) {
      host = document.createElement("div");
      host.id = "ytFrameToastHost";
      host.className = "yt-frame-toast-host";
      document.body.appendChild(host);
    }
    const toast = document.createElement("div");
    toast.className = `yt-frame-toast${isError ? " is-error" : ""}`;
    toast.innerHTML = `<i class="fas ${isError ? "fa-exclamation-circle" : "fa-check-circle"}"></i><span></span>`;
    toast.querySelector("span").textContent = message;
    host.appendChild(toast);
    setTimeout(() => {
      toast.classList.add("is-leaving");
      setTimeout(() => toast.remove(), 220);
    }, isError ? 4200 : 3000);
  }

  function eventClientPoint(event) {
    const touch = event.touches?.[0] || event.changedTouches?.[0];
    return {
      x: touch ? touch.clientX : event.clientX,
      y: touch ? touch.clientY : event.clientY
    };
  }

  function startDrag(event) {
    if (isMinimized) return;
    event.preventDefault();
    if (ytPlayer.classList.contains("yt-docked")) {
      ytPlayer.classList.remove("yt-docked");
      ytDock?.setAttribute("aria-pressed", "false");
    }
    const point = eventClientPoint(event);
    const rect = ytPlayer.getBoundingClientRect();
    ytPlayer.style.left = `${rect.left}px`;
    ytPlayer.style.top = `${rect.top}px`;
    ytPlayer.style.right = "auto";
    dragState = {
      ox: point.x - rect.left,
      oy: point.y - rect.top,
      width: rect.width,
      height: rect.height
    };
    pendingDragPoint = point;
    ytPlayer.classList.add("yt-dragging");
    document.addEventListener("mousemove", onDrag);
    document.addEventListener("mouseup", endDrag);
    document.addEventListener("touchmove", onDrag, { passive: false });
    document.addEventListener("touchend", endDrag);
  }

  function onDrag(event) {
    if (!dragState) return;
    event.preventDefault();
    pendingDragPoint = eventClientPoint(event);
    if (dragFrame === null) dragFrame = requestAnimationFrame(applyDrag);
  }

  function applyDrag() {
    dragFrame = null;
    if (!dragState || !pendingDragPoint) return;
    ytPlayer.style.left = `${clamp(pendingDragPoint.x - dragState.ox, 0, Math.max(0, window.innerWidth - dragState.width))}px`;
    // Not above the chrome: dragged under the ribbon, the title bar -- the
    // only thing you can drag it back by -- would be out of reach.
    const topFloor = minPlayerTop(dragState.height);
    ytPlayer.style.top = `${clamp(pendingDragPoint.y - dragState.oy, topFloor, Math.max(topFloor, window.innerHeight - dragState.height))}px`;
  }

  function endDrag() {
    if (!dragState) return;
    if (dragFrame !== null) cancelAnimationFrame(dragFrame);
    applyDrag();
    dragState = null;
    pendingDragPoint = null;
    ytPlayer.classList.remove("yt-dragging");
    document.removeEventListener("mousemove", onDrag);
    document.removeEventListener("mouseup", endDrag);
    document.removeEventListener("touchmove", onDrag);
    document.removeEventListener("touchend", endDrag);
    saveState();
  }

  function startResize(event) {
    if (isMinimized) return;
    if (event.button !== undefined && event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    const point = eventClientPoint(event);
    const rect = ytPlayer.getBoundingClientRect();
    resizeState = {
      direction: event.currentTarget?.dataset?.ytResize || "se",
      pointerId: event.pointerId,
      sx: point.x,
      sy: point.y,
      left: rect.left,
      top: rect.top,
      right: rect.right,
      bottom: rect.bottom
    };
    pendingResizePoint = point;
    ytPlayer.classList.add("yt-resizing");
    document.addEventListener("pointermove", onResize, { passive: false });
    document.addEventListener("pointerup", endResize);
    document.addEventListener("pointercancel", endResize);
  }

  function applyResize() {
    resizeFrame = null;
    if (!resizeState || !pendingResizePoint) return;

    const point = pendingResizePoint;
    const direction = resizeState.direction;
    const dx = point.x - resizeState.sx;
    const dy = point.y - resizeState.sy;
    const margin = 8;
    const minWidth = Math.min(MIN_SIZE.width, Math.max(1, window.innerWidth - margin * 2));
    const minHeight = Math.min(MIN_SIZE.height, Math.max(1, window.innerHeight - margin * 2));
    let left = resizeState.left;
    let right = resizeState.right;
    let top = resizeState.top;
    let bottom = resizeState.bottom;

    if (direction.includes("e")) {
      right = clamp(resizeState.right + dx, resizeState.left + minWidth, window.innerWidth - margin);
    }
    if (direction.includes("w")) {
      left = clamp(resizeState.left + dx, margin, resizeState.right - minWidth);
    }
    if (direction.includes("s")) {
      bottom = clamp(resizeState.bottom + dy, resizeState.top + minHeight, window.innerHeight - margin);
    }
    if (direction.includes("n")) {
      // The top edge stops at the chrome, like the drag does.
      const ceiling = Math.min(chromeFloor() + margin, resizeState.bottom - minHeight);
      top = clamp(resizeState.top + dy, ceiling, resizeState.bottom - minHeight);
    }

    const width = Math.max(1, right - left);
    const height = Math.max(1, bottom - top);
    ytPlayer.style.left = `${left}px`;
    ytPlayer.style.top = `${top}px`;
    ytPlayer.style.right = "auto";
    ytPlayer.style.width = `${width}px`;
    ytPlayer.style.height = `${height}px`;
    expandedSize = { width, height };
  }

  function onResize(event) {
    if (!resizeState || (resizeState.pointerId !== undefined && event.pointerId !== resizeState.pointerId)) return;
    event.preventDefault();
    pendingResizePoint = eventClientPoint(event);
    if (resizeFrame === null) resizeFrame = requestAnimationFrame(applyResize);
  }

  function endResize(event) {
    if (!resizeState || (event?.pointerId !== undefined && resizeState.pointerId !== undefined && event.pointerId !== resizeState.pointerId)) return;
    if (resizeFrame !== null) cancelAnimationFrame(resizeFrame);
    applyResize();
    resizeState = null;
    pendingResizePoint = null;
    ytPlayer.classList.remove("yt-resizing");
    document.removeEventListener("pointermove", onResize);
    document.removeEventListener("pointerup", endResize);
    document.removeEventListener("pointercancel", endResize);
    saveState();
  }


  // =====================================================================
  // Lecture tools
  // =====================================================================
  //
  // The embed's own controls are built for watching, and at the ~420px this
  // player usually is, YouTube hides most of them. A lecture is not watched,
  // it is studied: you go back ten seconds to catch a step, slow down a
  // derivation, loop the part you did not follow, mark the moment the
  // examiner's favourite trick appears, and come back tomorrow to where you
  // stopped. All of that is here, kept on this device under
  // "inkyscib-yt-library-v1" and never sent anywhere.

  const ytTransport = document.getElementById("ytTransport");
  const ytScrub = document.getElementById("ytScrub");
  const ytScrubFill = document.getElementById("ytScrubFill");
  const ytScrubLoop = document.getElementById("ytScrubLoop");
  const ytScrubMarks = document.getElementById("ytScrubMarks");
  const ytPlayPause = document.getElementById("ytPlayPause");
  const ytBack10 = document.getElementById("ytBack10");
  const ytFwd10 = document.getElementById("ytFwd10");
  const ytTime = document.getElementById("ytTime");
  const ytSpeed = document.getElementById("ytSpeed");
  const ytLoop = document.getElementById("ytLoop");
  const ytBookmark = document.getElementById("ytBookmark");
  const ytNotesToggle = document.getElementById("ytNotesToggle");
  const ytNotesCount = document.getElementById("ytNotesCount");
  const ytNotes = document.getElementById("ytNotes");
  const ytNoteCompose = document.getElementById("ytNoteCompose");
  const ytNoteAt = document.getElementById("ytNoteAt");
  const ytNoteInput = document.getElementById("ytNoteInput");
  const ytNoteList = document.getElementById("ytNoteList");
  const ytNotesEmpty = document.getElementById("ytNotesEmpty");
  const ytNotesCopy = document.getElementById("ytNotesCopy");
  const ytPauseOnType = document.getElementById("ytPauseOnType");
  const ytRecent = document.getElementById("ytRecent");
  const ytRecentList = document.getElementById("ytRecentList");
  const ytDock = document.getElementById("ytDock");

  const LIBRARY_KEY = "inkyscib-yt-library-v1";
  const LIBRARY_LIMIT = 40;
  const SPEEDS = [0.5, 0.75, 1, 1.25, 1.5, 1.75, 2];
  // Resume only past the opening, and not in the last stretch: coming back
  // to the closing credits of something you finished is not "resuming".
  const RESUME_FROM = 20;
  const RESUME_TAIL = 25;

  function loadLibrary() {
    try {
      const saved = JSON.parse(localStorage.getItem(LIBRARY_KEY));
      if (saved && typeof saved === "object" && saved.videos && typeof saved.videos === "object") {
        return {
          speed: SPEEDS.includes(saved.speed) ? saved.speed : 1,
          pauseOnType: saved.pauseOnType !== false,
          videos: saved.videos
        };
      }
    } catch (_) {
      // Unreadable storage starts an empty library.
    }
    return { speed: 1, pauseOnType: true, videos: {} };
  }

  let library = loadLibrary();

  function saveLibrary() {
    const ids = Object.keys(library.videos);
    if (ids.length > LIBRARY_LIMIT) {
      // The oldest go first, but never a lecture with notes in it.
      ids
        .sort((a, b) => (library.videos[b].updatedAt || 0) - (library.videos[a].updatedAt || 0))
        .slice(LIBRARY_LIMIT)
        .forEach((id) => {
          if (!(library.videos[id].notes || []).length) delete library.videos[id];
        });
    }
    try {
      localStorage.setItem(LIBRARY_KEY, JSON.stringify(library));
    } catch (_) {
      // Storage full or blocked: the controls still work for this visit.
    }
  }

  function libraryEntry(videoId, create) {
    if (!/^[A-Za-z0-9_-]{11}$/.test(videoId || "")) return null;
    let entry = library.videos[videoId];
    if (!entry && create) {
      entry = library.videos[videoId] = { title: "", duration: 0, position: 0, updatedAt: Date.now(), notes: [] };
    }
    if (entry && !Array.isArray(entry.notes)) entry.notes = [];
    return entry || null;
  }

  // ---------- the player, read safely ----------

  let knownTime = 0;
  let seekHoldUntil = 0;

  function hasVideo() {
    return !!(apiPlayer && playerReady && currentVideoId);
  }

  function playerTime() {
    if (!apiPlayer) return 0;
    // Just after a seek the embed can still report the old time for a frame
    // or two; trust the seek until it catches up.
    if (performance.now() < seekHoldUntil) return knownTime;
    try {
      knownTime = Math.max(0, Number(apiPlayer.getCurrentTime()) || 0);
    } catch (_) {
      // Not ready: keep the last known time.
    }
    return knownTime;
  }

  function playerDuration() {
    try {
      return Math.max(0, Number(apiPlayer?.getDuration?.()) || 0);
    } catch (_) {
      return 0;
    }
  }

  function playerPlaying() {
    try {
      return apiPlayer?.getPlayerState?.() === window.YT?.PlayerState?.PLAYING;
    } catch (_) {
      return false;
    }
  }

  function seekTo(seconds) {
    if (!hasVideo()) return;
    const duration = playerDuration();
    const target = clamp(Number(seconds) || 0, 0, duration > 1 ? duration - 0.25 : Math.max(0, Number(seconds) || 0));
    try {
      apiPlayer.seekTo(target, true);
    } catch (_) {
      return;
    }
    knownTime = target;
    seekHoldUntil = performance.now() + 700;
    renderTransport();
  }

  function seekBy(delta) {
    seekTo(playerTime() + delta);
  }

  function togglePlay() {
    if (!hasVideo()) return;
    try {
      if (playerPlaying()) apiPlayer.pauseVideo();
      else apiPlayer.playVideo();
    } catch (_) {
      return;
    }
    window.setTimeout(renderTransport, 60);
  }

  // ---------- speed ----------

  function applySpeed() {
    try {
      apiPlayer?.setPlaybackRate?.(library.speed);
    } catch (_) {
      // Some videos only offer 1x; the button still shows what was asked.
    }
    if (ytSpeed) ytSpeed.textContent = `${library.speed}\u00d7`;
    ytSpeed?.classList.toggle("is-changed", library.speed !== 1);
  }

  function setSpeed(next) {
    library.speed = SPEEDS.includes(next) ? next : 1;
    applySpeed();
    saveLibrary();
  }

  function stepSpeed(direction) {
    const index = SPEEDS.indexOf(library.speed);
    setSpeed(SPEEDS[clamp((index < 0 ? 2 : index) + direction, 0, SPEEDS.length - 1)]);
    showToast(`Speed ${library.speed}\u00d7`);
  }

  // ---------- A-B loop ----------

  let loopRange = { a: null, b: null };

  function clearLoop(quiet) {
    const had = loopRange.a !== null;
    loopRange = { a: null, b: null };
    renderTransport();
    if (had && !quiet) showToast("Loop off");
  }

  function toggleLoop() {
    if (!hasVideo()) return;
    const t = playerTime();
    if (loopRange.a === null) {
      loopRange.a = t;
      showToast(`Loop from ${formatVideoTime(t)} - press again at the end`);
    } else if (loopRange.b === null) {
      if (t < loopRange.a + 1) {
        showToast("Play on past the start, then set the end", true);
        return;
      }
      loopRange.b = t;
      showToast(`Looping ${formatVideoTime(loopRange.a)} to ${formatVideoTime(loopRange.b)}`);
      seekTo(loopRange.a);
    } else {
      clearLoop();
      return;
    }
    renderTransport();
  }

  // ---------- notes and bookmarks ----------

  let noteTime = null;

  function currentNotes() {
    return libraryEntry(currentVideoId, false)?.notes || [];
  }

  function addNote(text, at) {
    if (!currentVideoId) return null;
    const entry = libraryEntry(currentVideoId, true);
    if (currentVideoTitle) entry.title = currentVideoTitle;
    const note = {
      t: Math.round(Math.max(0, Number(at ?? playerTime()) || 0) * 10) / 10,
      text: String(text || "").trim().slice(0, 500),
      at: Date.now()
    };
    entry.notes.push(note);
    entry.notes.sort((x, y) => x.t - y.t);
    entry.updatedAt = Date.now();
    saveLibrary();
    renderNotes();
    renderMarks();
    return note;
  }

  function bookmark() {
    if (!hasVideo()) return;
    const note = addNote("");
    if (note) showToast(`Bookmarked ${formatVideoTime(note.t)} - add a note in Lecture notes`);
  }

  function removeNote(index) {
    const entry = libraryEntry(currentVideoId, false);
    if (!entry || !entry.notes[index]) return;
    entry.notes.splice(index, 1);
    entry.updatedAt = Date.now();
    saveLibrary();
    renderNotes();
    renderMarks();
  }

  function notesAsText() {
    const entry = libraryEntry(currentVideoId, false);
    if (!entry) return "";
    const lines = [entry.title || currentVideoTitle || "YouTube lecture", canonicalVideoUrl(currentVideoId, 0), ""];
    entry.notes.forEach((note) => {
      lines.push(`${formatVideoTime(note.t)}  ${note.text || "(bookmark)"}  ${canonicalVideoUrl(currentVideoId, note.t)}`);
    });
    return lines.join("\n");
  }

  async function copyNotes() {
    if (!currentNotes().length) {
      showToast("No notes to copy yet", true);
      return;
    }
    try {
      await navigator.clipboard.writeText(notesAsText());
      showToast("Notes copied, each with a link to its moment");
    } catch (_) {
      showToast("The browser would not allow copying here", true);
    }
  }

  function setNotesOpen(open) {
    if (!ytNotes) return;
    const next = !!open && !!currentVideoId;
    ytNotes.hidden = !next;
    ytPlayer.classList.toggle("yt-notes-open", next);
    ytNotesToggle?.setAttribute("aria-expanded", String(next));
    ytNotesToggle?.classList.toggle("is-on", next);
    if (next) {
      // Room for the notes without squeezing the video to a strip: the
      // picture keeps 16:9 at the player's width, and the notes get ~200px.
      const rect = ytPlayer.getBoundingClientRect();
      const chrome = rect.height - (document.getElementById("ytVideoContainer")?.getBoundingClientRect().height || 0);
      const wanted = Math.round(rect.width * 9 / 16 + chrome + 210);
      if (!isMinimized && rect.height < wanted && !ytPlayer.classList.contains("yt-docked")) {
        const size = viewportPlayerSize(rect.width, wanted);
        // Grow downward, and move up only as far as the screen needs.
        const top = clamp(rect.top, minPlayerTop(size.height), Math.max(8, window.innerHeight - size.height - 8));
        setPlayerBox({ top, width: rect.width, height: size.height });
      }
      renderNotes();
    }
  }

  function renderNotes() {
    if (!ytNoteList) return;
    const notes = currentNotes();
    if (ytNotesCount) {
      ytNotesCount.hidden = notes.length === 0;
      ytNotesCount.textContent = String(notes.length);
    }
    if (ytNotesEmpty) ytNotesEmpty.hidden = notes.length > 0;
    if (ytNotes?.hidden) return;
    ytNoteList.innerHTML = notes.map((note, index) => `
      <li class="yt-note" data-index="${index}">
        <button class="yt-note-time" type="button" data-seek="${note.t}" title="Jump to ${formatVideoTime(note.t)}">${formatVideoTime(note.t)}</button>
        <input class="yt-note-text" type="text" maxlength="500" value="${escapeHtml(note.text)}" placeholder="Bookmark - add a note" aria-label="Note at ${formatVideoTime(note.t)}">
        <button class="yt-note-del" type="button" aria-label="Delete the note at ${formatVideoTime(note.t)}" title="Delete">${iconMarkup("lucide:trash")}</button>
      </li>`).join("");
  }

  function iconMarkup(ref) {
    try {
      return window.Inkyscib?.Icon?.svg?.(ref) || "";
    } catch (_) {
      return "";
    }
  }

  function renderMarks() {
    if (!ytScrubMarks) return;
    const duration = playerDuration();
    if (!duration) {
      ytScrubMarks.innerHTML = "";
      return;
    }
    ytScrubMarks.innerHTML = currentNotes()
      .map((note) => `<i style="left:${clamp((note.t / duration) * 100, 0, 100).toFixed(3)}%"></i>`)
      .join("");
  }

  // ---------- the transport ----------

  let lastRendered = "";

  function renderTransport() {
    if (!ytTransport) return;
    const show = isOpen && !!currentVideoId && isPlaying;
    ytTransport.hidden = !show;
    ytPlayer.classList.toggle("yt-has-video", show);
    if (!show) return;
    const t = playerTime();
    const duration = playerDuration();
    const fraction = duration ? clamp(t / duration, 0, 1) : 0;
    const playing = playerPlaying();
    ytPlayPause?.classList.toggle("is-playing", playing);
    ytPlayPause?.setAttribute("aria-label", playing ? "Pause" : "Play");
    const label = `${formatVideoTime(t)} / ${formatVideoTime(duration)}`;
    if (label !== lastRendered) {
      lastRendered = label;
      if (ytTime) ytTime.textContent = label;
      if (ytScrub) {
        ytScrub.setAttribute("aria-valuemax", String(Math.round(duration)));
        ytScrub.setAttribute("aria-valuenow", String(Math.round(t)));
        ytScrub.setAttribute("aria-valuetext", formatVideoTime(t));
      }
    }
    if (ytScrubFill) ytScrubFill.style.transform = `scaleX(${fraction.toFixed(4)})`;
    if (ytNoteAt && document.activeElement !== ytNoteInput) ytNoteAt.textContent = formatVideoTime(t);
    if (ytLoop) {
      const armed = loopRange.a !== null && loopRange.b === null;
      const on = loopRange.b !== null;
      ytLoop.classList.toggle("is-armed", armed);
      ytLoop.classList.toggle("is-on", on);
      ytLoop.setAttribute("aria-pressed", String(armed || on));
      ytLoop.title = on
        ? `Looping ${formatVideoTime(loopRange.a)} to ${formatVideoTime(loopRange.b)} - press to stop (A)`
        : armed ? "Press at the end of the section (A)" : "Loop a section (A)";
    }
    if (ytScrubLoop) {
      const on = loopRange.a !== null && duration > 0;
      ytScrubLoop.hidden = !on;
      if (on) {
        const end = loopRange.b ?? t;
        ytScrubLoop.style.left = `${(clamp(loopRange.a / duration, 0, 1) * 100).toFixed(3)}%`;
        ytScrubLoop.style.width = `${(clamp((end - loopRange.a) / duration, 0, 1) * 100).toFixed(3)}%`;
      }
    }
  }

  // ---------- remembering where you were ----------

  let lastRemembered = 0;
  let pollTimer = null;
  let marksFor = "";

  function rememberPosition() {
    if (!hasVideo()) return;
    const t = playerTime();
    const duration = playerDuration();
    if (t < 1 && !duration) return;
    lastRemembered = Date.now();
    const entry = libraryEntry(currentVideoId, true);
    entry.position = t;
    if (duration) entry.duration = duration;
    if (currentVideoTitle) entry.title = currentVideoTitle;
    entry.updatedAt = Date.now();
    saveLibrary();
  }

  function poll() {
    if (!isOpen || !hasVideo()) return;
    if (loopRange.b !== null && playerPlaying() && playerTime() >= loopRange.b) seekTo(loopRange.a);
    renderTransport();
    const durationKey = currentVideoId + ":" + Math.round(playerDuration());
    if (durationKey !== marksFor) {
      marksFor = durationKey;
      renderMarks();
    }
    if (Date.now() - lastRemembered > 5000 && playerPlaying()) rememberPosition();
  }

  function startPolling() {
    if (pollTimer) return;
    pollTimer = window.setInterval(poll, 250);
  }

  function stopPolling() {
    if (pollTimer) window.clearInterval(pollTimer);
    pollTimer = null;
  }

  function resumePoint(videoId) {
    const entry = libraryEntry(videoId, false);
    if (!entry) return 0;
    const position = Number(entry.position) || 0;
    const duration = Number(entry.duration) || 0;
    if (position < RESUME_FROM) return 0;
    if (duration && position > duration - RESUME_TAIL) return 0;
    return position;
  }

  function renderRecent() {
    if (!ytRecent || !ytRecentList) return;
    const items = Object.entries(library.videos)
      .filter(([id, entry]) => id !== currentVideoId && (entry.position > 5 || (entry.notes || []).length))
      .sort((a, b) => (b[1].updatedAt || 0) - (a[1].updatedAt || 0))
      .slice(0, 4);
    ytRecent.hidden = items.length === 0;
    // No thumbnails: a picture from YouTube would be a request to YouTube
    // before anyone pressed play. The progress bar says enough.
    ytRecentList.innerHTML = items.map(([id, entry]) => {
      const duration = Number(entry.duration) || 0;
      const fraction = duration ? clamp(entry.position / duration, 0, 1) : 0;
      const notes = (entry.notes || []).length;
      const meta = [
        duration ? `${formatVideoTime(entry.position)} of ${formatVideoTime(duration)}` : formatVideoTime(entry.position),
        notes ? `${notes} note${notes === 1 ? "" : "s"}` : ""
      ].filter(Boolean).join(" \u00b7 ");
      return `
        <li class="yt-recent-item">
          <button class="yt-recent-open" type="button" data-video-id="${escapeHtml(id)}">
            <span class="yt-recent-title">${escapeHtml(entry.title || "YouTube video")}</span>
            <span class="yt-recent-meta">${escapeHtml(meta)}</span>
            <span class="yt-recent-bar" aria-hidden="true"><span style="transform:scaleX(${fraction.toFixed(4)})"></span></span>
          </button>
          <button class="yt-recent-forget" type="button" data-forget="${escapeHtml(id)}" aria-label="Remove from Continue watching" title="Remove">${iconMarkup("lucide:x")}</button>
        </li>`;
    }).join("");
  }

  // Sizes the player at once. The player animates its height in CSS, and
  // clampPlayerToViewport, run on the next frame, reads the half-animated
  // height back and writes it as the new size: growing for the notes or
  // leaving the dock ended at whatever height the animation had reached.
  function setPlayerBox(box) {
    const previous = ytPlayer.style.transition;
    ytPlayer.style.transition = "none";
    if (box.left !== undefined) ytPlayer.style.left = `${box.left}px`;
    if (box.top !== undefined) ytPlayer.style.top = `${box.top}px`;
    if (box.width !== undefined) ytPlayer.style.width = `${box.width}px`;
    if (box.height !== undefined) ytPlayer.style.height = `${box.height}px`;
    ytPlayer.style.right = "auto";
    void ytPlayer.offsetHeight;
    ytPlayer.style.transition = previous;
    if (box.width !== undefined && box.height !== undefined) expandedSize = { width: box.width, height: box.height };
  }

  // ---------- docking beside the canvas ----------

  let floatRect = null;

  function placeDocked() {
    const top = minPlayerTop(400);
    const width = clamp(Math.round(window.innerWidth * 0.34), 320, 640);
    const height = Math.max(260, window.innerHeight - top - 44);
    setPlayerBox({ left: Math.max(8, window.innerWidth - width - 8), top, width, height });
  }

  function setDocked(docked) {
    const next = !!docked && !isMinimized;
    if (next === ytPlayer.classList.contains("yt-docked")) return;
    if (next) {
      const rect = ytPlayer.getBoundingClientRect();
      floatRect = { left: rect.left, top: rect.top, width: rect.width, height: rect.height };
      ytPlayer.classList.add("yt-docked");
      placeDocked();
    } else {
      ytPlayer.classList.remove("yt-docked");
      if (floatRect) setPlayerBox(floatRect);
      clampPlayerToViewport();
    }
    ytDock?.setAttribute("aria-pressed", String(next));
    if (ytDock) ytDock.title = next ? "Float the player again" : "Dock beside the canvas";
    saveState();
  }

  // ---------- keyboard ----------
  //
  // Only while the pointer is over the player, or focus is inside it, so the
  // canvas keeps every key it owns the rest of the time. Once the video
  // itself is clicked the keys go to YouTube's own iframe, which has its own
  // shortcuts for the same things.

  let pointerInside = false;
  ytPlayer.addEventListener("pointerenter", () => { pointerInside = true; });
  ytPlayer.addEventListener("pointerleave", () => { pointerInside = false; });

  function typingTarget(target) {
    return !!target && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName || ""));
  }

  document.addEventListener("keydown", (event) => {
    if (!isOpen || isMinimized || !hasVideo()) return;
    if (event.ctrlKey || event.metaKey || event.altKey) return;
    if (!pointerInside && !ytPlayer.contains(document.activeElement)) return;
    if (typingTarget(event.target)) return;
    const key = event.key.length === 1 ? event.key.toLowerCase() : event.key;
    const actions = {
      k: togglePlay,
      " ": togglePlay,
      j: () => seekBy(-10),
      l: () => seekBy(10),
      ArrowLeft: () => seekBy(-5),
      ArrowRight: () => seekBy(5),
      b: bookmark,
      a: toggleLoop,
      s: saveCurrentFrame,
      "[": () => stepSpeed(-1),
      "]": () => stepSpeed(1),
      n: () => {
        setNotesOpen(true);
        ytNoteInput?.focus();
      }
    };
    const action = actions[key];
    if (!action) return;
    event.preventDefault();
    event.stopPropagation();
    action();
  }, true);

  // ---------- wiring ----------

  ytPlayPause?.addEventListener("click", togglePlay);
  ytBack10?.addEventListener("click", () => seekBy(-10));
  ytFwd10?.addEventListener("click", () => seekBy(10));
  ytSpeed?.addEventListener("click", () => {
    const index = SPEEDS.indexOf(library.speed);
    setSpeed(SPEEDS[(index + 1) % SPEEDS.length]);
  });
  ytLoop?.addEventListener("click", toggleLoop);
  ytBookmark?.addEventListener("click", bookmark);
  ytNotesToggle?.addEventListener("click", () => setNotesOpen(ytNotes?.hidden));
  ytNotesCopy?.addEventListener("click", copyNotes);
  ytDock?.addEventListener("click", () => setDocked(!ytPlayer.classList.contains("yt-docked")));

  if (ytPauseOnType) {
    ytPauseOnType.checked = library.pauseOnType;
    ytPauseOnType.addEventListener("change", () => {
      library.pauseOnType = ytPauseOnType.checked;
      saveLibrary();
    });
  }

  // The note is for the moment you started typing it, not the moment you
  // finished: by then the lecturer has moved on.
  let resumeAfterNote = false;
  ytNoteInput?.addEventListener("focus", () => {
    noteTime = playerTime();
    if (ytNoteAt) ytNoteAt.textContent = formatVideoTime(noteTime);
    resumeAfterNote = false;
    if (library.pauseOnType && playerPlaying()) {
      try {
        apiPlayer.pauseVideo();
        resumeAfterNote = true;
      } catch (_) { /* not ready */ }
    }
  });
  ytNoteInput?.addEventListener("blur", () => {
    noteTime = null;
    if (resumeAfterNote) {
      try { apiPlayer?.playVideo(); } catch (_) { /* gone */ }
    }
    resumeAfterNote = false;
  });
  ytNoteAt?.addEventListener("click", () => {
    if (noteTime !== null) seekTo(noteTime);
  });
  ytNoteCompose?.addEventListener("submit", (event) => {
    event.preventDefault();
    const text = ytNoteInput.value.trim();
    if (!text) return;
    addNote(text, noteTime ?? playerTime());
    ytNoteInput.value = "";
    noteTime = playerTime();
  });

  ytNoteList?.addEventListener("click", (event) => {
    const seek = event.target.closest("[data-seek]");
    if (seek) {
      seekTo(Number(seek.dataset.seek));
      return;
    }
    const del = event.target.closest(".yt-note-del");
    if (del) removeNote(Number(del.closest(".yt-note")?.dataset.index));
  });
  ytNoteList?.addEventListener("change", (event) => {
    const input = event.target.closest(".yt-note-text");
    if (!input) return;
    const entry = libraryEntry(currentVideoId, false);
    const note = entry?.notes[Number(input.closest(".yt-note")?.dataset.index)];
    if (!note) return;
    note.text = input.value.trim().slice(0, 500);
    entry.updatedAt = Date.now();
    saveLibrary();
  });

  // Typing in the notes must never reach the canvas's single-key shortcuts.
  ytNotes?.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      event.target.blur?.();
      event.stopPropagation();
      return;
    }
    if (typingTarget(event.target)) event.stopPropagation();
  });
  ["keyup", "keypress"].forEach((type) => {
    ytNotes?.addEventListener(type, (event) => {
      if (typingTarget(event.target)) event.stopPropagation();
    });
  });

  ytRecentList?.addEventListener("click", (event) => {
    const forget = event.target.closest("[data-forget]");
    if (forget) {
      const entry = library.videos[forget.dataset.forget];
      if (entry) {
        // Notes are kept: forgetting the place is not deleting the work.
        if ((entry.notes || []).length) entry.position = 0;
        else delete library.videos[forget.dataset.forget];
        saveLibrary();
      }
      renderRecent();
      return;
    }
    const open = event.target.closest("[data-video-id]");
    if (!open) return;
    const id = open.dataset.videoId;
    const entry = libraryEntry(id, false);
    if (ytSearchInput) ytSearchInput.value = canonicalVideoUrl(id, 0);
    loadVideo(id, 0, entry?.title || "");
  });

  // Scrubbing: tap or drag along the bar, arrows for five seconds.
  let scrubbing = false;
  function scrubTo(event) {
    const rect = ytScrub.getBoundingClientRect();
    const fraction = clamp((event.clientX - rect.left) / Math.max(1, rect.width), 0, 1);
    seekTo(fraction * playerDuration());
  }
  ytScrub?.addEventListener("pointerdown", (event) => {
    if (!hasVideo() || !playerDuration()) return;
    scrubbing = true;
    ytScrub.setPointerCapture?.(event.pointerId);
    ytScrub.classList.add("is-scrubbing");
    scrubTo(event);
  });
  ytScrub?.addEventListener("pointermove", (event) => {
    if (scrubbing) scrubTo(event);
  });
  ["pointerup", "pointercancel"].forEach((type) => ytScrub?.addEventListener(type, () => {
    scrubbing = false;
    ytScrub.classList.remove("is-scrubbing");
  }));
  ytScrub?.addEventListener("keydown", (event) => {
    if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
      event.preventDefault();
      event.stopPropagation();
      seekBy(event.key === "ArrowLeft" ? -5 : 5);
    }
  });

  window.addEventListener("resize", () => {
    if (isOpen && ytPlayer.classList.contains("yt-docked")) requestAnimationFrame(placeDocked);
  });
  window.addEventListener("pagehide", rememberPosition);
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) rememberPosition();
  });

  applySpeed();

  ytToggleBtn.addEventListener("click", () => isOpen ? closePlayer() : openPlayer());
  ytClose?.addEventListener("click", closePlayer);
  ytMinimize?.addEventListener("click", toggleMinimize);
  ytSaveFrame?.addEventListener("click", saveCurrentFrame);
  ytSearchBtn?.addEventListener("click", handleSearch);

  ytBackBtn?.addEventListener("click", () => {
    if (!ytSearchResults) return;
    pauseForSearchResults();
    ytSearchResults.hidden = false;
    setEmbedVisible(false);
    if (ytPlaceholder) ytPlaceholder.style.display = "none";
    ytBackBtn.style.display = "none";
    if (ytPlayerTitle) ytPlayerTitle.textContent = "Search Results";
  });

  ytSearchInput?.addEventListener("keydown", (event) => {
    if (event.key === "Enter") handleSearch();
    event.stopPropagation();
  });
  ytSearchInput?.addEventListener("keyup", (event) => event.stopPropagation());
  ytSearchInput?.addEventListener("keypress", (event) => event.stopPropagation());

  ytDragHandle?.addEventListener("mousedown", startDrag);
  ytDragHandle?.addEventListener("touchstart", startDrag, { passive: false });
  ytResizeHandles.forEach((handle) => handle.addEventListener("pointerdown", startResize));

  ytPlayer.addEventListener("mousedown", (event) => event.stopPropagation());
  ytPlayer.addEventListener("pointerdown", (event) => event.stopPropagation());
  ytPlayer.addEventListener("touchstart", (event) => event.stopPropagation(), { passive: false });
  ytPlayer.addEventListener("wheel", (event) => event.stopPropagation());

  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && isOpen) closePlayer();
  });
  window.addEventListener("resize", () => {
    if (isOpen) requestAnimationFrame(clampPlayerToViewport);
  });

  window.Inkyscib = window.Inkyscib || {};
  window.Inkyscib.YouTube = {
    openFrame,
    saveCurrentFrame,
    seekTo,
    seekBy,
    togglePlay,
    setSpeed,
    toggleLoop,
    bookmark,
    addNote,
    notesAsText,
    setNotesOpen,
    setDocked,
    lectureState: () => ({
      videoId: currentVideoId,
      time: playerTime(),
      duration: playerDuration(),
      speed: library.speed,
      loop: { ...loopRange },
      notes: currentNotes().map((note) => ({ ...note })),
      docked: ytPlayer.classList.contains("yt-docked"),
      notesOpen: !!ytNotes && !ytNotes.hidden,
      transport: !!ytTransport && !ytTransport.hidden
    })
  };

  syncCaptureButton();
})();
