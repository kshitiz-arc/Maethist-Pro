// Inkyscib Focus Studio — pomodoro timer, session stats & focus sounds.
// Self-contained: builds its own DOM, persists to localStorage, no page deps
// beyond the #pomodoroBtn toolbar trigger.
(function () {
    'use strict';

    const STORE_KEY = 'inkyscib-pomodoro-v2';
    const LEGACY_FOCUS_KEY = 'pomodoro_focus';
    const LEGACY_BREAK_KEY = 'pomodoro_break';
    const TICK_MS = 250;
    const BASE_TITLE = document.title || 'Inkyscib';

    const MODES = {
        focus: { label: 'Focus', icon: 'fa-brain', emoji: '\u{1F345}' },
        short: { label: 'Break', icon: 'fa-coffee', emoji: '☕' },
        long: { label: 'Long break', icon: 'fa-couch', emoji: '\u{1F6CB}️' }
    };

    const PRESETS = {
        classic: { label: 'Classic', hint: '25 / 5 / 15', focus: 25, short: 5, long: 15 },
        deep: { label: 'Deep work', hint: '50 / 10 / 25', focus: 50, short: 10, long: 25 },
        sprint: { label: 'Sprint', hint: '15 / 3 / 10', focus: 15, short: 3, long: 10 }
    };

    const FOCUS_DONE_LINES = [
        'Focus session done — you earned this break! \u{1F389}',
        'Another one in the bank. Stretch those legs! \u{1F9D8}',
        'Boom. Session complete. \u{1F345}',
        'Brain: recharging recommended. Take five! ⚡'
    ];
    const BREAK_DONE_LINES = [
        "Break's over — let's get back to it! \u{1F4AA}",
        'Recharged? Time to lock in. \u{1F3AF}',
        'Round two. You got this. \u{1F345}'
    ];

    const prefersReducedMotion = window.matchMedia &&
        window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    document.addEventListener('DOMContentLoaded', init);

    function init() {
        const trigger = document.getElementById('pomodoroBtn');
        if (!trigger) return;

        // ---------------------------------------------------------------
        // State
        // ---------------------------------------------------------------
        const store = loadStore();
        const settings = store.settings;
        let stats = store.stats;
        let mode = 'focus';
        let running = false;
        let endAt = 0;            // epoch ms when the current session ends
        let remainingMs = minutes(settings[mode]) ;
        let sessionsDone = 0;     // focus sessions completed in the current cycle
        let currentTask = store.runtime.task || '';
        let tickHandle = null;

        restoreRuntime();

        // ---------------------------------------------------------------
        // DOM
        // ---------------------------------------------------------------
        removeStale('pomodoroModal');
        removeStale('floatingTimer');
        removeStale('pomoToastHost');

        const overlay = el('div', 'pomo-overlay');
        overlay.id = 'pomodoroModal';
        overlay.innerHTML = buildModalHTML();
        document.body.appendChild(overlay);

        const pill = el('div', 'pomo-pill');
        pill.id = 'floatingTimer';
        pill.innerHTML = buildPillHTML();
        pill.style.display = 'none';
        document.body.appendChild(pill);

        const toastHost = el('div', 'pomo-toast-host');
        toastHost.id = 'pomoToastHost';
        document.body.appendChild(toastHost);

        const ui = {
            panel: overlay.querySelector('.pomo-panel'),
            tabs: overlay.querySelectorAll('.pomo-tab'),
            time: overlay.querySelector('.pomo-time'),
            stageMode: overlay.querySelector('.pomo-stage-mode'),
            ring: overlay.querySelector('.pomo-ring-fill'),
            dots: overlay.querySelector('.pomo-dots'),
            mainBtn: overlay.querySelector('.pomo-main'),
            mainIcon: overlay.querySelector('.pomo-main i'),
            mainLabel: overlay.querySelector('.pomo-main span'),
            resetBtn: overlay.querySelector('.pomo-reset'),
            skipBtn: overlay.querySelector('.pomo-skip'),
            presets: overlay.querySelectorAll('.pomo-preset'),
            taskInput: overlay.querySelector('.pomo-task-input'),
            soundChips: overlay.querySelectorAll('.pomo-sound-chip'),
            volume: overlay.querySelector('.pomo-volume'),
            statSessions: overlay.querySelector('[data-stat="sessions"]'),
            statMinutes: overlay.querySelector('[data-stat="minutes"]'),
            statStreak: overlay.querySelector('[data-stat="streak"]'),
            settingsBtn: overlay.querySelector('.pomo-settings-toggle'),
            settingsPanel: overlay.querySelector('.pomo-settings'),
            muteBtn: overlay.querySelector('.pomo-mute'),
            closeBtn: overlay.querySelector('.pomo-close'),
            inFocus: overlay.querySelector('#pomoFocusMin'),
            inShort: overlay.querySelector('#pomoShortMin'),
            inLong: overlay.querySelector('#pomoLongMin'),
            inCycle: overlay.querySelector('#pomoCycle'),
            inAutoBreak: overlay.querySelector('#pomoAutoBreak'),
            inAutoFocus: overlay.querySelector('#pomoAutoFocus'),
            pillTime: pill.querySelector('.pomo-pill-time'),
            pillTask: pill.querySelector('.pomo-pill-task'),
            pillIcon: pill.querySelector('.pomo-pill-icon i'),
            pillPlay: pill.querySelector('.pomo-pill-play'),
            pillPlayIcon: pill.querySelector('.pomo-pill-play i'),
            pillBar: pill.querySelector('.pomo-pill-bar span')
        };

        const RING_LEN = 2 * Math.PI * 110;
        ui.ring.style.strokeDasharray = String(RING_LEN);

        // ---------------------------------------------------------------
        // Audio (chimes + ambient focus sounds) — all synthesized, no assets
        // ---------------------------------------------------------------
        let audioCtx = null;
        let ambient = { type: 'off', nodes: [], tickHandle: null, gain: null };

        function ensureAudio() {
            if (!audioCtx) {
                const Ctx = window.AudioContext || window.webkitAudioContext;
                if (!Ctx) return null;
                audioCtx = new Ctx();
            }
            if (audioCtx.state === 'suspended') {
                audioCtx.resume().catch(() => {});
            }
            return audioCtx;
        }

        function bellNote(ctx, freq, at, vol) {
            const osc = ctx.createOscillator();
            const shimmer = ctx.createOscillator();
            const gain = ctx.createGain();
            osc.type = 'sine';
            osc.frequency.value = freq;
            shimmer.type = 'sine';
            shimmer.frequency.value = freq * 2;
            const g2 = ctx.createGain();
            g2.gain.value = 0.28;
            gain.gain.setValueAtTime(0.0001, at);
            gain.gain.exponentialRampToValueAtTime(Math.max(0.02, vol * 0.5), at + 0.025);
            gain.gain.exponentialRampToValueAtTime(0.0001, at + 1.15);
            osc.connect(gain);
            shimmer.connect(g2);
            g2.connect(gain);
            gain.connect(ctx.destination);
            osc.start(at); osc.stop(at + 1.2);
            shimmer.start(at); shimmer.stop(at + 1.2);
        }

        function chime(kind) {
            if (!settings.sound) return;
            const ctx = ensureAudio();
            if (!ctx) return;
            const t = ctx.currentTime + 0.03;
            const vol = settings.volume;
            if (kind === 'focus-end') {
                [523.25, 659.25, 783.99].forEach((f, i) => bellNote(ctx, f, t + i * 0.16, vol));
            } else {
                [659.25, 523.25].forEach((f, i) => bellNote(ctx, f, t + i * 0.16, vol));
            }
        }

        function makeNoiseBuffer(ctx, brown) {
            const len = ctx.sampleRate * 2;
            const buffer = ctx.createBuffer(1, len, ctx.sampleRate);
            const data = buffer.getChannelData(0);
            let last = 0;
            for (let i = 0; i < len; i++) {
                const white = Math.random() * 2 - 1;
                if (brown) {
                    last = (last + 0.02 * white) / 1.02;
                    data[i] = last * 3.2;
                } else {
                    data[i] = white;
                }
            }
            return buffer;
        }

        function stopAmbient() {
            ambient.nodes.forEach((node) => {
                try { node.stop ? node.stop() : node.disconnect(); } catch (e) { /* already stopped */ }
            });
            if (ambient.gain) { try { ambient.gain.disconnect(); } catch (e) {} }
            if (ambient.tickHandle) { clearInterval(ambient.tickHandle); }
            ambient = { type: 'off', nodes: [], tickHandle: null, gain: null };
        }

        function ambientGainValue() {
            return settings.volume * 0.32;
        }

        function startAmbient(type) {
            stopAmbient();
            if (type === 'off') { syncSoundChips(); return; }
            const ctx = ensureAudio();
            if (!ctx) { toast('Audio is not available in this browser'); return; }

            const gain = ctx.createGain();
            gain.gain.value = ambientGainValue();
            gain.connect(ctx.destination);
            ambient.gain = gain;
            ambient.type = type;

            if (type === 'rain') {
                const src = ctx.createBufferSource();
                src.buffer = makeNoiseBuffer(ctx, false);
                src.loop = true;
                const low = ctx.createBiquadFilter();
                low.type = 'lowpass';
                low.frequency.value = 1150;
                const high = ctx.createBiquadFilter();
                high.type = 'highpass';
                high.frequency.value = 320;
                // slow drift on the filter so it doesn't sound like flat static
                const lfo = ctx.createOscillator();
                lfo.frequency.value = 0.11;
                const lfoGain = ctx.createGain();
                lfoGain.gain.value = 260;
                lfo.connect(lfoGain);
                lfoGain.connect(low.frequency);
                src.connect(high); high.connect(low); low.connect(gain);
                src.start(); lfo.start();
                ambient.nodes = [src, lfo];
            } else if (type === 'deep') {
                const src = ctx.createBufferSource();
                src.buffer = makeNoiseBuffer(ctx, true);
                src.loop = true;
                const low = ctx.createBiquadFilter();
                low.type = 'lowpass';
                low.frequency.value = 420;
                src.connect(low); low.connect(gain);
                src.start();
                ambient.nodes = [src];
            } else if (type === 'tick') {
                let hi = true;
                ambient.tickHandle = setInterval(() => {
                    if (!audioCtx || audioCtx.state !== 'running') return;
                    const t = audioCtx.currentTime + 0.01;
                    const osc = audioCtx.createOscillator();
                    const g = audioCtx.createGain();
                    osc.type = 'square';
                    osc.frequency.value = hi ? 2050 : 1720;
                    hi = !hi;
                    g.gain.setValueAtTime(0.0001, t);
                    g.gain.exponentialRampToValueAtTime(ambientGainValue() * 0.5, t + 0.004);
                    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.055);
                    osc.connect(g); g.connect(audioCtx.destination);
                    osc.start(t); osc.stop(t + 0.08);
                }, 1000);
                ambient.nodes = [];
            }
            syncSoundChips();
        }

        function syncSoundChips() {
            ui.soundChips.forEach((chip) => {
                chip.classList.toggle('active', chip.dataset.sound === ambient.type);
            });
        }

        // ---------------------------------------------------------------
        // Engine (timestamp based: correct even in throttled background tabs)
        // ---------------------------------------------------------------
        function currentDurationMs() {
            return minutes(settings[mode]);
        }

        function remaining() {
            return running ? Math.max(0, endAt - Date.now()) : remainingMs;
        }

        function start() {
            if (running) return;
            requestNotificationPermission();
            ensureAudio();
            running = true;
            endAt = Date.now() + remainingMs;
            startTicking();
            showPill();
            saveRuntime();
            render();
        }

        function pause() {
            if (!running) return;
            remainingMs = remaining();
            running = false;
            stopTicking();
            saveRuntime();
            render();
        }

        function reset() {
            running = false;
            stopTicking();
            remainingMs = currentDurationMs();
            saveRuntime();
            render();
        }

        function skip() {
            advance(false);
        }

        function setMode(next, opts) {
            if (!MODES[next]) return;
            mode = next;
            running = false;
            stopTicking();
            remainingMs = currentDurationMs();
            saveRuntime();
            render();
            if (opts && opts.autoStart) start();
        }

        function complete() {
            // A session ran to zero: reward, notify, advance.
            const finishedFocus = mode === 'focus';
            running = false;
            stopTicking();

            if (finishedFocus) {
                recordFocusSession(settings.focus);
                confettiBurst();
            }
            chime(finishedFocus ? 'focus-end' : 'break-end');

            const line = pick(finishedFocus ? FOCUS_DONE_LINES : BREAK_DONE_LINES);
            toast(line);
            notify(finishedFocus ? 'Focus complete' : 'Break over', line);

            advance(true);
        }

        function advance(fromCompletion) {
            const wasFocus = mode === 'focus';
            if (wasFocus) {
                sessionsDone += 1;
                if (sessionsDone >= settings.cycle) {
                    sessionsDone = 0;
                    setMode('long', { autoStart: fromCompletion && settings.autoBreaks });
                } else {
                    setMode('short', { autoStart: fromCompletion && settings.autoBreaks });
                }
            } else {
                setMode('focus', { autoStart: fromCompletion && settings.autoFocus });
            }
            pulsePill();
        }

        function startTicking() {
            stopTicking();
            tickHandle = setInterval(tick, TICK_MS);
        }

        function stopTicking() {
            if (tickHandle) {
                clearInterval(tickHandle);
                tickHandle = null;
            }
        }

        function tick() {
            if (!running) return;
            if (endAt - Date.now() <= 0) {
                remainingMs = 0;
                complete();
                return;
            }
            render();
        }

        document.addEventListener('visibilitychange', () => {
            if (!document.hidden && running) tick();
        });

        // ---------------------------------------------------------------
        // Stats
        // ---------------------------------------------------------------
        function recordFocusSession(mins) {
            const key = todayKey();
            const day = stats[key] || { m: 0, s: 0 };
            day.m += mins;
            day.s += 1;
            stats[key] = day;
            pruneStats();
            persist();
            renderStats();
        }

        function computeStreak() {
            let streak = 0;
            const cursor = new Date();
            const today = stats[dateKey(cursor)];
            if (!today || !today.s) cursor.setDate(cursor.getDate() - 1);
            while (true) {
                const day = stats[dateKey(cursor)];
                if (!day || !day.s) break;
                streak += 1;
                cursor.setDate(cursor.getDate() - 1);
            }
            return streak;
        }

        function pruneStats() {
            const keys = Object.keys(stats).sort();
            while (keys.length > 60) {
                delete stats[keys.shift()];
            }
        }

        // ---------------------------------------------------------------
        // Rendering
        // ---------------------------------------------------------------
        function render() {
            const rem = remaining();
            const total = currentDurationMs();
            const text = formatMs(rem);

            ui.time.textContent = text;
            ui.stageMode.textContent = MODES[mode].label;
            ui.pillTime.textContent = text;

            const progress = total > 0 ? 1 - rem / total : 0;
            ui.ring.style.strokeDashoffset = String(RING_LEN * (1 - progress));
            ui.pillBar.style.transform = 'scaleX(' + progress.toFixed(4) + ')';

            overlay.dataset.mode = mode;
            pill.dataset.mode = mode;

            ui.tabs.forEach((tab) => tab.classList.toggle('active', tab.dataset.mode === mode));

            setIcon(ui.mainIcon, running ? 'fa-pause' : 'fa-play');
            ui.mainLabel.textContent = running ? 'Pause' : (rem < total ? 'Resume' : 'Start');
            setIcon(ui.pillPlayIcon, running ? 'fa-pause' : 'fa-play');
            setIcon(ui.pillIcon, MODES[mode].icon);
            ui.pillTask.textContent = currentTask;
            ui.pillTask.style.display = currentTask ? '' : 'none';

            renderDots();

            const dirty = rem !== total;
            trigger.classList.toggle('timer-running', running);
            trigger.classList.toggle('timer-paused', !running && dirty);

            document.title = running || dirty
                ? MODES[mode].emoji + ' ' + text + ' · ' + BASE_TITLE
                : BASE_TITLE;
        }

        function renderDots() {
            const count = settings.cycle;
            if (ui.dots.childElementCount !== count) {
                ui.dots.innerHTML = '';
                for (let i = 0; i < count; i++) {
                    ui.dots.appendChild(el('span', 'pomo-dot'));
                }
            }
            Array.from(ui.dots.children).forEach((dot, i) => {
                dot.classList.toggle('done', i < sessionsDone);
                dot.classList.toggle('current', mode === 'focus' && i === sessionsDone);
            });
        }

        function renderStats() {
            const day = stats[todayKey()] || { m: 0, s: 0 };
            ui.statSessions.textContent = String(day.s);
            ui.statMinutes.textContent = day.m >= 60
                ? (Math.floor(day.m / 60) + 'h ' + (day.m % 60) + 'm')
                : (day.m + 'm');
            const streak = computeStreak();
            ui.statStreak.textContent = streak + (streak === 1 ? ' day' : ' days');
        }

        function syncSettingsInputs() {
            ui.inFocus.value = settings.focus;
            ui.inShort.value = settings.short;
            ui.inLong.value = settings.long;
            ui.inCycle.value = settings.cycle;
            ui.inAutoBreak.checked = settings.autoBreaks;
            ui.inAutoFocus.checked = settings.autoFocus;
            ui.volume.value = settings.volume;
            ui.muteBtn.innerHTML = '<i class="fas ' + (settings.sound ? 'fa-volume-up' : 'fa-volume-mute') + '"></i>';
            ui.muteBtn.classList.toggle('is-muted', !settings.sound);
            ui.presets.forEach((chip) => {
                const p = PRESETS[chip.dataset.preset];
                chip.classList.toggle('active',
                    p && p.focus === settings.focus && p.short === settings.short && p.long === settings.long);
            });
        }

        // ---------------------------------------------------------------
        // Modal open/close + floating pill
        // ---------------------------------------------------------------
        function openModal() {
            overlay.classList.add('active');
            render();
            renderStats();
        }

        function closeModal() {
            overlay.classList.remove('active');
            ui.settingsPanel.classList.remove('open');
            if (running || remaining() !== currentDurationMs()) showPill();
        }

        function showPill() {
            pill.style.display = '';
        }

        function hidePill() {
            pill.style.display = 'none';
        }

        function pulsePill() {
            if (pill.style.display === 'none') showPill();
            pill.classList.remove('pomo-pill-pop');
            void pill.offsetWidth;
            pill.classList.add('pomo-pill-pop');
        }

        // ---------------------------------------------------------------
        // Notifications, toasts, confetti
        // ---------------------------------------------------------------
        function requestNotificationPermission() {
            if (typeof Notification !== 'undefined' && Notification.permission === 'default') {
                try { Notification.requestPermission(); } catch (e) { /* older Safari */ }
            }
        }

        function notify(title, body) {
            if (typeof Notification === 'undefined' || Notification.permission !== 'granted') return;
            try {
                new Notification(title, { body: body, icon: '/static/logo.ico' });
            } catch (e) { /* notification blocked */ }
        }

        function toast(message) {
            const node = el('div', 'pomo-toast');
            node.textContent = message;
            toastHost.appendChild(node);
            requestAnimationFrame(() => node.classList.add('show'));
            setTimeout(() => {
                node.classList.remove('show');
                setTimeout(() => node.remove(), 350);
            }, 3400);
        }

        function confettiBurst() {
            if (prefersReducedMotion) return;
            const canvas = document.createElement('canvas');
            canvas.className = 'pomo-confetti';
            canvas.width = window.innerWidth;
            canvas.height = window.innerHeight;
            document.body.appendChild(canvas);
            const ctx = canvas.getContext('2d');
            const colors = ['#5a5aff', '#67e8f9', '#facc15', '#86efac', '#fb7185', '#ffffff'];
            const parts = [];
            for (let i = 0; i < 130; i++) {
                const fromLeft = i % 2 === 0;
                parts.push({
                    x: fromLeft ? -10 : canvas.width + 10,
                    y: canvas.height * (0.25 + Math.random() * 0.4),
                    vx: (fromLeft ? 1 : -1) * (4 + Math.random() * 7),
                    vy: -(5 + Math.random() * 7),
                    w: 5 + Math.random() * 6,
                    h: 8 + Math.random() * 6,
                    rot: Math.random() * Math.PI,
                    vr: (Math.random() - 0.5) * 0.3,
                    color: colors[i % colors.length]
                });
            }
            const startedAt = performance.now();
            function frame(now) {
                const t = now - startedAt;
                ctx.clearRect(0, 0, canvas.width, canvas.height);
                parts.forEach((p) => {
                    p.x += p.vx;
                    p.y += p.vy;
                    p.vy += 0.22;
                    p.vx *= 0.992;
                    p.rot += p.vr;
                    ctx.save();
                    ctx.translate(p.x, p.y);
                    ctx.rotate(p.rot);
                    ctx.globalAlpha = Math.max(0, 1 - t / 2400);
                    ctx.fillStyle = p.color;
                    ctx.fillRect(-p.w / 2, -p.h / 2, p.w, p.h);
                    ctx.restore();
                });
                if (t < 2400) {
                    requestAnimationFrame(frame);
                } else {
                    canvas.remove();
                }
            }
            requestAnimationFrame(frame);
        }

        // ---------------------------------------------------------------
        // Persistence
        // ---------------------------------------------------------------
        function loadStore() {
            const defaults = {
                settings: {
                    focus: 25, short: 5, long: 15, cycle: 4,
                    autoBreaks: true, autoFocus: false,
                    sound: true, volume: 0.7
                },
                stats: {},
                tasks: [],
                runtime: {}
            };
            let data = null;
            try { data = JSON.parse(localStorage.getItem(STORE_KEY)); } catch (e) { /* corrupt */ }
            if (!data || typeof data !== 'object') {
                data = defaults;
                // migrate the old v1 keys once
                const oldFocus = parseInt(localStorage.getItem(LEGACY_FOCUS_KEY), 10);
                const oldBreak = parseInt(localStorage.getItem(LEGACY_BREAK_KEY), 10);
                if (oldFocus >= 1 && oldFocus <= 120) data.settings.focus = oldFocus;
                if (oldBreak >= 1 && oldBreak <= 60) data.settings.short = oldBreak;
            }
            data.settings = Object.assign({}, defaults.settings, data.settings || {});
            data.stats = data.stats && typeof data.stats === 'object' ? data.stats : {};
            data.tasks = Array.isArray(data.tasks) ? data.tasks.slice(0, 12) : [];
            data.runtime = data.runtime && typeof data.runtime === 'object' ? data.runtime : {};
            return data;
        }

        function persist() {
            try {
                localStorage.setItem(STORE_KEY, JSON.stringify({
                    settings: settings,
                    stats: stats,
                    // Keep legacy task-list data intact even though its UI was removed.
                    tasks: store.tasks,
                    runtime: {
                        mode: mode,
                        running: running,
                        endAt: endAt,
                        remainingMs: remainingMs,
                        sessionsDone: sessionsDone,
                        task: currentTask
                    }
                }));
            } catch (e) { /* storage full or blocked */ }
        }

        function saveRuntime() {
            persist();
        }

        function restoreRuntime() {
            const rt = store.runtime;
            if (!rt || !MODES[rt.mode]) return;
            mode = rt.mode;
            sessionsDone = clampInt(rt.sessionsDone, 0, 12, 0);
            if (rt.running && rt.endAt > Date.now()) {
                running = true;
                endAt = rt.endAt;
                remainingMs = endAt - Date.now();
            } else if (rt.running && rt.endAt) {
                // The session finished while the page was closed: count it.
                if (mode === 'focus') recordFocusSessionSilently();
                if (mode === 'focus') {
                    sessionsDone += 1;
                    mode = sessionsDone >= settings.cycle ? 'long' : 'short';
                    if (sessionsDone >= settings.cycle) sessionsDone = 0;
                } else {
                    mode = 'focus';
                }
                remainingMs = minutes(settings[mode]);
            } else if (typeof rt.remainingMs === 'number' && rt.remainingMs > 0 &&
                       rt.remainingMs <= minutes(settings[mode])) {
                remainingMs = rt.remainingMs;
            } else {
                remainingMs = minutes(settings[mode]);
            }
        }

        function recordFocusSessionSilently() {
            const key = todayKey();
            const day = stats[key] || { m: 0, s: 0 };
            day.m += settings.focus;
            day.s += 1;
            stats[key] = day;
        }

        // ---------------------------------------------------------------
        // Wiring
        // ---------------------------------------------------------------
        trigger.addEventListener('click', () => {
            if (overlay.classList.contains('active')) closeModal();
            else openModal();
        });

        overlay.addEventListener('click', (e) => {
            if (e.target === overlay) closeModal();
        });

        ui.closeBtn.addEventListener('click', closeModal);

        ui.tabs.forEach((tab) => {
            tab.addEventListener('click', () => {
                if (tab.dataset.mode === mode) return;
                setMode(tab.dataset.mode);
            });
        });

        ui.mainBtn.addEventListener('click', () => (running ? pause() : start()));
        ui.resetBtn.addEventListener('click', reset);
        ui.skipBtn.addEventListener('click', skip);

        ui.presets.forEach((chip) => {
            chip.addEventListener('click', () => {
                const preset = PRESETS[chip.dataset.preset];
                if (!preset) return;
                settings.focus = preset.focus;
                settings.short = preset.short;
                settings.long = preset.long;
                if (!running) remainingMs = currentDurationMs();
                persist();
                syncSettingsInputs();
                render();
                toast(preset.label + ' preset: ' + preset.hint + ' min');
            });
        });

        ui.taskInput.value = currentTask;
        ui.taskInput.addEventListener('input', () => {
            currentTask = ui.taskInput.value.trim();
            persist();
            ui.pillTask.textContent = currentTask;
            ui.pillTask.style.display = currentTask ? '' : 'none';
        });

        ui.soundChips.forEach((chip) => {
            chip.addEventListener('click', () => {
                const type = chip.dataset.sound;
                startAmbient(ambient.type === type ? 'off' : type);
            });
        });

        ui.volume.addEventListener('input', () => {
            settings.volume = clampFloat(parseFloat(ui.volume.value), 0, 1, 0.7);
            if (ambient.gain) ambient.gain.gain.value = ambientGainValue();
            persist();
        });

        ui.muteBtn.addEventListener('click', () => {
            settings.sound = !settings.sound;
            persist();
            syncSettingsInputs();
            if (settings.sound) chime('break-end');
        });

        ui.settingsBtn.addEventListener('click', () => {
            ui.settingsPanel.classList.toggle('open');
        });

        function applySettingsInputs() {
            settings.focus = clampInt(parseInt(ui.inFocus.value, 10), 1, 120, settings.focus);
            settings.short = clampInt(parseInt(ui.inShort.value, 10), 1, 60, settings.short);
            settings.long = clampInt(parseInt(ui.inLong.value, 10), 1, 90, settings.long);
            settings.cycle = clampInt(parseInt(ui.inCycle.value, 10), 2, 8, settings.cycle);
            settings.autoBreaks = ui.inAutoBreak.checked;
            settings.autoFocus = ui.inAutoFocus.checked;
            if (!running) remainingMs = Math.min(remainingMs, currentDurationMs());
            if (!running && remainingMs === 0) remainingMs = currentDurationMs();
            persist();
            syncSettingsInputs();
            render();
        }

        [ui.inFocus, ui.inShort, ui.inLong, ui.inCycle].forEach((input) => {
            input.addEventListener('change', () => {
                applySettingsInputs();
                if (!running) reset();
            });
        });
        [ui.inAutoBreak, ui.inAutoFocus].forEach((input) => {
            input.addEventListener('change', applySettingsInputs);
        });

        // Floating pill
        ui.pillPlay.addEventListener('click', (e) => {
            e.stopPropagation();
            running ? pause() : start();
        });
        pill.querySelector('.pomo-pill-close').addEventListener('click', (e) => {
            e.stopPropagation();
            hidePill();
        });
        pill.addEventListener('click', (e) => {
            if (!e.target.closest('button')) openModal();
        });

        // Keyboard shortcuts, only while the modal is open. Capture phase so the
        // canvas space-pan handler (registered earlier, bubble phase) never sees it.
        document.addEventListener('keydown', (e) => {
            if (!overlay.classList.contains('active')) return;
            if (document.body.classList.contains('planner-open') ||
                document.body.classList.contains('feature-tour-open')) return;
            const tag = e.target && e.target.tagName;
            const typing = tag === 'INPUT' || tag === 'TEXTAREA';
            if (e.key === 'Escape') {
                e.stopPropagation();
                closeModal();
                return;
            }
            if (typing) return;
            if (e.key === ' ') {
                e.preventDefault();
                e.stopPropagation();
                running ? pause() : start();
            } else if (e.key.toLowerCase() === 'r') {
                e.stopPropagation();
                reset();
            }
        }, true);

        window.addEventListener('beforeunload', persist);

        // ---------------------------------------------------------------
        // Boot
        // ---------------------------------------------------------------
        syncSettingsInputs();
        renderStats();
        render();
        persist();
        if (running) {
            startTicking();
            showPill();
        } else if (remaining() !== currentDurationMs()) {
            showPill();
        }
    }

    function setIcon(node, iconClass) {
        if (!node.classList.contains(iconClass)) {
            node.className = 'fas ' + iconClass;
        }
    }

    // -------------------------------------------------------------------
    // Markup
    // -------------------------------------------------------------------
    function buildModalHTML() {
        return '' +
        '<div class="pomo-panel" role="dialog" aria-label="Focus timer">' +
            '<div class="pomo-head">' +
                '<div class="pomo-title"><i class="fas fa-clock"></i><span>Focus studio</span></div>' +
                '<div class="pomo-head-actions">' +
                    '<button class="pomo-icon-btn pomo-mute" type="button" title="Chime on/off" aria-label="Toggle chime"><i class="fas fa-volume-up"></i></button>' +
                    '<button class="pomo-icon-btn pomo-settings-toggle" type="button" title="Settings" aria-label="Timer settings"><i class="fas fa-cog"></i></button>' +
                    '<button class="pomo-icon-btn pomo-close" type="button" title="Close" aria-label="Close timer"><i class="fas fa-times"></i></button>' +
                '</div>' +
            '</div>' +

            '<div class="pomo-settings">' +
                '<div class="pomo-settings-grid">' +
                    '<label>Focus<input id="pomoFocusMin" type="number" min="1" max="120" inputmode="numeric"></label>' +
                    '<label>Break<input id="pomoShortMin" type="number" min="1" max="60" inputmode="numeric"></label>' +
                    '<label>Long<input id="pomoLongMin" type="number" min="1" max="90" inputmode="numeric"></label>' +
                    '<label>Cycle<input id="pomoCycle" type="number" min="2" max="8" inputmode="numeric"></label>' +
                '</div>' +
                '<label class="pomo-switch"><input id="pomoAutoBreak" type="checkbox"><span></span>Auto-start breaks</label>' +
                '<label class="pomo-switch"><input id="pomoAutoFocus" type="checkbox"><span></span>Auto-start focus after breaks</label>' +
            '</div>' +

            '<div class="pomo-tabs" role="tablist" aria-label="Timer mode">' +
                '<button class="pomo-tab" type="button" data-mode="focus">Focus</button>' +
                '<button class="pomo-tab" type="button" data-mode="short">Break</button>' +
                '<button class="pomo-tab" type="button" data-mode="long">Long</button>' +
            '</div>' +

            '<div class="pomo-stage">' +
                '<svg class="pomo-ring" viewBox="0 0 240 240" aria-hidden="true">' +
                    '<circle class="pomo-ring-track" cx="120" cy="120" r="110"/>' +
                    '<circle class="pomo-ring-fill" cx="120" cy="120" r="110"/>' +
                '</svg>' +
                '<div class="pomo-stage-inner">' +
                    '<div class="pomo-time">25:00</div>' +
                    '<div class="pomo-stage-mode">Focus</div>' +
                    '<div class="pomo-dots" aria-hidden="true"></div>' +
                '</div>' +
            '</div>' +

            '<div class="pomo-controls">' +
                '<button class="pomo-ctrl pomo-reset" type="button" title="Reset (R)" aria-label="Reset timer"><i class="fas fa-redo-alt"></i></button>' +
                '<button class="pomo-ctrl pomo-main" type="button" title="Start / pause (Space)"><i class="fas fa-play"></i><span>Start</span></button>' +
                '<button class="pomo-ctrl pomo-skip" type="button" title="Skip to next" aria-label="Skip session"><i class="fas fa-forward"></i></button>' +
            '</div>' +

            '<div class="pomo-presets" role="group" aria-label="Presets">' +
                '<button class="pomo-preset" type="button" data-preset="sprint">Sprint <em>15/3</em></button>' +
                '<button class="pomo-preset" type="button" data-preset="classic">Classic <em>25/5</em></button>' +
                '<button class="pomo-preset" type="button" data-preset="deep">Deep <em>50/10</em></button>' +
            '</div>' +

            '<div class="pomo-task-row">' +
                '<i class="fas fa-bullseye" aria-hidden="true"></i>' +
                '<input class="pomo-task-input" type="text" maxlength="80" placeholder="What are you working on?" aria-label="Current focus">' +
            '</div>' +

            '<div class="pomo-section">' +
                '<div class="pomo-section-head"><span>Focus sounds</span></div>' +
                '<div class="pomo-sound-row">' +
                    '<button class="pomo-sound-chip" type="button" data-sound="rain">\u{1F327}️ Rain</button>' +
                    '<button class="pomo-sound-chip" type="button" data-sound="deep">\u{1F30A} Deep</button>' +
                    '<button class="pomo-sound-chip" type="button" data-sound="tick">⏱️ Tick</button>' +
                    '<input class="pomo-volume" type="range" min="0" max="1" step="0.05" aria-label="Sound volume">' +
                '</div>' +
            '</div>' +

            '<div class="pomo-stats">' +
                '<div class="pomo-stat"><span class="pomo-stat-value" data-stat="sessions">0</span><span class="pomo-stat-label">\u{1F345} today</span></div>' +
                '<div class="pomo-stat"><span class="pomo-stat-value" data-stat="minutes">0m</span><span class="pomo-stat-label">focused</span></div>' +
                '<div class="pomo-stat"><span class="pomo-stat-value" data-stat="streak">0 days</span><span class="pomo-stat-label">\u{1F525} streak</span></div>' +
            '</div>' +
        '</div>';
    }

    function buildPillHTML() {
        return '' +
        '<span class="pomo-pill-icon"><i class="fas fa-brain"></i></span>' +
        '<span class="pomo-pill-body">' +
            '<span class="pomo-pill-time">25:00</span>' +
            '<span class="pomo-pill-task"></span>' +
        '</span>' +
        '<button class="pomo-pill-play" type="button" aria-label="Start or pause"><i class="fas fa-play"></i></button>' +
        '<button class="pomo-pill-close" type="button" aria-label="Hide timer"><i class="fas fa-times"></i></button>' +
        '<span class="pomo-pill-bar" aria-hidden="true"><span></span></span>';
    }

    // -------------------------------------------------------------------
    // Helpers
    // -------------------------------------------------------------------
    function el(tag, className) {
        const node = document.createElement(tag);
        if (className) node.className = className;
        return node;
    }

    function removeStale(id) {
        const node = document.getElementById(id);
        if (node) node.remove();
    }

    function minutes(mins) {
        return mins * 60 * 1000;
    }

    function formatMs(ms) {
        const totalSeconds = Math.ceil(ms / 1000);
        const m = Math.floor(totalSeconds / 60);
        const s = totalSeconds % 60;
        return String(m).padStart(2, '0') + ':' + String(s).padStart(2, '0');
    }

    function dateKey(date) {
        return date.getFullYear() + '-' +
            String(date.getMonth() + 1).padStart(2, '0') + '-' +
            String(date.getDate()).padStart(2, '0');
    }

    function todayKey() {
        return dateKey(new Date());
    }

    function clampInt(value, min, max, fallback) {
        if (isNaN(value)) return fallback;
        return Math.min(max, Math.max(min, value));
    }

    function clampFloat(value, min, max, fallback) {
        if (isNaN(value)) return fallback;
        return Math.min(max, Math.max(min, value));
    }

    function pick(list) {
        return list[Math.floor(Math.random() * list.length)];
    }
})();
