# Council: what goes on the hold ring (2026-11-19)

The owner asked for a ring of the most-used features that opens around the
pointer after a 2-second press on the canvas, and asked for an LLM council
to decide what goes on it. Five advisors answered on their own, without
seeing each other's answers. There was no peer-review round: the verdict
below is the vote count plus the interaction rules the answers agreed on.

**Question.** MAETHIST is a free maths canvas for students on budget Android
tablets (finger or stylus) and desktop. Which 6-8 of these should the ring
hold, clockwise from the top, and what will go wrong with a 2-second hold on
a canvas you draw on? Select, Pen, Highlighter, Eraser, Line, Shape, Compass,
Measure angle, Algebra tiles, Undo, Redo, Clear page, Zoom in/out, Fit to
screen, Pan, Pen colour, Pen size, Insert image/PDF, Export PDF, Image to
text, YouTube player, Capture YouTube frame, Pomodoro timer, Canvas theme,
New page, Lecture notes.

## The five answers

| Advisor | Ring, clockwise from the top | The point that mattered |
|---|---|---|
| Contrarian | Pen, Pen colour, Line, Measure angle, Eraser, Select, Undo, Pan | The failures: the press leaves a dot, a pause mid-stroke opens it, a resting palm opens it, it is clipped at the screen edge, a student who sees nothing presses harder and cancels it, and Android's own long-press can fire first. Cancel on about 8px of movement, and keep a visible button for everything. |
| First Principles | Pen, Pen colour, Line, Eraser, Select, Pan, Redo, Undo | The ring is for what a student does constantly with the hand on the page. Line is the one geometry tool used in nearly every problem. Pan is the mode switch a finger-only tablet needs. Undo and Redo sit together. No Clear or New page: a hold that fires by accident must not destroy work. |
| Expansionist | Pen, Pen colour, Highlighter, Eraser, Select, Undo, Shape, Image to text | Make the hold visible as an arc that fills, pick by dragging onto a slice and lifting, show state in the ring. Also proposed: an undo scrubber, a timer in the centre, an order that adapts to use. |
| Outsider (a 15-year-old) | Pen, Pen colour, Eraser, Undo, Line, Compass, Insert image/PDF, Select | What would confuse them: two seconds feels broken, a palm could pop it mid-sentence, eight unlabelled icons mean nothing, it is unclear how to close it, and does the pen leave a dot? |
| Executor | Pen, Highlighter, Eraser, Select, Undo, Redo, Pen colour, Pen size | Exact rules: primary pointer only, a 2000ms timer, cancel past 10px (12px for touch), on lift, or on a second pointer. The stroke the press began is dropped, not kept. Clamp the ring inside the viewport, pick by lifting over a slice or tapping one, dismiss with Esc or a tap outside. |

## Count

| In all five | In three | In two | In one |
|---|---|---|---|
| Pen, Pen colour, Eraser, Select, Undo | Line | Pan, Redo, Highlighter | Measure angle, Shape, Compass, Image to text, Insert, Pen size |

## Verdict

**Pen, Colour, Line, Eraser, Select, Pan, Redo, Undo**, clockwise from the
top: the First Principles ring. It holds all five unanimous items, the only
item three advisors chose (Line), and two of the three tied at two. Pan and
Redo beat Highlighter: Pan is the only way to move a zoomed page with one
finger on a tablet, and Redo belongs beside Undo. The ring is a shortcut,
never the only way, so every slice is also on the tool rail or the ribbon.

## What was built against each point

| Point | Raised by | In `static/js/quick-access.js` |
|---|---|---|
| A 2-second still press, nothing else | Executor | `HOLD_MS = 2000`, primary pointer only, left button only |
| Movement cancels it, so a pause mid-stroke never opens it | Contrarian, Executor | 10px of movement, 12px for touch, cancels the hold for the rest of that stroke |
| A palm or a second finger | Contrarian, Outsider, Executor | A second pointer cancels the hold |
| The press leaves a dot | Contrarian, Outsider, Executor | When the ring opens, the stroke in progress is dropped and the page redrawn |
| Two seconds looks broken | Contrarian, Outsider, Expansionist | The ring appears at 0.35s with an arc that fills to the 2-second mark |
| Unlabelled icons | Outsider | Every slice has a text label |
| Clipped at the edge | Contrarian, Outsider, Executor | The ring is clamped 150px inside the viewport |
| Picking and closing | Executor, Expansionist, Outsider | Drag onto a slice and lift, or lift and tap one; Esc or a tap outside closes |
| Colour | Expansionist (a sub-ring) | Colour opens a ring of the pen's swatches, with Back |
| Tools that already own a long press | (found in the code) | Not armed for the eraser (hold for lasso) or the compass (hold to reopen an arc) |

## Not built, and why

- **Highlighter, Pen size.** Tied or single votes. Pen size lives in the pen panel.
- **Image to text on the ring.** Occasional, not per-stroke (First Principles). It is in the Tools pane and in an image's More menu.
- **Undo scrubber, a timer in the centre, an order that adapts to use.** New surface area before anyone has used the basic ring, and an adaptive order would move the slices a student has learned.
