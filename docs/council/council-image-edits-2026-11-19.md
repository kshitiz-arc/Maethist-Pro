# Council: which image edits to add (2026-11-19)

The owner asked for a picture of your own as the canvas background, with
blur (a slider), brightness, contrast, hue, saturation, crop "and more", and
for the same editing on pictures and YouTube frames on the page. They asked
for an LLM council to choose the "more". Five advisors answered on their
own. As with the ring council, there was no peer-review round: the verdict
below is the vote count and what the answers agreed on.

**Question.** Which additional edits are worth adding for students
annotating lecture frames, worksheets and photos of handwritten notes, ranked,
and what should not be built? The Edit sheet already had crop, rotate, flip,
presets (Scan, Board to paper, Mono, Vivid, Warm), brightness, contrast,
colour, opacity. The background repaints under live ink, so per-frame pixel
work is out; edits can be baked once.

## Count

| Edit | Contrarian | First Principles | Expansionist | Outsider | Executor |
|---|---|---|---|---|---|
| Sharpen | ✓ | ✓ | ✓ | ✓ | ✓ |
| Black and white (threshold or levels) | ✓ | ✓ | ✓ | ✓ | ✓ |
| Even out light (shadow removal) | ✓ | ✓ | ✓ | ✓ | ✓ |
| Perspective fix (4 corners) | ✓ | ✓ | ✓ | ✓ | later |
| Auto levels or auto-enhance | ✓ | ✓ | ✓ | ✓ | ✓ |
| Clear the paper (white to transparent) | ✓ | | ✓ | | |
| Background fade | | ✓ | ✓ | | |
| Hold to compare | ✓ | | | ✓ | |
| Fine straighten | ✓ | | | | |
| Hue | background only | background only | background only | never | ✓ |
| Blur | background only | | capped | never on a page photo | ✓ |

Not to build, said by three or more: curves, layers or masks, healing or
clone, AI upscaling or background removal, grain, vignette, filter packs,
per-frame live filters.

## Verdict, and what was built

- **Built:** Even out light, Auto levels, Sharpen, Black and white, Clear
  the paper, Straighten (±15°), Hue, Blur, and Hold to compare. They sit in two
  sections, "Light and colour" and "Clean up". The Scan preset became **Clean
  scan** (even light, levels, sharpen, grey), and a new **Ink only** preset
  keeps the ink and drops the paper. The background gets Fill, Fit or Tile,
  Fade, and an option to draw the grid over it.
- **How:** edits that need pixels are baked once by
  `static/js/image-process.js` into a canvas at 512, 1024 or 2048 px,
  whichever matches the size the picture is drawn at, and cached per picture.
  Drawing is one `drawImage`. The background is its own layer and is redrawn
  only when the view or the picture changes, never per pen sample. Hue stays a
  `ctx.filter`.
- **Not built yet:** perspective correction. Four of five advisors ranked it
  top or near it. It needs a four-corner drag UI and a projective warp, so it
  is a separate piece of work. Hue and blur were added for pictures on the
  page as well, because the owner asked for them there; the council would have
  kept them to the background.
