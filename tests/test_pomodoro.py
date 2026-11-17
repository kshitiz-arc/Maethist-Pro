"""The focus timer: simpler to use, and focus sounds that sound like something.

Reported: the panel was complicated, the rain did not sound like rain, the deep
sea sound was inaudible, and the settings icon did not look like settings.

Each of those is measured here rather than eyeballed:

- Loudness is taken through a tablet-speaker stand-in (three 500Hz high-pass
  stages and an 8kHz low-pass). A laptop or budget tablet speaker reproduces
  almost nothing below that, which is why the old deep sea sound - brown noise
  cut at 420Hz - measured fine on a full-range meter and was silent in use.
- "Sounds like rain" is taken as texture: rain is thousands of separate drops,
  so its loudness jumps around from one 10ms window to the next. The old rain
  was filtered static and barely moved.
- "Deep sea" is taken as swell: its loudness should rise and fall over seconds.
  The old one was flat.

The old sounds are rebuilt in the page from their original node graphs and
measured the same way in the same run, so every threshold is a comparison
with what was there before, not a number picked to pass.
"""

import threading
import unittest

from app import app
from browser_server import make_browser_server


try:
    from playwright.sync_api import sync_playwright

    PLAYWRIGHT_AVAILABLE = True
except ImportError:  # pragma: no cover - optional dependency
    PLAYWRIGHT_AVAILABLE = False


AUDIO_HELPERS = r"""
window.__audio = (() => {
  const SR = 44100;
  const SECONDS = 8;
  const VOLUME = 0.7;

  function oldNoise(ctx, brown) {
    const length = ctx.sampleRate * 2;
    const buffer = ctx.createBuffer(1, length, ctx.sampleRate);
    const data = buffer.getChannelData(0);
    let last = 0;
    for (let i = 0; i < length; i++) {
      const white = Math.random() * 2 - 1;
      if (brown) { last = (last + 0.02 * white) / 1.02; data[i] = last * 3.2; } else { data[i] = white; }
    }
    return buffer;
  }

  // The previous pomodoro.js graphs, copied verbatim.
  const OLD = {
    rain(ctx, out) {
      const gain = ctx.createGain(); gain.gain.value = VOLUME * 0.32; gain.connect(out);
      const src = ctx.createBufferSource(); src.buffer = oldNoise(ctx, false); src.loop = true;
      const low = ctx.createBiquadFilter(); low.type = 'lowpass'; low.frequency.value = 1150;
      const high = ctx.createBiquadFilter(); high.type = 'highpass'; high.frequency.value = 320;
      const lfo = ctx.createOscillator(); lfo.frequency.value = 0.11;
      const lfoGain = ctx.createGain(); lfoGain.gain.value = 260; lfo.connect(lfoGain); lfoGain.connect(low.frequency);
      src.connect(high); high.connect(low); low.connect(gain); src.start(); lfo.start();
    },
    deep(ctx, out) {
      const gain = ctx.createGain(); gain.gain.value = VOLUME * 0.32; gain.connect(out);
      const src = ctx.createBufferSource(); src.buffer = oldNoise(ctx, true); src.loop = true;
      const low = ctx.createBiquadFilter(); low.type = 'lowpass'; low.frequency.value = 420;
      src.connect(low); low.connect(gain); src.start();
    }
  };

  function speaker(ctx, input) {
    let node = input;
    for (let i = 0; i < 3; i++) {
      const high = ctx.createBiquadFilter(); high.type = 'highpass'; high.frequency.value = 500;
      node.connect(high); node = high;
    }
    const low = ctx.createBiquadFilter(); low.type = 'lowpass'; low.frequency.value = 8000;
    node.connect(low);
    return low;
  }

  async function renderOld(name, throughSpeaker) {
    const ctx = new OfflineAudioContext(1, SR * SECONDS, SR);
    const bus = ctx.createGain();
    (throughSpeaker ? speaker(ctx, bus) : bus).connect(ctx.destination);
    OLD[name](ctx, bus);
    return (await ctx.startRendering()).getChannelData(0);
  }

  async function renderNew(name, throughSpeaker) {
    const source = await window.Inkyscib.Pomodoro.renderAmbient(name, { seconds: SECONDS, sampleRate: SR, volume: VOLUME });
    const ctx = new OfflineAudioContext(1, SR * SECONDS, SR);
    const player = ctx.createBufferSource();
    player.buffer = source;
    (throughSpeaker ? speaker(ctx, player) : player).connect(ctx.destination);
    player.start();
    return (await ctx.startRendering()).getChannelData(0);
  }

  // The first second is skipped: filters and swells are still settling.
  function rmsDb(data) {
    let sum = 0;
    for (let i = SR; i < data.length; i++) sum += data[i] * data[i];
    return 20 * Math.log10(Math.sqrt(sum / (data.length - SR)) || 1e-9);
  }

  function peakDb(data) {
    let peak = 0;
    for (let i = SR; i < data.length; i++) peak = Math.max(peak, Math.abs(data[i]));
    return 20 * Math.log10(peak || 1e-9);
  }

  function variation(data, ms) {
    const window = Math.round(SR * ms / 1000);
    const envelope = [];
    for (let i = SR; i + window <= data.length; i += window) {
      let sum = 0;
      for (let j = 0; j < window; j++) sum += data[i + j] * data[i + j];
      envelope.push(Math.sqrt(sum / window));
    }
    const mean = envelope.reduce((a, b) => a + b, 0) / envelope.length;
    const sd = Math.sqrt(envelope.reduce((a, b) => a + (b - mean) ** 2, 0) / envelope.length);
    return sd / (mean || 1e-9);
  }

  return { renderOld, renderNew, rmsDb, peakDb, variation };
})();
"""


@unittest.skipUnless(PLAYWRIGHT_AVAILABLE, "Playwright is not installed")
class PomodoroTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.server = make_browser_server(app)
        cls.server_thread = threading.Thread(target=cls.server.serve_forever, daemon=True)
        cls.server_thread.start()
        cls.base_url = f"http://127.0.0.1:{cls.server.server_port}"
        cls.playwright = sync_playwright().start()
        cls.browser = cls.playwright.chromium.launch(headless=True)

    @classmethod
    def tearDownClass(cls):
        cls.browser.close()
        cls.playwright.stop()
        cls.server.shutdown()
        cls.server_thread.join(timeout=3)

    def open_page(self, viewport=None):
        context = self.browser.new_context(viewport=viewport or {"width": 960, "height": 720})
        self.addCleanup(context.close)
        page = context.new_page()
        page.set_default_timeout(15000)
        self.errors = []
        page.on("pageerror", lambda error: self.errors.append(str(error)))
        page.add_init_script("localStorage.setItem('inkyscib-consent-v1', JSON.stringify({version: 1, analytics: false})); localStorage.setItem('inkyscib-feature-tour-v1', 'seen')")
        page.goto(self.base_url + "/write", wait_until="domcontentloaded")
        page.wait_for_function("() => window.appState?.storageReady === true")
        page.wait_for_function("() => !!window.Inkyscib?.Pomodoro")
        return page

    def open_timer(self, page):
        # Transitions are switched off so computed styles show the end state.
        page.add_style_tag(content="*{transition:none!important;animation:none!important}")
        page.evaluate("() => window.Inkyscib.Pomodoro.open()")
        page.wait_for_function("() => document.getElementById('pomodoroModal').classList.contains('active')")

    def measure_sounds(self, page):
        page.evaluate("() => {" + AUDIO_HELPERS + "return true; }")
        return page.evaluate(
            """async () => {
              const a = window.__audio;
              const out = {};
              for (const [key, render, name] of [
                ['oldRain', a.renderOld, 'rain'], ['oldDeep', a.renderOld, 'deep'],
                ['rain', a.renderNew, 'rain'], ['deep', a.renderNew, 'deep'], ['clock', a.renderNew, 'clock']
              ]) {
                const full = await render(name, false);
                const small = await render(name, true);
                out[key] = { speakerDb: a.rmsDb(small), speakerPeakDb: a.peakDb(small),
                             texture: a.variation(full, 10), swell: a.variation(full, 500) };
              }
              return out;
            }"""
        )

    # ---------- the sounds ----------

    def test_focus_sounds_are_audible_matched_and_sound_like_what_they_say(self):
        page = self.open_page()
        m = self.measure_sounds(page)
        report = {k: {n: round(v, 3) for n, v in values.items()} for k, values in m.items()}

        self.assertLessEqual(
            abs(m["rain"]["speakerDb"] - m["deep"]["speakerDb"]), 2.0,
            f"rain and deep sea should play at the same loudness on a small speaker: {report}",
        )
        self.assertGreaterEqual(
            m["deep"]["speakerDb"], m["oldRain"]["speakerDb"] - 1.0,
            f"deep sea should be at least as audible as the old rain was: {report}",
        )
        self.assertGreaterEqual(
            m["deep"]["speakerDb"], m["oldDeep"]["speakerDb"] + 6.0,
            f"deep sea should be clearly louder than before on a small speaker: {report}",
        )
        self.assertGreaterEqual(
            m["rain"]["texture"], max(0.3, 2 * m["oldRain"]["texture"]),
            f"rain should be made of drops, not static: {report}",
        )
        self.assertGreaterEqual(
            m["deep"]["swell"], max(0.25, 5 * m["oldDeep"]["swell"]),
            f"deep sea should rise and fall: {report}",
        )
        self.assertGreaterEqual(m["clock"]["speakerPeakDb"], -20.0, f"the clock should be audible: {report}")
        self.assertEqual(self.errors, [])

    # ---------- the panel ----------

    def test_the_settings_button_is_a_gear(self):
        """The old icon was a circle with eight loose rays: a sun. Since 2.0.2
        the timer is a Phosphor surface and the button wears Phosphor's gear,
        drawn as one filled silhouette."""
        page = self.open_page()
        self.open_timer(page)
        icon = page.evaluate(
            """() => {
              const svg = document.querySelector('#pomodoroModal .pomo-settings-toggle svg');
              if (!svg) return null;
              return { cls: svg.getAttribute('class'), paths: svg.querySelectorAll('path').length,
                       circles: svg.querySelectorAll('circle').length,
                       stroke: getComputedStyle(svg.querySelector('path')).stroke };
            }"""
        )
        self.assertIsNotNone(icon, "the settings button should carry an icon")
        self.assertIn("icon-phosphor", icon["cls"])
        self.assertIn("icon-gear", icon["cls"])
        self.assertEqual(icon["paths"], 1, "one silhouette, not separate rays")
        self.assertEqual(icon["circles"], 0)
        self.assertEqual(icon["stroke"], "none", "a filled glyph, not an outline")
        self.assertEqual(self.errors, [])

    def visible(self, page, selector):
        return page.evaluate(
            """(selector) => [...document.querySelectorAll(selector)].filter(el => {
                 const style = getComputedStyle(el);
                 const box = el.getBoundingClientRect();
                 return style.display !== 'none' && style.visibility !== 'hidden' && box.width > 0 && box.height > 0;
               }).length""",
            selector,
        )

    def test_the_main_view_is_simple_and_the_rest_is_behind_the_gear(self):
        page = self.open_page()
        self.open_timer(page)
        panel = "#pomodoroModal .pomo-panel"

        main = {
            "tabs": self.visible(page, f"{panel} .pomo-tab"),
            "start": self.visible(page, f"{panel} .pomo-main"),
            "task": self.visible(page, f"{panel} .pomo-task-input"),
            "sounds": self.visible(page, f"{panel} .pomo-sound-option"),
            "volume": self.visible(page, f"{panel} .pomo-volume"),
            "presets": self.visible(page, f"{panel} .pomo-preset"),
            "durations": self.visible(page, "#pomoFocusMin"),
        }
        labels = page.evaluate(
            "() => [...document.querySelectorAll('#pomodoroModal .pomo-sound-option')].map(b => b.textContent.trim())"
        )

        page.click(f"{panel} .pomo-settings-toggle")
        settings = {
            "presets": self.visible(page, f"{panel} .pomo-preset"),
            "durations": self.visible(page, "#pomoFocusMin"),
            "start": self.visible(page, f"{panel} .pomo-main"),
        }
        page.click(f"{panel} .pomo-back")
        back = {
            "presets": self.visible(page, f"{panel} .pomo-preset"),
            "start": self.visible(page, f"{panel} .pomo-main"),
        }

        self.assertEqual(main, {"tabs": 3, "start": 1, "task": 1, "sounds": 4, "volume": 1,
                                "presets": 0, "durations": 0})
        self.assertEqual(labels, ["Off", "Rain", "Deep sea", "Clock"])
        self.assertEqual(settings, {"presets": 3, "durations": 1, "start": 0})
        self.assertEqual(back, {"presets": 0, "start": 1})
        self.assertEqual(self.errors, [])

    def test_every_control_is_a_real_touch_target_in_both_views(self):
        page = self.open_page()
        self.open_timer(page)
        measure = """() => [...document.querySelectorAll(
              '#pomodoroModal .pomo-panel button, #pomodoroModal .pomo-panel input:not([type=checkbox]), #pomodoroModal .pomo-panel label.pomo-switch')]
            .filter(el => { const s = getComputedStyle(el); const b = el.getBoundingClientRect();
                            return s.display !== 'none' && s.visibility !== 'hidden' && b.width > 0 && b.height > 0; })
            .map(el => { const b = el.getBoundingClientRect();
                         return { what: el.className || el.id || el.tagName, width: Math.round(b.width), height: Math.round(b.height) }; })
            .filter(item => item.width < 44 || item.height < 44)"""
        small_main = page.evaluate(measure)
        page.click("#pomodoroModal .pomo-settings-toggle")
        small_settings = page.evaluate(measure)
        self.assertEqual(small_main, [], "main view controls under 44px")
        self.assertEqual(small_settings, [], "settings view controls under 44px")
        self.assertEqual(self.errors, [])

    def test_one_accent_in_every_mode(self):
        """Break and long break used to repaint the panel green and amber.
        In v3 the mode's own hue lives on the clock only; what you press stays
        the one brand yellow in every mode."""
        page = self.open_page()
        self.open_timer(page)
        colours = page.evaluate(
            """() => {
              const probe = document.createElement('span');
              probe.style.color = 'var(--brand-yellow)';
              document.body.appendChild(probe);
              const accent = getComputedStyle(probe).color;
              probe.remove();
              const out = { accent };
              for (const mode of ['focus', 'short', 'long']) {
                document.querySelector(`#pomodoroModal .pomo-tab[data-mode="${mode}"]`).click();
                out[mode] = getComputedStyle(document.querySelector('#pomodoroModal .pomo-main')).backgroundColor;
              }
              return out;
            }"""
        )
        for mode in ("focus", "short", "long"):
            self.assertEqual(colours[mode], colours["accent"], f"{mode}: {colours}")
        self.assertEqual(self.errors, [])

    def test_the_timer_still_starts_pauses_resets_and_skips(self):
        page = self.open_page()
        self.open_timer(page)
        read = "() => ({ time: document.querySelector('#pomodoroModal .pomo-time').textContent, " \
               "label: document.querySelector('#pomodoroModal .pomo-main').textContent.trim(), " \
               "mode: document.getElementById('pomodoroModal').dataset.mode, " \
               "pill: getComputedStyle(document.getElementById('floatingTimer')).display })"
        fresh = page.evaluate(read)
        page.click("#pomodoroModal .pomo-main")
        page.wait_for_timeout(1300)
        running = page.evaluate(read)
        page.click("#pomodoroModal .pomo-main")
        paused = page.evaluate(read)
        page.click("#pomodoroModal .pomo-reset")
        reset = page.evaluate(read)
        page.click("#pomodoroModal .pomo-skip")
        skipped = page.evaluate(read)

        self.assertEqual(fresh["time"], "25:00")
        self.assertEqual(fresh["mode"], "focus")
        self.assertNotEqual(running["time"], "25:00", "the clock should be counting down")
        self.assertIn("Pause", running["label"])
        self.assertNotEqual(running["pill"], "none", "the floating pill shows while running")
        self.assertIn("Resume", paused["label"])
        self.assertEqual(reset["time"], "25:00")
        self.assertEqual(skipped["mode"], "short")
        self.assertEqual(self.errors, [])


    # ---------- the Sound studio ----------

    def test_the_studio_offers_noise_wind_down_and_focus_frequencies(self):
        page = self.open_page()
        self.open_timer(page)
        page.click("#pomodoroModal .pomo-sounds-open")
        page.wait_for_selector("#pomodoroModal .pomo-view-sounds:not([hidden])")
        found = page.evaluate(
            """() => ({
              beds: [...document.querySelectorAll('#pomodoroModal .pomo-bed')].map(b => b.dataset.sound),
              tones: [...document.querySelectorAll('#pomodoroModal .pomo-tone')].map(b => b.dataset.tone),
              title: document.querySelector('#pomodoroModal .pomo-title').textContent,
              note: document.querySelector('#pomodoroModal .pomo-studio-note').textContent,
              mainHidden: document.querySelector('#pomodoroModal .pomo-view-main').hidden
            })"""
        )
        self.assertEqual(found["beds"], ["rain", "deep", "clock", "white", "pink", "brown", "winddown"])
        self.assertEqual(found["tones"], ["off", "delta", "theta", "alpha", "beta", "gamma", "custom"])
        self.assertEqual(found["title"], "Sound studio")
        self.assertIn("not a treatment", found["note"])
        self.assertTrue(found["mainHidden"])
        page.keyboard.press("Escape")
        self.assertFalse(page.evaluate("() => document.querySelector('#pomodoroModal .pomo-view-main').hidden"))
        self.assertEqual(self.errors, [])

    def test_every_studio_control_is_a_real_touch_target(self):
        for width, height in ((960, 720), (375, 812)):
            with self.subTest(width=width):
                page = self.open_page({"width": width, "height": height})
                self.open_timer(page)
                page.click("#pomodoroModal .pomo-sounds-open")
                small = page.evaluate(
                    """() => [...document.querySelectorAll(
                          '#pomodoroModal .pomo-view-sounds button, #pomodoroModal .pomo-view-sounds input:not([type=checkbox]), #pomodoroModal .pomo-view-sounds label.pomo-switch')]
                        .map(el => ({ what: el.className || el.id, b: el.getBoundingClientRect() }))
                        .filter(({ b }) => b.width > 0 && (b.width < 44 || b.height < 44))
                        .map(({ what, b }) => what + ' ' + Math.round(b.width) + 'x' + Math.round(b.height))"""
                )
                self.assertEqual(small, [])
                self.assertLessEqual(page.evaluate("() => document.documentElement.scrollWidth"), width)

    def test_new_beds_are_levelled_like_the_old_ones_and_never_clip(self):
        page = self.open_page()
        levels = page.evaluate(
            """async () => {
              const out = {};
              for (const id of ['rain', 'white', 'pink', 'brown', 'winddown']) {
                const buffer = await window.Inkyscib.Pomodoro.renderAmbient(id, { seconds: 4, volume: 0.7 });
                let peak = 0, sum = 0, n = 0;
                for (let c = 0; c < buffer.numberOfChannels; c++) {
                  const d = buffer.getChannelData(c);
                  for (let i = 0; i < d.length; i++) { const a = Math.abs(d[i]); if (a > peak) peak = a; sum += d[i] * d[i]; n++; }
                }
                out[id] = { peak, db: 20 * Math.log10(Math.sqrt(sum / n)) };
              }
              return out;
            }"""
        )
        for bed in ("white", "pink", "brown", "winddown"):
            with self.subTest(bed=bed):
                self.assertLess(levels[bed]["peak"], 0.95, levels)
                self.assertGreater(levels[bed]["db"], -30, levels)
                self.assertLess(levels[bed]["db"], -12, levels)

    def test_wind_down_swells_on_a_ten_second_breath(self):
        page = self.open_page()
        swing = page.evaluate(
            """async () => {
              const buffer = await window.Inkyscib.Pomodoro.renderAmbient('winddown', { seconds: 10 });
              const d = buffer.getChannelData(0), win = Math.round(buffer.sampleRate * 0.5);
              const rms = [];
              for (let i = 0; i + win <= d.length; i += win) {
                let s = 0; for (let j = i; j < i + win; j++) s += d[j] * d[j];
                rms.push(Math.sqrt(s / win));
              }
              const peakAt = rms.indexOf(Math.max(...rms)) * 0.5;
              return { ratio: Math.max(...rms) / Math.min(...rms), peakAt };
            }"""
        )
        self.assertGreater(swing["ratio"], 2.5, swing)
        self.assertGreaterEqual(swing["peakAt"], 3.0, swing)
        self.assertLessEqual(swing["peakAt"], 5.0, swing)

    def test_frequencies_play_binaural_or_as_a_pulse_and_follow_the_timer(self):
        page = self.open_page()
        self.open_timer(page)
        page.click("#pomodoroModal .pomo-sounds-open")
        page.click('#pomodoroModal .pomo-tone[data-tone="gamma"]')
        gamma = page.evaluate("() => window.Inkyscib.Pomodoro.soundState()")
        page.click('#pomodoroModal .pomo-tone-mode[data-tone-mode="pulse"]')
        pulse = page.evaluate("() => window.Inkyscib.Pomodoro.soundState()")
        page.evaluate(
            """() => { const r = document.getElementById('pomoToneHz'); r.value = '7.5';
                       r.dispatchEvent(new Event('input', { bubbles: true })); }"""
        )
        custom = page.evaluate("() => window.Inkyscib.Pomodoro.soundState()")
        page.click("#pomodoroModal label.pomo-switch:has(#pomoFocusOnly)")
        gated = page.evaluate("() => window.Inkyscib.Pomodoro.soundState().gateOpen")
        page.click("#pomodoroModal .pomo-back")
        page.click("#pomodoroModal .pomo-main")
        focusing = page.evaluate("() => window.Inkyscib.Pomodoro.soundState().gateOpen")
        page.click('#pomodoroModal .pomo-tab[data-mode="short"]')
        on_break = page.evaluate("() => window.Inkyscib.Pomodoro.soundState().gateOpen")
        page.evaluate("() => window.Inkyscib.Pomodoro.playTone('off')")

        self.assertEqual((gamma["tone"], gamma["hz"], gamma["mode"], gamma["toneNodes"]), ("gamma", 40, "binaural", 2))
        self.assertEqual((pulse["mode"], pulse["toneNodes"]), ("pulse", 2))
        self.assertEqual((custom["tone"], custom["hz"]), ("custom", 7.5))
        self.assertFalse(gated, "only-while-focusing should hold sound while the timer is idle")
        self.assertTrue(focusing)
        self.assertFalse(on_break)
        self.assertEqual(self.errors, [])

    def test_nothing_plays_on_load(self):
        """A page may not start sound by itself, and a stored choice must not
        try: the studio always opens silent."""
        page = self.open_page()
        state = page.evaluate("() => window.Inkyscib.Pomodoro.soundState()")
        self.assertEqual((state["bed"], state["tone"], state["toneNodes"]), ("off", "off", 0))


if __name__ == "__main__":
    unittest.main()
