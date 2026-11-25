# Changelog

## 2.8.5 — 2026-11-25

### Fixed

- **The ring no longer opens while you are writing.** With the hold at a
  flat 0.45s, resting the pen between letters or words opened the ring in
  the middle of a sentence. The hold now reads what you are doing:
  - **While writing** (a stroke lifted in the last 1.5s), it takes 0.35s
    longer than usual, longer than any pause between words.
  - **By pointer:** a mouse 0.45s, a finger 0.55s, a stylus 0.6s.
  - **No flash on short pauses:** the charge only appears after the first
    third of the hold.
  - **A stylus that drifts more than 6px** is handwriting, not a hold.

  A deliberate hold still opens it, as before.


## 2.8.4 — 2026-11-25

### Changed

- **No line from the ring's centre to a slice.** The glowing needle that
  swung to the slice you point at is gone. The slice still grows and locks
  on, and the readout under the ring still names it.
- **Tool panels, tidied in the app's own style.** Every toggle and choice
  button now uses one label style (Space Grotesk, sentence case) on one
  line. Before, some chips were tiny heavy capitals that wrapped mid-name
  ("NAME THE / ENDS", "SHOW / SWEEP") beside plain-text buttons. The More
  cue is now a small chevron in the panel's corner instead of a labelled
  pill on top of the controls, and it fades once you have scrolled the
  panel, so it no longer sits over the bottom row while you work.
  `static/css/panel-tidy.css`
- **Easier to read, measured.**
  - Hints were 9.76px; they are now 12px (the scale's smallest step) in one
    style everywhere. One Compass hint had been plain black.
  - "Off" toggle chips read at 4.13:1 on the light theme, under AA, and
    looked disabled. They are now 6.96:1.
  - Some number fields fell back to Arial with uneven digits. All now use
    the mono with tabular figures, as the design rules ask.
  - The tool's name is one step larger, so each panel has a clear top.

### Fixed

- **A double tap from Select no longer opens the search.** The double tap
  that returns to the pen also opened the command search, a 2.7.1 addition
  copied from ComfyUI. The double tap is the pen's alone now; Ctrl+K and
  "/" still search.


## 2.8.3 — 2026-11-24

### The hold ring, faster and smoother

- **It opens in 0.45s instead of 0.7s**, and the charge shows from 80ms, so
  the hold reads almost at once.
- **No more jitter on the way out.** Three causes, all fixed: a spring
  easing on every keyframe made each slice overshoot two or three times; a
  transition on the open slices outranked the pop in the cascade and
  hijacked its first 140ms; and eight backdrop blurs were redrawn every
  frame. Now each slice is one spring from the centre to its place, moving
  only transform and opacity, and there is a single blur.
- **A new look: a HUD lock-on.** The flat yellow circle is gone. Holding
  charges a glass orb inside a turning tick track, its rim filling blue to
  violet to yellow while four yellow brackets spin in and close onto the
  point. When it fires, a shockwave and anime speed lines burst out, and a
  glass plate blooms behind the slices. The plate is deep navy on the dark
  theme and frosted white on the light one. It has a turning tick ring, a
  track the slices ride on, and a sheen that runs once round its rim.
  Outside it, HUD arcs and a yellow satellite orbit in opposite directions,
  and a segmented ring turns round the mark. Each slice lands with an
  impact ring.
- **Pointing is shown.** A glowing needle swings from the mark to the slice
  you point at, always the short way round. That slice grows and locks on
  with a turning dashed ring. A cut-corner readout under the ring says what
  is in hand ("IN HAND ▸ PEN") and, while you point, what you would pick
  ("PICK ▸ LINE").
- **The first open is as smooth as the rest.** Building the ring and
  preparing its layers used to cost about half a second on the first hold.
  That now happens once while the page is idle. The HUD rings are SVG
  drawn once and then only turned, which measured faster than masked
  gradients, and the readout has no blur of its own.
- **Slices swing out on true arcs.** They turn along the circle as they
  grow out from the centre, not in a straight line with a bend.
- **Hover grows a slice again.** The pop had pinned every slice at its
  resting size for good, so the hover growth never showed. And a slice no
  longer stays lit when it swept under a still cursor on the way out.
- The slices are drawn while the charge runs, and the redraw that throws
  away the press's dot waits one frame, so opening the ring does no other
  work.

### Smart eraser

- **After a quick fix, the pen comes back on its own.** Pick the eraser
  while writing (from the ring, the rail or E), erase, and pause for 1.2s:
  the pen or highlighter you were using is back for your next stroke,
  without its panel opening. A chip beside the erased spot counts the pause
  down and has a **Keep eraser** button.
- **Erasing all over the page keeps the eraser.** A stroke more than 30% of
  the screen's diagonal from everything erased so far counts as a clean-up,
  not a fix, and the eraser stays until you change tool. So does an eraser
  picked from a tool other than the pen or highlighter.
- The eraser panel has a switch for it, **Back to pen** or **Stay eraser**,
  kept with the rest of the eraser's settings.


## 2.8.2 — 2026-11-24

### Fixed

- **The File and Tools sheet stayed on screen after closing.** Its grow-in
  animation (2.8.1) held it fully opaque over the fade-out. It now plays
  only while the sheet is open.
- **No more line under the buttons.** The header's Home, Features and About
  pills still carried the underline from when they were plain text links: a
  1px bar across the bottom of the current page's pill and on hover. The
  editor's logo tile showed the browser's own link underline. Both are gone;
  text links in the footer and legal pages keep their hover underline.

### Removed (cleanup)

- The tiled-pattern renderer in canvas.js (`__makeTile`, `__getPatternFill`
  and its cache, also left on `window`): the grid has been drawn by
  `__drawInfinitePattern` for some time and nothing called them.
- An unused helper in the selection tool (`companionEraserIndices`).
- CSS that later rules fully override: the frosted bars (replaced by solid
  bars in 2.7.1), About's first name and lead-line styles, an unused
  `.editor-footer` selector.


## 2.8.1 — 2026-11-24

### Motion and interaction principles

Nineteen principles, asked for by name, each written into DESIGN.md with a
rule for MAETHIST and where it lives. What you will notice:

- **Every press has weight.** A button squashes into its shadow the moment
  you touch it and stretches a little past rest as you let go (anticipation,
  squash and stretch, follow-through). A quick second press interrupts it.
- **Things come from somewhere.** The Canvas popover grows out of its
  button, the File and Tools sheet out of its tab, a tooltip out of the side
  facing its control (origin awareness).
- **Sets arrive in order.** Search results, the File and Tools commands and
  a day's tasks come in one after another (staggering).
- **The quick ring** sweeps its tools out along an arc, its centre gathers
  before it lands, and closing pulls them back in, which opening again can
  interrupt.
- **The YouTube player rubber-bands** when dragged past the edge of the
  screen, and springs back.
- **Ctrl+K learns.** What you run most is listed first, under Frequent
  (frequency of use; counted in this browser only).
- **Small rewards.** Ticking a task pops the tick while its bar fills, the
  streak jumps when it grows, and a finished job's chip pops its check
  (secondary action, exaggeration, peak-end).
- The ink, the canvas and the instruments still never move by themselves,
  and everything stops under reduced motion.

### Fixed

- Ctrl+K did nothing while a tool panel's field had focus (the compass
  radius, for one): the field kept the key to itself.


## 2.8.0 — 2026-11-19

### The Planner, overhauled

Neo-brutal like the rest of the app, with the features an LLM council chose
for students revising maths (`docs/council/council-planner-2026-11-19.md`).

- **Focus from a task.** Every open task has a Focus button: it starts the
  focus timer for that task, and when the session ends its minutes are logged
  against the task ("25 min focused") and the day.
- **Exams that count down.** Add a test or board paper with its date; it
  counts the days and turns red inside a week. List the chapters to revise,
  or fill in a whole class's CBSE chapters (9, 10, 11 or 12) with one tap, and
  the Planner spreads one "Revise:" task per chapter over the days before it.
- **Streak and This week.** How many days in a row you have finished
  something, and the seven days of this week with how much of each is done,
  the week's totals and its focus time. Tap a day to open it.
- **Topic and notebook on a task.** Tag a task with its chapter (the CBSE
  chapters are suggested) and link it to a notebook; Open notebook takes you
  straight there.
- **Back up and Restore** the whole plan as a file. Restore only adds what is
  missing, so it never duplicates.
- **The look:** ink outlines, hard shadows, a yellow primary, striped
  progress, chapter chips in blue, focus in green, the exam that is close in
  red; big display numbers; 44px targets on a tablet.

Plans saved before 2.8.0 open unchanged.

### Fixed

- Image to text: the result box ran past the right edge of its sheet.


## 2.7.1 — 2026-11-19

### Added

- **Search everything with Ctrl+K** (or "/", or a double-click on empty
  canvas with Select). One box over every tool and every File, Insert,
  Export and Tools command, each with its key; type a few letters in order
  ("imtx" finds Image to text), arrows to move, Enter to run. After
  shadcn/ui's Command and ComfyUI's double-click search.
- **"?" opens the keyboard shortcuts**, grouped into Tools, Edit, View and
  Touch and pen.
- **Tooltips that say the key.** Hover a tool, or reach it with the
  keyboard, and a label shows its name and shortcut. It replaces the
  browser's own title bubble, which was slow, never showed on keyboard focus
  and never named the key. Moving along a toolbar, the next one opens at once.
- **Move the background picture.** Canvas, then Picture, then Move: drag to
  place it against the grid (shown while you place it), scroll or pinch to
  size it, then Done. Esc puts it back.
- **Drag the whole triangle** in the homepage demo, not just its corners.
- **Frame quality: HD or MAX.** Video frames come in HD (1080p) by default,
  which is quick. The HD button beside the camera turns to MAX: every frame
  after that is the best the video has, up to 4K. The choice is remembered.
- **The quick ring has the MAETHIST mark at its centre**, on its paper tile.

### Changed

- **Sora Sketch** is the new name for AR MAETHIST (*sora*: sky).
- **Files are `.maedoc` and `.mae`.** A document saved from MAETHIST is now a
  `.maedoc` (was `.inkydoc`), and a library backup a `.mae` (was `.inky`).
  Files in the old formats no longer open.
- The homepage construction draws itself in about a second (it took three)
  and gives way at once if you grab it.
- **About: new type.** The name is a large Bricolage Grotesque whose letters
  rise in; the lead line is bigger, with "a way of seeing" in an Instrument
  Serif italic over a marker stroke that draws in; the bio is a size up and
  darker. Both fonts are self-hosted (SIL Open Font License).
- About: 600+ students taught, and 180+ faculty in one session on his
  Institutional Solver.

### Fixed

- **Room under the bars.** The File and Tools sheets, the Canvas popover,
  tool panels and the YouTube player all opened against the bottom of the
  ribbon. Each now sits 14px clear of the bar it opens from, on a laptop and
  a tablet.
- **"Start writing" no longer opens the Pen panel.** The pen is in hand; its
  panel waits until you ask for it.
- **The homepage altitude stops in mid-air no more.** With A dragged past B
  or C, the foot of the perpendicular falls on BC produced, beyond the
  triangle; that part of the line is now drawn, dashed, as in a textbook.
- The homepage and the privacy policy still said video frames come in 4K;
  since 2.7.0 they are up to 1080p ("HD lecture frames").
- The pen size box had no label for a screen reader, the footer links were
  under the 24px minimum target size, and three controls showed no focus
  ring.


## 2.7.0 — 2026-11-19

### Fixed

- **Writing is instant again.** Closed panels were still blurring what was
  under them: the File sheet's backdrop and the Clear dialog, both full
  screen, the focus timer, plus the frosted top bar and tool rail. A
  backdrop blur is redrawn whenever the page under it changes, which while
  writing is every pen sample. Nothing over the canvas is frosted now; a
  sheet or dialog is frosted only while it is open.

### Added

- **Hide the tool rail.** A button beside Home in the ribbon hides the
  left tool rail completely, so the page gets the full width, and brings
  it back. On a tablet it hides the tool row instead. The choice is
  remembered on the device.
- **Hold for the quick ring.** Press and hold still on the page for 0.7s
  and a ring of the eight most-used tools pops open around the pointer:
  Pen, Colour, Line, Eraser, Select, Pan, Redo and Undo, clockwise from the
  top. An LLM council chose them
  (`docs/council/council-quick-ring-2026-11-19.md`). An arc fills from
  0.2s, so the hold is visible. Moving, a second finger or lifting early
  cancels it, and the press leaves no mark. Still holding, slide toward a
  tool and let go to pick it; or lift and tap one. A tap anywhere off the
  ring, or Esc, closes it without drawing. Colour opens a ring of the pen's
  swatches. The ring is not armed for the eraser or the compass, which
  already use a long press of their own.
- **Image to text** (Tools, or Convert to text in a picture's More menu).
  Drag a box around writing on the page, or pick a photo, and it is read
  into text you can edit: equations as LaTeX (Pix2Text MFR 1.5) and
  handwriting as plain text (TrOCR). Copy the result, or place it on the
  page as a card in the pen colour, with the LaTeX written out readably
  (x², √(x+1), (a+b)/2, 60°). The models run on this server: the image is
  read in memory, then dropped, and never goes to another company. The bar
  that says what to do sits under the toolbars, where it can be seen. An
  empty box is refused, because the equation reader answers a blank picture
  with nonsense. A server without the optional models
  (`requirements-ocr.txt`) says so as soon as the tool opens.
- **A picture of your own as the canvas background.** In the Canvas
  popover, beside the themes and grids: Use a picture, from the device.
  It stays in this browser. Edit it in the same sheet as pictures on the
  page, with Fill, Fit or Tile, Fade (washes it toward the canvas colour,
  so ink stays readable), and the grid over it or not. It is drawn on its
  own layer, so it costs nothing while you write.
- **More image edits**, for pictures, video frames and the background,
  chosen by an LLM council (`docs/council/council-image-edits-2026-11-19.md`):
  Even out light (removes a phone's shadow across a page), Auto levels,
  Sharpen, Black and white, Clear the paper (the paper goes transparent and
  the ink stays), Straighten (±15°), Hue and Blur, and Hold to compare
  against the original. Scan is now **Clean scan** (even light, levels,
  sharpen, grey), and **Ink only** is new. These edits are baked once into a
  bitmap at the size the picture is shown, never redone per frame.
- **Sora Sketch** (was AR Inky). Pinch thumb and finger to draw in the air,
  open them to lift the pen, where "index finger up" used to draw a line every
  time you moved to start somewhere new. A bar shows what the camera sees
  ("Show your hand", "Pinch to draw", "Drawing") and holds Undo, Dim the
  camera and Exit; Esc exits too. Before this, once AR was on there was no
  visible way out.

### Changed

- **YouTube frames import much faster.** YouTube's own preview of the
  moment goes on the page at once, and the full frame replaces it in place
  when it arrives. Frames are cut at up to 1080p (was 4K) from the stream
  that decodes fastest (H.264, 30 fps). `YOUTUBE_FRAME_MAX_HEIGHT=2160`
  brings 4K back. The "Importing YT frame" chip has a Stop button.

### Fixed (AR)

- The finger dot sat beside the finger: the camera picture is cropped to
  fill the screen, and the mapping ignored the crop.
- One dropped camera frame stopped hand tracking for good.
- Jitter. A One Euro filter now smooths hard while the hand is still and
  hardly at all while it moves.

### Privacy

- The privacy policy, the data map and the retention notes describe where
  an image you convert goes, and that a background picture is kept only in
  this browser (the database `inkyscib_background`, which Export and Erase
  everything now include).
- **jsDelivr is now listed.** AR has always fetched its hand-tracking library
  from jsDelivr when started, and the policy never said so. The third-party
  table now names it. The camera picture never leaves the device.


## 2.6.0 — 2026-11-18

### Changed

- **Every panel is one card.** About, Features, legal pages and the
  homepage (principles, how-it-works, accessibility, stats, bento tiles,
  steps) share the Recent writing look: an ink outline, rounded corners, a
  hard offset shadow, a colour band along the top cycling yellow, blue, red
  and green, and frosted glass over the colour field. Only link cards lift
  on hover.
- **About: a new bio.** It opens with a lead line, "Mathematics, to him, is
  not a subject. It is a way of seeing.", followed by three paragraphs on
  what he teaches and studies, why he builds instruments that look past the
  answer, and what MAETHIST is for.
- **About: "Starting is the heaviest rep."** sits under the name in
  handwritten marker (Gochi Hand, self-hosted) on a strip of dark ruled
  paper with an orange margin, with an orange brush stroke swept behind
  "heaviest rep".


## 2.5.3 — 2026-11-18

### Removed (cleanup review)

- Files nothing loads: `static/css/style.css` (38 KB, the pre-v2
  stylesheet), `static/js/home.js` and `static/js/fx.js` (12 KB, the old
  homepage scripts), `DESIGN.md.bak`, and the `design/editor-chrome/`
  prototypes from the editor-chrome exploration.
- 131 CSS rules and selectors, about 13 KB, styling classes that no
  template or script uses any more: the old signature footer, the menu
  overlay and hamburger, the toolbar-location toggle, the pattern popover,
  old hero and HUD pieces, compass hex input, line-kind buttons and
  others. Rules shared with live selectors kept those selectors.
- `search_youtube()` in app.py, an unused wrapper.

### Fixed

- The v3 frost and entrance styling for the Clear canvas dialog targeted
  class names the dialog does not use, so it never applied. It now targets
  `.clear-confirm-panel`, and only while the dialog is open: the dialog stays
  in the page when hidden, and a backdrop blur on it was an extra GPU pass
  over the canvas on every frame (tests/test_live_stroke_cost.py caught it).


## 2.5.2 — 2026-11-18

### Changed

- **About: Recent writing redesigned as editorial cards.** Each card has an
  outlined index numeral, a date chip and a band in that card's own colour,
  a tighter display title that breaks on balanced lines, and a quieter
  blurb. "Read on LinkedIn" is pinned to the foot of every card, so the
  links line up across the row, and its arrow turns on hover. The hard
  shadows are no longer cut off at the edge of the list.


## 2.5.1 — 2026-11-18

### Fixed

- **The About page's rolling numbers and rotating roles broke up while
  scrolling.** Each digit sat in a window exactly 1em tall, but the mono
  digits are taller than that, so slivers of the digits above and below
  always showed and shifted with every scroll step ("390+" could read
  "39A+"). The window is now 1.3em, with the digit centred and drawn on its
  own layer. The role line slid through a one-line clip and could show two
  half lines; it now cross-fades in place, one role at a time.


## 2.5.0 — 2026-11-18

### Changed: the compass and the angle tool, rebuilt for a finger

From an LLM council review of the two tools the owner names as the most
important (report in docs/council/). Five advisors and five peer reviewers
agreed on the cause: both tools were tuned for a mouse on a product made for
a budget tablet.

- **Every hit target scales with the input.** About 1.8x for a finger and
  1.3x for a pen. The tap-or-drag threshold is now 10px for a finger (it was
  4px, so a finger tap became a tiny arc). This covers snapping, arc ends,
  arc bodies, point and intersection menus, and smart-shape snaps.
- **Measure an angle with three taps:** an arm, the corner, the other arm,
  as in angle ABC. It works anywhere, including on pen ink, PDFs and
  pictures. The reading follows your finger before the last tap.
- **The mark goes on the corner you tapped.** It used to use the far end of
  each line, so on an X crossing it could mark the wrong corner.
- **Tap inside a mark to flip it** to the reflex angle and back. The reading
  now stays on screen, where it used to be replaced in the same tap.
- **Whole degrees when the angle is one:** a constructed 60° reads 60°, not
  59.9°.
- **Circle mode draws the circle when you lift** after dragging out the
  radius, and one Undo removes it.
- **The radius is shown on the compass opening** while you set it.
- **Hold still on an arc to pick it back up.** A plain press now starts a
  new arc, so the second arc of a construction can begin on top of the
  first.
- "Click" is now "Tap" throughout the angle tool.

### Added

- **Image tools.** Select a captured frame or an inserted picture for a bar
  with Edit, rotate, duplicate, open the video, undo, redo and delete, plus
  More: flip, bring to front or send back, hide the timestamp, save the
  image, reset. Edit opens a sheet with crop (free or a fixed shape), looks
  (Scan, Board to paper, Mono, Vivid, Warm), brightness, contrast, colour,
  opacity, rotate, flip and the frame's background. Every edit is one undo
  step, survives a reload, and appears the same in PDF export.
- **The homepage demo works.** Drag A, B or C and the circumcircle, the
  altitude and the right-angle mark follow. Pen, Line, Circle and Triangle
  draw on the page.
- **About: the builder as a small portfolio**, taken from the owner's
  LinkedIn: his photo in an animated ring, his roles in rotation, a
  "where he works" timeline (HYPERION, Tungston Theory, Sarala Birla Public
  School, Cambrian Public School), an education timeline (Ph.D. at Sarala
  Birla University, M.Sc. at St. Xavier's College), and "Recent writing", four dated posts linked to
  LinkedIn. Articles live in `PORTFOLIO_ARTICLES` in app.py. The photo is
  `static/img/profile.jpg`, a 384px copy served from this site, so the page
  never loads anything from LinkedIn.
- **Long panels say they are long.** Any tool panel or sheet that scrolls
  shows a "More" chip at its bottom edge while there is more below (a tap
  scrolls a screenful), fades at whichever edge has more content, and a
  visible scrollbar on touch screens. On an Android tablet the scrollbar only
  appeared mid-scroll, so options below the fold were invisible.

### Removed

- The About page's "Built before this" section.
- The homepage "Watch the demo" button. The demo is now live, so there is
  nothing to watch.

### Fixed

- Picking an arc back up had never worked. `reopenArc` referred to two names
  that were not in scope and threw.
- `tools/vendor_icons.py` emptied the icon folder when a download failed. It
  now retries, and replaces the set only once every icon has arrived.


## 2.4.1 — 2026-11-18

### Fixed

- **The YouTube player went under the tool bar on shorter screens.** On a
  768px laptop a tall player had to choose between staying on screen and
  staying below the chrome. It chose the screen, so its title bar and the
  top of the video sat under the tool bar. The player is now never taller
  than the room under the tool bar, and dragging its top edge stops at the
  tool bar, as moving it already did.
- The player opened at 300px instead of its 400px default, and could snap
  back to a smaller size after a resize. The viewport check read the height
  partway through its animation and saved that as the new size.


## 2.4.0 — 2026-11-17

### Added: lecture tools in the YouTube player

- **Controls built for studying.** A bar under the video with back and
  forward 10 seconds, play and pause, a scrub bar you can tap or drag, the
  time, and playback speed from 0.5x to 2x (remembered between visits).
- **Loop a section.** Press loop at the start of the part you did not
  follow and again at its end, and it replays until you stop it. The
  section is shaded on the scrub bar.
- **Lecture notes.** Bookmark a moment with one press, or type a note. A
  note belongs to the moment you started typing, and the video pauses while
  you type (you can switch that off). Notes are listed in time order, marked
  on the scrub bar, and jump back to their moment when tapped. "Copy all"
  copies them as text, each with a link to its moment.
- **Pick up where you stopped.** A lecture opened without a time resumes
  from where you left it. The empty player lists "Continue watching" with
  progress and note counts. It shows no thumbnails, so nothing reaches
  YouTube until you press play.
- **Dock beside the canvas.** One button turns the player into a
  full-height column on the right, and the same button floats it again.
- **Keyboard shortcuts** while the pointer is over the player: K or Space to
  play and pause, J and L for 10 seconds, the arrow keys for 5, B to
  bookmark, A to loop, S to save the frame, [ and ] for speed, N for notes.
  Everywhere else the canvas keeps its keys.
- Notes, places and speed stay on this device.

### Fixed

- `tools/vendor_icons.py` deleted the vendored icons before downloading the
  new set, so one dropped download left the editor without icons. It now
  retries each download and replaces the set only once everything has
  arrived.


## 2.3.0 — 2026-11-17

### Changed

- **New look: neo-brutal with frost.** Cream paper (deep ink at night), thick
  ink outlines, hard offset shadows, a yellow / red / purple / blue / green
  accent set, and frosted glass over soft colour blobs.
- **The homepage is rebuilt.** A big "Maths you can touch." headline, a demo
  window that draws its own construction on load, a tilted marquee, a bento
  grid of features, a "Free means free" stats row, three steps and a closing
  call to action. The same one action ("Start writing, free") appears twice.
- **A new welcome tour.** Six short steps, each with its own colour, a drawn
  illustration and a spotlight on the real control it describes. Keyboard,
  clickable progress dots, and a bottom sheet on phones. Replaces the old
  onboarding cards (`onboarding.js` and `onboarding.css` are gone; the stored
  "seen" key is unchanged, so returning users are not shown it again).
- **The editor matches.** Bars, rail and panels get ink outlines and hard
  shadows; the tool in your hand is a yellow block; dialogs and sheets are
  frosted. Bars are frosted only on a desktop pointer, to keep panning smooth
  on a tablet.
- **Everything moves like one product.** One set of curves and durations,
  shared by every page. Moving between pages cross-fades; switching light and
  dark, or picking a canvas, wipes the new look out of the button you
  pressed. On the homepage, sections rise in as you scroll, the demo window
  leans toward the pointer, a soft light follows the pointer across the
  feature tiles, the header settles as you scroll, and a fine grain sits over
  the colour. Editor buttons press in, and dialogs arrive rather than pop.
  Under reduced motion all of it stands still.
- **The focus timer is rebuilt, with a Sound studio.** Each mode has its own
  hue on the clock (yellow focus, green break, blue long break), the clock
  breathes while it runs, and everything you press has an ink outline and a
  hard shadow. The new Sound studio adds white, pink and brown noise and a
  Wind down bed that swells on a slow 4-in, 6-out breath, alongside rain,
  deep sea and clock. It also has focus frequencies: delta 2 Hz, theta 6 Hz,
  alpha 10 Hz, beta 16 Hz and gamma 40 Hz presets, or any rate from 1 to
  45 Hz. They play as a binaural beat in headphones or as a soft pulse on a
  speaker, with their own pitch and volume. A switch plays sound only while
  you are focusing, fading it out for breaks. Everything is generated on the
  device, nothing is downloaded, and the studio always opens silent.

### Fixed

- On phones the marketing header scrolls away with the page instead of
  pinning three rows over it.

- **The editor had no way back to the homepage.** The MAETHIST mark now
  starts the File ribbon at every width and links home; notebooks save as
  you write, so leaving loses nothing.
- The docked tool panel on desktop started at the top of the window, so its
  title sat hidden behind the top bar.
- The homepage scrolled sideways by a pixel on phones.


## 2.2.1 — 2026-11-17

### Fixed

- **Every error now reaches the screen.** 2.2.0 fixed the PDF, PowerPoint
  and image pickers; the same flaw was in three more places, now fixed:
  notebook PDF export ("Write notes before exporting.", export failures),
  File-menu commands whose result was written inside a menu that had already
  closed, and My Notebooks messages (such as a bad backup) shown inside a
  dialog that was not open. AR Inky's camera errors used blocking browser
  pop-ups and now use the same notice.
- **A damaged PDF crashed the server import on Windows.** PyMuPDF kept the
  failed file locked, the temporary folder could not be deleted, the request
  ended in an HTML error page, the upload stayed on disk, and the editor
  showed the raw text "Unexpected token '<' ... is not valid JSON". PDFs are
  now read in memory and never written to disk; temporary folders for
  PowerPoint tolerate a locked file; every API error answers in JSON with a
  readable sentence; and the editor turns an unreadable reply into a plain
  message.
- The privacy policy now says that PDFs are read in memory and that most
  imports never reach the server.
- An upload test posted the wrong field name, so it never exercised the code
  that failed. It now sends a real damaged PDF.


## 2.2.0 — 2026-11-17

Launch checklist. Items that were already in place (privacy and terms pages,
meta titles and descriptions, social preview image, favicon, sitemap,
robots.txt, alt text, custom 404, no secrets in front-end code) were audited
and kept.

### Added

- **A visit counter you own.** Page loads per day, per page, by phone, tablet
  or desktop, and the referring website's name. No cookies, no IP addresses,
  nothing per visitor and nothing sent to anyone, so no consent banner is
  needed. Read it at `/stats` with the `STATS_TOKEN` password.
- **Request limits on every public API endpoint** (search, video frames,
  imports, exports), so one visitor cannot flood the server. Visitors are told
  to wait with a 429 and a retry time; the address is only ever held as a
  scrambled code for one minute, in memory.
- **`PRIVACY_CONTACT_EMAIL`** puts your contact address on the privacy and
  terms pages; until it is set they keep the visible placeholder.

### Changed

- **One call to action**: "Start writing, free", on every page and in the
  header. Second choices are quiet text links, not competing buttons.
- **HTTPS is forced in production by default** (Render or
  `INKYSCIB_ENV=production`); `FORCE_HTTPS=false` turns it off.
- **Brand images compressed** from about 650 KB to 52 KB; the favicon from
  432 KB to 7 KB.
- **Form fields**: the planner marks an empty task name as invalid for screen
  readers; size fields accept decimals without flagging them; the lecture
  search has the server's 200-character limit.
- The privacy policy describes the visit count and the request limits, with
  their retention.

### Fixed

- **Import errors were invisible.** "Choose a .pdf file", "Could not open this
  PDF" and the PowerPoint messages were written into side-menu status lines
  the v2 chrome never shows, so a wrong file looked like a button that did
  nothing. They now appear as an on-screen notice, as do image-insert errors.
- The 404 page gained a description and a clearer title.
- The EDPB link in the privacy policy pointed at a moved page.

## 2.1.0 — 2026-11-17

### Changed

- **Inkyscib is now MAETHIST.** Every name a person reads changed: page
  titles, the wordmark, the editor footer, the tour, error and status
  messages, Planner alerts and calendar exports, download file names
  (`maethist-backup-<date>.inky`, `maethist-notebook.pdf`,
  `maethist-presentation.pptx`), the installed app's name, the legal pages
  and the docs.
- **New mark.** The favicon, the installable-app icons, the Android adaptive
  icon, the notification badge, the header and 404 logos, the tour badge and
  the share card all use the new maths-symbols icon, built from one source by
  `tools/make_brand_icons.py`. On pages it sits on a small paper tile, because
  its black outlines would vanish on the dark sheet.

### Kept on purpose

- **Internal names did not change**, so nobody loses their work: storage keys
  (`inkyscib_drawing`, `inkyscib-*`), the IndexedDB database `inkyscib_cache`,
  the backup format's `app: "inkyscib"` marker, the offline cache prefix, the
  `window.Inkyscib` script namespace and the `.inky` / `.inkydoc` file
  extensions. Renaming any of them would orphan every existing visitor's
  notebooks or make older backups unopenable.

## 2.0.2 — 2026-11-17

### Changed

- **Every UI icon now comes from an open icon library**, vendored from GitHub
  at a pinned release by `tools/vendor_icons.py`, one family per surface so
  two styles never share a row:
  - **Lucide** 1.66.0 (ISC) for the editor: toolbar, tool rail, File sheet,
    tool panels, the lecture player and toasts.
  - **Phosphor** 2.0.8 (MIT) for the Planner, Pomodoro and the feature tour.
  - **Remix Icon** 4.9.1 (Remix Icon License) for the marketing and legal pages.
- Templates inline icons on the server (`icon()` in `app.py`), so they are in
  the HTML on first paint; scripts use the same set from `static/js/icon-set.js`.

### Removed

- The 55 hand-drawn icons in `static/js/icons.js`, the File sheet's own icon
  paths, the planner's, tour's, dock's and colour studio's inline icons, and
  the Unicode stand-ins on the homepage (the arrows, the theme-toggle half
  circles and the preview toolbar's tool glyphs).

### Kept on purpose

- Drawings of content, which no icon library has: the 15 shape glyphs and the
  toolbar's current-shape mirror, pen-nib samples, line, arrow, fill and dash
  styles, the assist curves, canvas swatches, the Pomodoro ring, resize grips
  and the tour and planner illustrations. The wordmark's diamond is the logo.


## 2.0.1 — 2026-11-15

### Changed

- **Video moments are captured at maximum resolution and quality.** The
  server now picks the video's highest-resolution SDR stream up to 4K, in any
  codec (VP9 and AV1 as well as H.264; YouTube serves nothing above 1080p as
  H.264), and encodes JPEG at quality 95 with no chroma subsampling, so slide
  text and thin coloured lines stay crisp. Measured: a 4K source gives
  3840x2160 (3.7 MB) in 8.7 s for the first frame and 0.7 s for the next; a
  1080p source gives 1920x1080 (0.8 MB). On by default again; the per-frame
  storage ceiling rose from 2 MB to 12 MB to hold it.

### Added

- **Persistent storage.** After the first save, Inkyscib asks the browser not
  to evict its storage under disk pressure (`navigator.storage.persist()`).
- **Backup reminder.** After two days of work with no backup, or a week since
  the last one, a small bar offers "Back up now". "Later" snoozes it two days.
- **Remote off switch for the offline shell** (`OFFLINE_SHELL=off`), in case a
  release ever ships a broken service worker.
- **Cold-start fallback.** If the host is asleep, the offline shell serves the
  cached page after 3.5 s instead of leaving a blank tab for a minute.

### Fixed

- **Import uploads are capped** at 50 MB on the server, with at most two
  conversions at once; the rest get a clear "busy, try again" answer instead of
  exhausting memory.
- **A save too big for localStorage no longer leaves an old copy behind.**
  IndexedDB was always the copy that loads; the stale mirror is now removed.


## 2.0.0 — 2026-11-15

The first version meant to be launched publicly. The launch review, with every
measurement behind the claims below, is `docs/V2-REVIEW.md`.

### New

- **Works offline, for real.** A service worker (`/sw.js`) keeps a copy of the
  app's own pages, scripts, styles and fonts. After one visit online the canvas
  opens with no connection. The homepage always said "offline"; until now that
  was only true of the notes, not of the app.
- **Blueprint identity.** Drafting blue, one cyan accent, Space Grotesk for
  headlines and labels, a ruled grid behind the marketing pages. New default
  canvas ground for new visitors is Blueprint. Light mode is white drafting
  paper with blue rules.
- **One-click deploy to Render** via `render.yaml`, with `gunicorn.conf.py`,
  a `/healthz` health check, pinned requirements and a `VERSION` file.

### Changed

- **Tablets and phones get a proper toolbar.** Below 1180px the editor now has
  two docked bars (document, then tools) instead of loose icons wrapping over
  two or three rows. 122px tall at every width, down from about 200px. Every
  tool fits without scrolling on a 960px tablet; on a phone the row scrolls
  sideways and fades at the edge to say so.
- **The File sheet opens under both bars** and stops above the footer links.
  On desktop it opens beside the tool rail, not over it.
- **The tour, File sheet, Planner and My Notebooks share one palette.** Each
  used to carry its own (indigo, teal, lavender).
- **Footer credit** now reads "Created by @kshitizarc" and links to LinkedIn.
  The animated "TT" signature is gone.
- **The lecture player opens in 180ms**, not 480ms.
- **Saved video moments used YouTube's preview image** in 2.0.0. Reverted in
  2.0.1, which captures at up to 4K.

### Removed

- **Google Analytics, the cookie banner and `/api/consent`.** There is no
  analytics of any kind. A first visit contacts no third party.
- `consent_log.py`, `tools/prune_consent_log.py`, `tools/verify_consent_log.py`.
- The "Privacy choices" and "Do Not Sell or Share" footer links, which only
  ever switched analytics off.

### Fixed

- The help sheet was 14px wider than a 375px phone and ran off both edges.
- The notebook page switcher sat on top of the Privacy / Cookies / Terms links.
- The zoom field (45x18) and the document name (54x19) were too small to tap;
  both are now 44px, as are the marketing nav controls.
- White text on the accent became unreadable wherever a dialog hard-coded it;
  those now use `--on-accent`.
- Production no longer starts with a random per-worker `SECRET_KEY`: it
  refuses to start until one is set.

### Before you go live

- Set `SITE_ORIGIN` on the host.
- Fill in the privacy contact address on `/legal/privacy` (it is still a
  placeholder) and have the three legal pages read by a lawyer.
- Try it once on the real tablet: everything here was measured in desktop
  Chromium at tablet and phone sizes, not on the device itself.
