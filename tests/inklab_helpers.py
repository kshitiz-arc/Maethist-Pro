"""Shared pieces of the InkLab browser tests."""

import io
import time

from PIL import Image


# Pushes a straight stroke into the page's ring through the test seam, exactly
# as the pointer handlers would, then wakes the worker once.
INJECT_STROKE = """
({ from, to, moves, stepMs, predictedEvery, predictedOffset, finish }) => {
  const lab = window.InkLab.lab;
  const { Flags } = window.InkLab.RingBuffer;
  const t0 = performance.now();
  const at = (k) => ({
    x: from[0] + (to[0] - from[0]) * k / moves,
    y: from[1] + (to[1] - from[1]) * k / moves
  });
  lab.pushSample({ ...at(0), pressure: 0.5, time: t0, flags: Flags.DOWN });
  for (let k = 1; k <= moves; k++) {
    lab.pushSample({ ...at(k), pressure: 0.5, time: t0 + k * stepMs, flags: Flags.MOVE });
    if (predictedEvery && k % predictedEvery === 0) {
      for (let p = 1; p <= 3; p++) {
        const point = at(Math.min(moves, k + p));
        lab.pushSample({
          x: point.x, y: point.y + predictedOffset, pressure: 0.5,
          time: t0 + (k + p) * stepMs, flags: Flags.PREDICTED
        });
      }
    }
  }
  if (finish) {
    lab.pushSample({ ...at(moves), pressure: 0.5, time: t0 + (moves + 1) * stepMs, flags: Flags.UP });
  }
  lab.notify();
}
"""


def stroke(predicted_every=0, predicted_offset=0, finish=True):
    """A 300 CSS px stroke of 40 moves, 8 ms apart."""
    return {
        "from": [100, 300],
        "to": [400, 320],
        "moves": 40,
        "stepMs": 8,
        "predictedEvery": predicted_every,
        "predictedOffset": predicted_offset,
        "finish": finish,
    }


def snapshot_until(testcase, page, predicate, timeout=5.0):
    """Polls the worker's snapshot until `predicate` holds.

    The ring is drained on animation frames, not when a sample is pushed, so a
    stroke lands a frame or two after the samples do."""
    deadline = time.monotonic() + timeout
    snapshot = None
    while time.monotonic() < deadline:
        snapshot = page.evaluate("() => window.InkLab.lab.snapshot()")
        if predicate(snapshot):
            return snapshot
        page.wait_for_timeout(50)
    testcase.fail(f"the snapshot never reached the expected state; last one was {snapshot}")


# A box around the stroke `stroke()` draws, from (100, 300) to (400, 320), with a
# margin. CSS px, as page.screenshot takes it.
STROKE_CLIP = {"x": 90, "y": 285, "width": 320, "height": 50}

# Lifts the pen at the end of `stroke(finish=False)`.
FINISH_STROKE = """
() => {
  const lab = window.InkLab.lab;
  const { Flags } = window.InkLab.RingBuffer;
  lab.pushSample({ x: 400, y: 320, pressure: 0.5, time: performance.now(), flags: Flags.UP });
  lab.notify();
}
"""


def ink_pixels(page, clip=STROKE_CLIP, difference=96):
    """Counts pixels in `clip` that differ sharply from its top-left pixel, which
    is taken as the background - so it works in either theme.

    It reads a screenshot: what the browser actually composited on screen, not
    what the worker believes it drew."""
    image = Image.open(io.BytesIO(page.screenshot(clip=clip))).convert("RGB")
    pixels = list(image.getdata())
    background = pixels[0]
    return sum(
        1
        for pixel in pixels
        if max(abs(channel - base) for channel, base in zip(pixel, background)) > difference
    )


def assert_stroke_reaches_the_screen(testcase, page):
    """Every other test measures the worker's baked layer. This reads the screen,
    through both present paths: the live stroke drawn over the baked layer while
    the pen is down, and the baked layer alone once it is lifted.

    A present step that drew nothing fails here - including, on WebGPU, one that
    failed validation, which throws no exception and would otherwise go unseen."""
    testcase.assertEqual(ink_pixels(page), 0, "the canvas should start blank")

    page.evaluate(INJECT_STROKE, stroke(finish=False))
    # DOWN plus 40 moves, all committed and still being drawn.
    snapshot_until(testcase, page, lambda s: s["activeSamples"] == 41)
    page.wait_for_timeout(150)
    testcase.assertGreater(
        ink_pixels(page), 150, "a stroke still being drawn did not reach the screen"
    )

    page.evaluate(FINISH_STROKE)
    snapshot_until(testcase, page, lambda s: s["finishedStrokes"] == 1)
    page.wait_for_timeout(150)
    testcase.assertGreater(ink_pixels(page), 150, "a finished stroke did not reach the screen")
