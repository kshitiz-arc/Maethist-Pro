// Inkyscib focus timer: pomodoro sessions, one quiet stats line, focus sounds.
//
// Rebuilt 2026-09-15 from four reports: the panel was complicated, the rain did
// not sound like rain, the deep sea sound was inaudible, and the settings icon
// looked like a sun. tests/test_pomodoro.py measures all four; the design is
// section 2 of docs/superpowers/specs/2026-09-14-editor-feedback-design.md.
//
// Self-contained: builds its own DOM, persists to localStorage, and needs
// nothing from the page beyond the #pomodoroBtn trigger.
(function () {
    'use strict';

    const STORE_KEY = 'inkyscib-pomodoro-v2';
    const LEGACY_FOCUS_KEY = 'pomodoro_focus';
    const LEGACY_BREAK_KEY = 'pomodoro_break';
    const TICK_MS = 250;
    const BASE_TITLE = document.title || 'Inkyscib';

    const MODES = {
        focus: { label: 'Focus', icon: 'fa-brain' },
        short: { label: 'Break', icon: 'fa-coffee' },
        long: { label: 'Long break', icon: 'fa-couch' }
    };

    const PRESETS = {
        sprint: { label: 'Sprint', focus: 15, short: 3, long: 10 },
        classic: { label: 'Classic', focus: 25, short: 5, long: 15 },
        deep: { label: 'Deep work', focus: 50, short: 10, long: 25 }
    };

    const SOUNDS = [
        { id: 'off', label: 'Off', icon: 'fa-volume-mute' },
        { id: 'rain', label: 'Rain', icon: 'fa-cloud-rain' },
        { id: 'deep', label: 'Deep sea', icon: 'fa-water' },
        { id: 'clock', label: 'Clock', icon: 'fa-clock' }
    ];

    const FOCUS_DONE_LINES = [
        'Focus session done. Take your break.',
        'Another session in the bank. Stretch your legs.',
        'Session complete. Rest your eyes for a moment.'
    ];
    const BREAK_DONE_LINES = [
        "Break's over. Back to it.",
        'Recharged? Time for the next session.'
    ];

    const prefersReducedMotion = window.matchMedia &&
        window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    // =====================================================================
    // Focus sounds
    // =====================================================================
    //
    // Each sound is rendered once into a looping buffer instead of being a
    // live chain of filters. That is what lets rain be thousands of separate
    // drops, which a node graph cannot schedule cheaply, and it lets every
    // sound be measured and levelled before it is ever heard.
    //
    // Levels are set through a stand-in for a tablet or laptop speaker: three
    // 500Hz high-pass stages and an 8kHz low-pass. Those speakers reproduce
    // almost nothing lower, which is why the old deep sea sound - brown noise
    // cut at 420Hz - read as loud as the rain on a full-range meter and was
    // silent on the device. Through this filter, at the default volume, the old
    // rain measured -24.8 dB and the old deep sea -37.1 dB.

    const GENERATION_RATE = 32000;
    // Speaker-filtered loudness at volume 1. The default volume of 0.7 puts
    // rain and deep sea both near -24 dB, where the old rain already was.
    const SPEAKER_TARGET_DB = -21;
    const CLOCK_PEAK = 0.4;
    const LOOP_SECONDS = { rain: 12, deep: 16, clock: 2 };
    // WebAudio's BiquadFilterNode defaults to Q = 1 dB, which is what the
    // tests' speaker filter uses; matching it keeps the two measurements equal.
    const SPEAKER_Q = Math.pow(10, 1 / 20);

    function seededRandom(seed) {
        let a = seed >>> 0;
        return function () {
            a = (a + 0x6D2B79F5) >>> 0;
            let t = a;
            t = Math.imul(t ^ (t >>> 15), t | 1);
            t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
            return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
        };
    }

    // RBJ cookbook biquads, direct form I. Band-pass has a 0 dB peak.
    function biquad(type, frequency, q, rate) {
        const w = 2 * Math.PI * Math.min(frequency, rate * 0.45) / rate;
        const cos = Math.cos(w);
        const alpha = Math.sin(w) / (2 * q);
        let b0;
        let b1;
        let b2;
        if (type === 'lowpass') {
            b0 = (1 - cos) / 2; b1 = 1 - cos; b2 = (1 - cos) / 2;
        } else if (type === 'highpass') {
            b0 = (1 + cos) / 2; b1 = -(1 + cos); b2 = (1 + cos) / 2;
        } else {
            b0 = alpha; b1 = 0; b2 = -alpha;
        }
        const a0 = 1 + alpha;
        return {
            b0: b0 / a0, b1: b1 / a0, b2: b2 / a0,
            a1: (-2 * cos) / a0, a2: (1 - alpha) / a0,
            x1: 0, x2: 0, y1: 0, y2: 0
        };
    }

    function filterSample(f, x) {
        const y = f.b0 * x + f.b1 * f.x1 + f.b2 * f.x2 - f.a1 * f.y1 - f.a2 * f.y2;
        f.x2 = f.x1; f.x1 = x;
        f.y2 = f.y1; f.y1 = y;
        return y;
    }

    function speakerRms(channels, rate) {
        const chain = [
            biquad('highpass', 500, SPEAKER_Q, rate),
            biquad('highpass', 500, SPEAKER_Q, rate),
            biquad('highpass', 500, SPEAKER_Q, rate),
            biquad('lowpass', 8000, SPEAKER_Q, rate)
        ];
        const length = channels[0].length;
        const settle = Math.floor(rate * 0.25);
        let sum = 0;
        for (let i = 0; i < length; i++) {
            let x = 0;
            for (let c = 0; c < channels.length; c++) x += channels[c][i];
            x /= channels.length;
            for (let k = 0; k < chain.length; k++) x = filterSample(chain[k], x);
            if (i >= settle) sum += x * x;
        }
        return Math.sqrt(sum / Math.max(1, length - settle));
    }

    // Level to the speaker target, then round off the rare peak above 0.8 so
    // a heavy drop or a breaking wave can never clip.
    function levelChannels(channels, rate) {
        const gain = Math.pow(10, SPEAKER_TARGET_DB / 20) / (speakerRms(channels, rate) || 1e-9);
        channels.forEach((data) => {
            for (let i = 0; i < data.length; i++) {
                const x = data[i] * gain;
                const size = Math.abs(x);
                data[i] = size <= 0.8 ? x : Math.sign(x) * (0.8 + 0.19 * Math.tanh((size - 0.8) / 0.19));
            }
        });
        return channels;
    }

    // The buffers are rendered a little past the loop length and that tail is
    // faded into the head, so the loop point is a crossfade instead of a click.
    function foldLoop(channels, loopLength, fadeLength) {
        return channels.map((data) => {
            const out = new Float32Array(loopLength);
            out.set(data.subarray(0, loopLength));
            for (let i = 0; i < fadeLength; i++) {
                const t = i / fadeLength;
                out[i] = data[i] * Math.sin(t * Math.PI / 2) + data[loopLength + i] * Math.cos(t * Math.PI / 2);
            }
            return out;
        });
    }

    // Generation is spread over tasks, one second of audio at a time, so a slow
    // tablet never sees a long frame while a sound is being prepared.
    function nextTask() {
        return new Promise((resolve) => setTimeout(resolve, 0));
    }

    function pinkNoise(state, white) {
        state.b0 = 0.99765 * state.b0 + white * 0.0990460;
        state.b1 = 0.96300 * state.b1 + white * 0.2965164;
        state.b2 = 0.57000 * state.b2 + white * 1.0526913;
        return (state.b0 + state.b1 + state.b2 + white * 0.1848) * 0.2;
    }

    async function buildRain(rate) {
        const random = seededRandom(0x5eed1a1);
        const loop = Math.round(LOOP_SECONDS.rain * rate);
        const fade = Math.round(1.5 * rate);
        const total = loop + fade;
        const left = new Float32Array(total);
        const right = new Float32Array(total);

        // 1. The bed: rain too far away to hear as drops. It breathes with
        //    slow gusts rather than sitting flat, which is what static does.
        const beds = [0, 1].map(() => ({
            b0: 0, b1: 0, b2: 0,
            high: biquad('highpass', 450, 0.7, rate),
            low: biquad('lowpass', 6500, 0.7, rate)
        }));
        const phase = [random() * 6.283, random() * 6.283, random() * 6.283];
        for (let start = 0; start < total; start += rate) {
            const end = Math.min(total, start + rate);
            for (let i = start; i < end; i++) {
                const t = i / rate;
                const gust = 0.7 + 0.18 * Math.sin(t * 0.37 + phase[0]) +
                    0.08 * Math.sin(t * 0.83 + phase[1]) + 0.04 * Math.sin(t * 1.9 + phase[2]);
                for (let c = 0; c < 2; c++) {
                    const bed = beds[c];
                    const sample = filterSample(bed.low, filterSample(bed.high, pinkNoise(bed, random() * 2 - 1)));
                    (c === 0 ? left : right)[i] = sample * gust * 0.22;
                }
            }
            await nextTask();
        }

        // 2. Drops. Most are small and bright; some are heavier; a few land
        //    close. Each is a burst of noise through its own band-pass, so no
        //    two share a pitch, and each lands somewhere between the ears.
        function addDrop(at, seconds, centre, q, level, decaySeconds, pan) {
            const filter = biquad('bandpass', centre, q, rate);
            const length = Math.round(seconds * rate);
            const decay = decaySeconds * rate;
            const toLeft = Math.cos(pan * Math.PI / 2);
            const toRight = Math.sin(pan * Math.PI / 2);
            for (let j = 0; j < length && at + j < total; j++) {
                const attack = j < 3 ? (j + 1) / 4 : 1;
                const x = filterSample(filter, random() * 2 - 1) * Math.exp(-j / decay) * attack * level;
                left[at + j] += x * toLeft;
                right[at + j] += x * toRight;
            }
        }

        const seconds = Math.ceil(total / rate);
        for (let s = 0; s < seconds; s++) {
            const light = Math.round(170 * (0.75 + random() * 0.5));
            for (let k = 0; k < light; k++) {
                addDrop(Math.floor((s + random()) * rate), 0.004 + random() * 0.004,
                    3200 + random() * 4500, 1.1, 0.5 * Math.pow(10, -random() * 1.1),
                    0.0009 + random() * 0.0012, random());
            }
            const medium = Math.round(36 * (0.7 + random() * 0.6));
            for (let k = 0; k < medium; k++) {
                addDrop(Math.floor((s + random()) * rate), 0.014 + random() * 0.012,
                    1500 + random() * 2200, 1.6, 1.1 * Math.pow(10, -random() * 0.8),
                    0.0028 + random() * 0.003, 0.15 + random() * 0.7);
            }
            const heavy = Math.round(7 * (0.6 + random() * 0.8));
            for (let k = 0; k < heavy; k++) {
                addDrop(Math.floor((s + random()) * rate), 0.035 + random() * 0.03,
                    750 + random() * 1100, 2.2, 1.9 * Math.pow(10, -random() * 0.5),
                    0.007 + random() * 0.008, 0.3 + random() * 0.4);
            }
            await nextTask();
        }

        return levelChannels(foldLoop([left, right], loop, fade), rate);
    }

    async function buildDeepSea(rate) {
        const random = seededRandom(0xdee95ea);
        const loop = Math.round(LOOP_SECONDS.deep * rate);
        const fade = Math.round(3 * rate);
        const total = loop + fade;
        const left = new Float32Array(total);
        const right = new Float32Array(total);

        // One wave every 8-12s: it builds for about 40% of its length, breaks,
        // and drains away. Between waves the sea is quieter, never silent.
        const FLOOR = 0.2;
        const waves = [];
        for (let t = -random() * 6; t < total / rate + 12;) {
            const length = 8 + random() * 4;
            waves.push({ start: t, length, crest: 0.82 + random() * 0.18 });
            t += length;
        }
        let waveIndex = 0;
        function swellAt(t) {
            while (waveIndex < waves.length - 1 && t >= waves[waveIndex].start + waves[waveIndex].length) waveIndex++;
            const wave = waves[waveIndex];
            const u = Math.min(1, Math.max(0, (t - wave.start) / wave.length));
            const RISE = 0.4;
            const shape = u < RISE
                ? (u / RISE) * (u / RISE) * (3 - 2 * (u / RISE))
                : Math.exp(-(u - RISE) / 0.2);
            return FLOOR + (wave.crest - FLOOR) * shape;
        }

        // Low-mid noise, where a small speaker can still play it, brightening
        // as each wave breaks. A soft rumble sits underneath for anyone
        // listening on headphones. The two sides share part of their noise, so
        // the sea is wide but still one sea.
        const sides = [0, 1].map(() => ({
            b0: 0, b1: 0, b2: 0, brown: 0, rumble: 0, glow: 0,
            high1: biquad('highpass', 150, 0.7, rate),
            high2: biquad('highpass', 150, 0.7, rate),
            low: biquad('lowpass', 1800, 0.7, rate),
            rumbleLow: biquad('lowpass', 120, 0.7, rate)
        }));
        for (let start = 0; start < total; start += rate) {
            const end = Math.min(total, start + rate);
            for (let i = start; i < end; i++) {
                const swell = swellAt(i / rate);
                const cutoff = 450 + 1750 * Math.pow(swell, 1.6);
                const keep = Math.exp(-2 * Math.PI * cutoff / rate);
                const shared = random() * 2 - 1;
                for (let c = 0; c < 2; c++) {
                    const side = sides[c];
                    const white = 0.6 * shared + 0.8 * (random() * 2 - 1);
                    side.brown = side.brown * 0.996 + white * 0.08;
                    const pink = pinkNoise(side, white);
                    const band = filterSample(side.low, filterSample(side.high2, filterSample(side.high1, side.brown * 0.7 + pink)));
                    side.glow = side.glow * keep + band * (1 - keep);
                    const rumble = filterSample(side.rumbleLow, side.brown) * (0.6 + 0.4 * swell);
                    (c === 0 ? left : right)[i] = side.glow * swell + rumble * 0.12;
                }
            }
            await nextTask();
        }

        return levelChannels(foldLoop([left, right], loop, fade), rate);
    }

    function buildClock(rate) {
        const random = seededRandom(0xc10c);
        const length = Math.round(LOOP_SECONDS.clock * rate);
        const left = new Float32Array(length);
        const right = new Float32Array(length);

        // A tick and a slightly lower tock: two partials and a short noise
        // transient each, like a small mechanical clock rather than a beep.
        function click(atSeconds, partials, level) {
            const at = Math.round(atSeconds * rate);
            const span = Math.round(0.03 * rate);
            for (let j = 0; j < span && at + j < length; j++) {
                const t = j / rate;
                let x = (random() * 2 - 1) * 0.35 * Math.exp(-t / 0.0015);
                partials.forEach(([frequency, amplitude, decay]) => {
                    x += Math.sin(2 * Math.PI * frequency * t) * amplitude * Math.exp(-t / decay);
                });
                left[at + j] += x * level;
                right[at + j] += x * level;
            }
        }
        click(0.02, [[2300, 1, 0.004], [3600, 0.5, 0.0025]], 1);
        click(1.02, [[1750, 1, 0.005], [2900, 0.45, 0.003]], 0.85);

        // A clock is heard by its ticks, not its average, so it is levelled by
        // its peak.
        let peak = 0;
        for (let i = 0; i < length; i++) peak = Math.max(peak, Math.abs(left[i]));
        const gain = CLOCK_PEAK / (peak || 1);
        for (let i = 0; i < length; i++) {
            left[i] *= gain;
            right[i] *= gain;
        }
        return [left, right];
    }

    const builtSounds = new Map();

    function soundChannels(type, rate) {
        const key = type + '@' + rate;
        if (!builtSounds.has(key)) {
            const build = type === 'rain'
                ? buildRain(rate)
                : type === 'deep'
                    ? buildDeepSea(rate)
                    : Promise.resolve(buildClock(rate));
            builtSounds.set(key, build.catch((error) => {
                builtSounds.delete(key);
                throw error;
            }));
        }
        return builtSounds.get(key);
    }

    function toAudioBuffer(ctx, channels, rate) {
        const buffer = ctx.createBuffer(channels.length, channels[0].length, rate);
        channels.forEach((data, index) => buffer.copyToChannel(data, index));
        return buffer;
    }

    // Renders `seconds` of a looping focus sound at `volume`, exactly as
    // playback would. Used by the tests to measure what a listener hears.
    async function renderAmbient(type, options) {
        if (!['rain', 'deep', 'clock'].includes(type)) throw new Error('Unknown focus sound: ' + type);
        const opts = options || {};
        const sampleRate = opts.sampleRate || 44100;
        const seconds = opts.seconds || 6;
        const volume = typeof opts.volume === 'number' ? opts.volume : 0.7;
        const Offline = window.OfflineAudioContext || window.webkitOfflineAudioContext;
        const channels = await soundChannels(type, sampleRate);
        const ctx = new Offline(2, Math.round(seconds * sampleRate), sampleRate);
        const source = ctx.createBufferSource();
        source.buffer = toAudioBuffer(ctx, channels, sampleRate);
        source.loop = true;
        const gain = ctx.createGain();
        gain.gain.value = volume;
        source.connect(gain);
        gain.connect(ctx.destination);
        source.start();
        return ctx.startRendering();
    }

    // =====================================================================
    // The timer
    // =====================================================================

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init, { once: true });
    } else {
        init();
    }

    function init() {
        const trigger = document.getElementById('pomodoroBtn');
        if (!trigger) return;

        const store = loadStore();
        const settings = store.settings;
        const stats = store.stats;
        let mode = 'focus';
        let running = false;
        let endAt = 0;
        let remainingMs = minutes(settings[mode]);
        let sessionsDone = 0;
        let currentTask = store.runtime.task || '';
        let tickHandle = null;

        restoreRuntime();

        removeStale('pomodoroModal');
        removeStale('floatingTimer');
        removeStale('pomoToastHost');

        const overlay = el('div', 'pomo-overlay');
        overlay.id = 'pomodoroModal';
        overlay.dataset.view = 'main';
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

        const q = (selector) => overlay.querySelector(selector);
        const ui = {
            panel: q('.pomo-panel'),
            viewMain: q('.pomo-view-main'),
            viewSettings: q('.pomo-view-settings'),
            back: q('.pomo-back'),
            settingsBtn: q('.pomo-settings-toggle'),
            closeBtn: q('.pomo-close'),
            tabs: overlay.querySelectorAll('.pomo-tab'),
            time: q('.pomo-time'),
            stageMode: q('.pomo-stage-mode'),
            ring: q('.pomo-ring-fill'),
            dots: q('.pomo-dots'),
            mainBtn: q('.pomo-main'),
            mainIcon: q('.pomo-main i'),
            mainLabel: q('.pomo-main span'),
            resetBtn: q('.pomo-reset'),
            skipBtn: q('.pomo-skip'),
            taskInput: q('.pomo-task-input'),
            soundOptions: overlay.querySelectorAll('.pomo-sound-option'),
            volume: q('.pomo-volume'),
            statsLine: q('.pomo-stats-line'),
            presets: overlay.querySelectorAll('.pomo-preset'),
            inFocus: q('#pomoFocusMin'),
            inShort: q('#pomoShortMin'),
            inLong: q('#pomoLongMin'),
            inCycle: q('#pomoCycle'),
            inAutoBreak: q('#pomoAutoBreak'),
            inAutoFocus: q('#pomoAutoFocus'),
            inChime: q('#pomoChime'),
            pillTime: pill.querySelector('.pomo-pill-time'),
            pillTask: pill.querySelector('.pomo-pill-task'),
            pillIcon: pill.querySelector('.pomo-pill-icon i'),
            pillPlay: pill.querySelector('.pomo-pill-play'),
            pillPlayIcon: pill.querySelector('.pomo-pill-play i'),
            pillBar: pill.querySelector('.pomo-pill-bar span')
        };

        const RING_LEN = 2 * Math.PI * 110;
        ui.ring.style.strokeDasharray = String(RING_LEN);

        // -----------------------------------------------------------------
        // Audio: session chimes and the focus sound
        // -----------------------------------------------------------------
        let audioCtx = null;
        let ambient = { type: 'off', source: null, gain: null };
        let ambientRequest = 0;

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

        function bellNote(ctx, frequency, at, volume) {
            const osc = ctx.createOscillator();
            const shimmer = ctx.createOscillator();
            const gain = ctx.createGain();
            const shimmerGain = ctx.createGain();
            osc.type = 'sine';
            osc.frequency.value = frequency;
            shimmer.type = 'sine';
            shimmer.frequency.value = frequency * 2;
            shimmerGain.gain.value = 0.28;
            gain.gain.setValueAtTime(0.0001, at);
            gain.gain.exponentialRampToValueAtTime(Math.max(0.02, volume * 0.5), at + 0.025);
            gain.gain.exponentialRampToValueAtTime(0.0001, at + 1.15);
            osc.connect(gain);
            shimmer.connect(shimmerGain);
            shimmerGain.connect(gain);
            gain.connect(ctx.destination);
            osc.start(at); osc.stop(at + 1.2);
            shimmer.start(at); shimmer.stop(at + 1.2);
        }

        function chime(kind) {
            if (!settings.sound) return;
            const ctx = ensureAudio();
            if (!ctx) return;
            const t = ctx.currentTime + 0.03;
            const notes = kind === 'focus-end' ? [523.25, 659.25, 783.99] : [659.25, 523.25];
            notes.forEach((frequency, i) => bellNote(ctx, frequency, t + i * 0.16, settings.volume));
        }

        function stopAmbient() {
            const { source, gain } = ambient;
            if (source && gain && audioCtx) {
                const now = audioCtx.currentTime;
                try {
                    gain.gain.cancelScheduledValues(now);
                    gain.gain.setValueAtTime(gain.gain.value, now);
                    gain.gain.linearRampToValueAtTime(0.0001, now + 0.25);
                    source.stop(now + 0.3);
                } catch (e) {
                    try { source.stop(); } catch (_) { /* already stopped */ }
                }
            }
            ambient = { type: 'off', source: null, gain: null };
        }

        async function playAmbient(type) {
            const request = ++ambientRequest;
            stopAmbient();
            ambient.type = type;
            syncSoundOptions();
            if (type === 'off') return;

            const ctx = ensureAudio();
            if (!ctx) {
                ambient.type = 'off';
                syncSoundOptions();
                toast('Sound is not available in this browser');
                return;
            }

            let channels;
            try {
                channels = await soundChannels(type, GENERATION_RATE);
            } catch (e) {
                if (request === ambientRequest) {
                    ambient.type = 'off';
                    syncSoundOptions();
                    toast('That sound could not be prepared');
                }
                return;
            }
            // Another choice was made while this one was being prepared.
            if (request !== ambientRequest) return;

            const source = ctx.createBufferSource();
            source.buffer = toAudioBuffer(ctx, channels, GENERATION_RATE);
            source.loop = true;
            const gain = ctx.createGain();
            gain.gain.setValueAtTime(0.0001, ctx.currentTime);
            gain.gain.linearRampToValueAtTime(settings.volume, ctx.currentTime + 0.4);
            source.connect(gain);
            gain.connect(ctx.destination);
            source.start();
            ambient = { type, source, gain };
        }

        function syncSoundOptions() {
            ui.soundOptions.forEach((option) => {
                option.setAttribute('aria-pressed', String(option.dataset.sound === ambient.type));
            });
        }

        // -----------------------------------------------------------------
        // Engine. Timestamp based, so it stays right in a throttled tab.
        // -----------------------------------------------------------------
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
            persist();
            render();
        }

        function pause() {
            if (!running) return;
            remainingMs = remaining();
            running = false;
            stopTicking();
            persist();
            render();
        }

        function reset() {
            running = false;
            stopTicking();
            remainingMs = currentDurationMs();
            persist();
            render();
        }

        function setMode(next, opts) {
            if (!MODES[next]) return;
            mode = next;
            running = false;
            stopTicking();
            remainingMs = currentDurationMs();
            persist();
            render();
            if (opts && opts.autoStart) start();
        }

        function complete() {
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
            if (mode === 'focus') {
                sessionsDone += 1;
                const longBreak = sessionsDone >= settings.cycle;
                if (longBreak) sessionsDone = 0;
                setMode(longBreak ? 'long' : 'short', { autoStart: fromCompletion && settings.autoBreaks });
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

        // -----------------------------------------------------------------
        // Stats
        // -----------------------------------------------------------------
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
            for (;;) {
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

        // -----------------------------------------------------------------
        // Rendering
        // -----------------------------------------------------------------
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
            ui.tabs.forEach((tab) => {
                const active = tab.dataset.mode === mode;
                tab.classList.toggle('active', active);
                tab.setAttribute('aria-selected', String(active));
            });

            setIcon(ui.mainIcon, running ? 'fa-pause' : 'fa-play');
            ui.mainLabel.textContent = running ? 'Pause' : (rem < total ? 'Resume' : 'Start');
            ui.mainBtn.classList.toggle('is-running', running);
            setIcon(ui.pillPlayIcon, running ? 'fa-pause' : 'fa-play');
            setIcon(ui.pillIcon, MODES[mode].icon);
            ui.pillTask.textContent = currentTask;
            ui.pillTask.style.display = currentTask ? '' : 'none';

            renderDots();

            const dirty = rem !== total;
            trigger.classList.toggle('timer-running', running);
            trigger.classList.toggle('timer-paused', !running && dirty);

            document.title = running || dirty
                ? text + ' · ' + MODES[mode].label + ' · ' + BASE_TITLE
                : BASE_TITLE;
        }

        function renderDots() {
            const count = settings.cycle;
            if (ui.dots.childElementCount !== count) {
                ui.dots.innerHTML = '';
                for (let i = 0; i < count; i++) ui.dots.appendChild(el('span', 'pomo-dot'));
            }
            Array.from(ui.dots.children).forEach((dot, i) => {
                dot.classList.toggle('done', i < sessionsDone);
                dot.classList.toggle('current', mode === 'focus' && i === sessionsDone);
            });
        }

        function renderStats() {
            const day = stats[todayKey()] || { m: 0, s: 0 };
            const focused = day.m >= 60 ? Math.floor(day.m / 60) + 'h ' + (day.m % 60) + 'm' : day.m + 'm';
            const streak = computeStreak();
            ui.statsLine.textContent =
                day.s + (day.s === 1 ? ' session' : ' sessions') + ' today · ' +
                focused + ' focused · ' +
                streak + (streak === 1 ? ' day' : ' days') + ' in a row';
        }

        function syncSettingsInputs() {
            ui.inFocus.value = settings.focus;
            ui.inShort.value = settings.short;
            ui.inLong.value = settings.long;
            ui.inCycle.value = settings.cycle;
            ui.inAutoBreak.checked = settings.autoBreaks;
            ui.inAutoFocus.checked = settings.autoFocus;
            ui.inChime.checked = settings.sound;
            ui.volume.value = settings.volume;
            ui.presets.forEach((button) => {
                const preset = PRESETS[button.dataset.preset];
                const active = !!preset && preset.focus === settings.focus &&
                    preset.short === settings.short && preset.long === settings.long;
                button.classList.toggle('active', active);
                button.setAttribute('aria-pressed', String(active));
            });
        }

        // -----------------------------------------------------------------
        // Views, open/close and the floating pill
        // -----------------------------------------------------------------
        function showView(view) {
            const settingsView = view === 'settings';
            overlay.dataset.view = settingsView ? 'settings' : 'main';
            ui.viewMain.hidden = settingsView;
            ui.viewSettings.hidden = !settingsView;
            ui.back.hidden = !settingsView;
            ui.settingsBtn.hidden = settingsView;
            ui.settingsBtn.setAttribute('aria-expanded', String(settingsView));
            (settingsView ? ui.back : ui.settingsBtn).focus({ preventScroll: true });
        }

        function openModal() {
            overlay.classList.add('active');
            render();
            renderStats();
        }

        function closeModal() {
            overlay.classList.remove('active');
            if (overlay.dataset.view === 'settings') {
                overlay.dataset.view = 'main';
                ui.viewMain.hidden = false;
                ui.viewSettings.hidden = true;
                ui.back.hidden = true;
                ui.settingsBtn.hidden = false;
                ui.settingsBtn.setAttribute('aria-expanded', 'false');
            }
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

        // -----------------------------------------------------------------
        // Notifications, toasts, confetti
        // -----------------------------------------------------------------
        function requestNotificationPermission() {
            if (typeof Notification !== 'undefined' && Notification.permission === 'default') {
                try { Notification.requestPermission(); } catch (e) { /* older Safari */ }
            }
        }

        function notify(title, body) {
            if (typeof Notification === 'undefined' || Notification.permission !== 'granted') return;
            try {
                new Notification(title, { body, icon: '/static/logo.ico' });
            } catch (e) { /* notifications blocked */ }
        }

        function toast(message) {
            const node = el('div', 'pomo-toast');
            node.setAttribute('role', 'status');
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
            const colors = ['#F0913C', '#B4530A', '#F2F2EE', '#A8A8A0'];
            const parts = [];
            for (let i = 0; i < 110; i++) {
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
                if (t < 2400) requestAnimationFrame(frame);
                else canvas.remove();
            }
            requestAnimationFrame(frame);
        }

        // -----------------------------------------------------------------
        // Persistence
        // -----------------------------------------------------------------
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
                // Migrate the old v1 keys once.
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
                    settings,
                    stats,
                    // Legacy task-list data is kept intact though its UI is gone.
                    tasks: store.tasks,
                    runtime: { mode, running, endAt, remainingMs, sessionsDone, task: currentTask }
                }));
            } catch (e) { /* storage full or blocked */ }
        }

        function restoreRuntime() {
            const rt = store.runtime;
            if (!rt || !MODES[rt.mode]) return;
            mode = rt.mode;
            sessionsDone = clampNumber(rt.sessionsDone, 0, 12, 0);
            if (rt.running && rt.endAt > Date.now()) {
                running = true;
                endAt = rt.endAt;
                remainingMs = endAt - Date.now();
            } else if (rt.running && rt.endAt) {
                // The session finished while the page was closed: count it.
                if (mode === 'focus') {
                    const key = todayKey();
                    const day = stats[key] || { m: 0, s: 0 };
                    day.m += settings.focus;
                    day.s += 1;
                    stats[key] = day;
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

        // -----------------------------------------------------------------
        // Wiring
        // -----------------------------------------------------------------
        trigger.addEventListener('click', () => {
            if (overlay.classList.contains('active')) closeModal();
            else openModal();
        });

        overlay.addEventListener('click', (e) => {
            if (e.target === overlay) closeModal();
        });

        ui.closeBtn.addEventListener('click', closeModal);
        ui.settingsBtn.addEventListener('click', () => showView('settings'));
        ui.back.addEventListener('click', () => showView('main'));

        ui.tabs.forEach((tab) => {
            tab.addEventListener('click', () => {
                if (tab.dataset.mode !== mode) setMode(tab.dataset.mode);
            });
        });

        ui.mainBtn.addEventListener('click', () => (running ? pause() : start()));
        ui.resetBtn.addEventListener('click', reset);
        ui.skipBtn.addEventListener('click', () => advance(false));

        ui.presets.forEach((button) => {
            button.addEventListener('click', () => {
                const preset = PRESETS[button.dataset.preset];
                if (!preset) return;
                settings.focus = preset.focus;
                settings.short = preset.short;
                settings.long = preset.long;
                if (!running) remainingMs = currentDurationMs();
                persist();
                syncSettingsInputs();
                render();
            });
        });

        ui.taskInput.value = currentTask;
        ui.taskInput.addEventListener('input', () => {
            currentTask = ui.taskInput.value.trim();
            persist();
            ui.pillTask.textContent = currentTask;
            ui.pillTask.style.display = currentTask ? '' : 'none';
        });

        ui.soundOptions.forEach((option) => {
            option.addEventListener('click', () => playAmbient(option.dataset.sound));
        });

        ui.volume.addEventListener('input', () => {
            settings.volume = clampNumber(parseFloat(ui.volume.value), 0, 1, 0.7);
            if (ambient.gain && audioCtx) {
                ambient.gain.gain.cancelScheduledValues(audioCtx.currentTime);
                ambient.gain.gain.setTargetAtTime(settings.volume, audioCtx.currentTime, 0.05);
            }
            persist();
        });

        function applySettingsInputs() {
            settings.focus = clampNumber(parseInt(ui.inFocus.value, 10), 1, 120, settings.focus);
            settings.short = clampNumber(parseInt(ui.inShort.value, 10), 1, 60, settings.short);
            settings.long = clampNumber(parseInt(ui.inLong.value, 10), 1, 90, settings.long);
            settings.cycle = clampNumber(parseInt(ui.inCycle.value, 10), 2, 8, settings.cycle);
            settings.autoBreaks = ui.inAutoBreak.checked;
            settings.autoFocus = ui.inAutoFocus.checked;
            settings.sound = ui.inChime.checked;
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
        ui.inChime.addEventListener('change', () => {
            applySettingsInputs();
            if (settings.sound) chime('break-end');
        });

        ui.pillPlay.addEventListener('click', (e) => {
            e.stopPropagation();
            if (running) pause();
            else start();
        });
        pill.querySelector('.pomo-pill-close').addEventListener('click', (e) => {
            e.stopPropagation();
            hidePill();
        });
        pill.addEventListener('click', (e) => {
            if (!e.target.closest('button')) openModal();
        });

        // Keyboard shortcuts, only while the panel is open. Capture phase so the
        // canvas's space-to-pan handler never sees them.
        document.addEventListener('keydown', (e) => {
            if (!overlay.classList.contains('active')) return;
            if (document.body.classList.contains('planner-open') ||
                document.body.classList.contains('feature-tour-open')) return;
            const tag = e.target && e.target.tagName;
            const typing = tag === 'INPUT' && e.target.type !== 'range' && e.target.type !== 'checkbox';
            if (e.key === 'Escape') {
                e.stopPropagation();
                if (overlay.dataset.view === 'settings') showView('main');
                else closeModal();
                return;
            }
            if (typing || tag === 'TEXTAREA' || overlay.dataset.view === 'settings') return;
            if (e.key === ' ') {
                e.preventDefault();
                e.stopPropagation();
                if (running) pause();
                else start();
            } else if (e.key.toLowerCase() === 'r') {
                e.stopPropagation();
                reset();
            }
        }, true);

        window.addEventListener('beforeunload', persist);

        syncSettingsInputs();
        syncSoundOptions();
        renderStats();
        render();
        persist();
        if (running) {
            startTicking();
            showPill();
        } else if (remaining() !== currentDurationMs()) {
            showPill();
        }

        window.Inkyscib = window.Inkyscib || {};
        window.Inkyscib.Pomodoro = {
            open: openModal,
            close: closeModal,
            renderAmbient,
            SOUNDS: SOUNDS.map((sound) => sound.id)
        };
    }

    function setIcon(node, iconClass) {
        if (node && !node.classList.contains(iconClass)) {
            node.className = 'fas ' + iconClass;
        }
    }

    // ---------------------------------------------------------------------
    // Markup
    // ---------------------------------------------------------------------
    function buildModalHTML() {
        return '' +
        '<div class="pomo-panel" role="dialog" aria-labelledby="pomoTitle">' +
            '<div class="pomo-head">' +
                '<button class="pomo-icon-btn pomo-back" type="button" aria-label="Back to the timer" title="Back" hidden><i class="fas fa-arrow-left"></i></button>' +
                '<h2 class="pomo-title" id="pomoTitle">Focus timer</h2>' +
                '<button class="pomo-icon-btn pomo-settings-toggle" type="button" aria-label="Timer settings" aria-expanded="false" title="Settings"><i class="fas fa-cog"></i></button>' +
                '<button class="pomo-icon-btn pomo-close" type="button" aria-label="Close the timer" title="Close"><i class="fas fa-times"></i></button>' +
            '</div>' +

            '<div class="pomo-view pomo-view-main">' +
                '<div class="pomo-tabs" role="tablist" aria-label="Timer mode">' +
                    '<button class="pomo-tab" type="button" role="tab" data-mode="focus">Focus</button>' +
                    '<button class="pomo-tab" type="button" role="tab" data-mode="short">Break</button>' +
                    '<button class="pomo-tab" type="button" role="tab" data-mode="long">Long break</button>' +
                '</div>' +

                '<div class="pomo-stage">' +
                    '<svg class="pomo-ring" viewBox="0 0 240 240" aria-hidden="true">' +
                        '<circle class="pomo-ring-track" cx="120" cy="120" r="110"/>' +
                        '<circle class="pomo-ring-fill" cx="120" cy="120" r="110"/>' +
                    '</svg>' +
                    '<div class="pomo-stage-inner">' +
                        '<div class="pomo-time" role="timer">25:00</div>' +
                        '<div class="pomo-stage-mode">Focus</div>' +
                        '<div class="pomo-dots" aria-hidden="true"></div>' +
                    '</div>' +
                '</div>' +

                '<div class="pomo-controls">' +
                    '<button class="pomo-ctrl pomo-reset" type="button" title="Reset (R)" aria-label="Reset the timer"><i class="fas fa-rotate-left"></i></button>' +
                    '<button class="pomo-main" type="button" title="Start or pause (Space)"><i class="fas fa-play"></i><span>Start</span></button>' +
                    '<button class="pomo-ctrl pomo-skip" type="button" title="Skip to the next session" aria-label="Skip to the next session"><i class="fas fa-forward"></i></button>' +
                '</div>' +

                '<label class="pomo-task-row">' +
                    '<span class="pomo-visually-hidden">Current focus</span>' +
                    '<input class="pomo-task-input" type="text" maxlength="80" placeholder="What are you working on?">' +
                '</label>' +

                '<div class="pomo-sound">' +
                    '<div class="pomo-sound-options" role="group" aria-label="Focus sound">' +
                        SOUNDS.map((sound) =>
                            '<button class="pomo-sound-option" type="button" data-sound="' + sound.id + '" aria-pressed="false">' +
                                '<i class="fas ' + sound.icon + '"></i><span>' + sound.label + '</span>' +
                            '</button>'
                        ).join('') +
                    '</div>' +
                    '<label class="pomo-volume-row">' +
                        '<i class="fas fa-volume-up" aria-hidden="true"></i>' +
                        '<span class="pomo-visually-hidden">Volume</span>' +
                        '<input class="pomo-volume" type="range" min="0" max="1" step="0.05">' +
                    '</label>' +
                '</div>' +

                '<p class="pomo-stats-line"></p>' +
            '</div>' +

            '<div class="pomo-view pomo-view-settings" hidden>' +
                '<p class="pomo-settings-heading">Presets</p>' +
                '<div class="pomo-presets" role="group" aria-label="Presets">' +
                    Object.entries(PRESETS).map(([id, preset]) =>
                        '<button class="pomo-preset" type="button" data-preset="' + id + '" aria-pressed="false">' +
                            '<span>' + preset.label + '</span>' +
                            '<em>' + preset.focus + ' / ' + preset.short + ' / ' + preset.long + '</em>' +
                        '</button>'
                    ).join('') +
                '</div>' +
                '<p class="pomo-settings-heading">Minutes</p>' +
                '<div class="pomo-settings-grid">' +
                    '<label>Focus<input id="pomoFocusMin" type="number" min="1" max="120" inputmode="numeric"></label>' +
                    '<label>Break<input id="pomoShortMin" type="number" min="1" max="60" inputmode="numeric"></label>' +
                    '<label>Long break<input id="pomoLongMin" type="number" min="1" max="90" inputmode="numeric"></label>' +
                    '<label>Sessions per round<input id="pomoCycle" type="number" min="2" max="8" inputmode="numeric"></label>' +
                '</div>' +
                '<p class="pomo-settings-heading">Behaviour</p>' +
                '<label class="pomo-switch"><input id="pomoAutoBreak" type="checkbox"><span class="pomo-switch-track" aria-hidden="true"></span><span>Start breaks automatically</span></label>' +
                '<label class="pomo-switch"><input id="pomoAutoFocus" type="checkbox"><span class="pomo-switch-track" aria-hidden="true"></span><span>Start focus after a break</span></label>' +
                '<label class="pomo-switch"><input id="pomoChime" type="checkbox"><span class="pomo-switch-track" aria-hidden="true"></span><span>Chime when a session ends</span></label>' +
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
        '<button class="pomo-pill-close" type="button" aria-label="Hide the timer"><i class="fas fa-times"></i></button>' +
        '<span class="pomo-pill-bar" aria-hidden="true"><span></span></span>';
    }

    // ---------------------------------------------------------------------
    // Helpers
    // ---------------------------------------------------------------------
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

    function clampNumber(value, min, max, fallback) {
        if (isNaN(value)) return fallback;
        return Math.min(max, Math.max(min, value));
    }

    function pick(list) {
        return list[Math.floor(Math.random() * list.length)];
    }
})();
