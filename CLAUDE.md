# Inkyscib

A browser workspace for studying from your own material: import a PDF or a deck, write on
it by hand, construct real geometry, export clean vector PDF. Free, offline-capable, no
account. Flask + vanilla JS, no build step.

**Not a git repository.** There is no branch, no diff, and no history to read. Verify
changes by running the tests and by looking at the app.

## Design System

Always read `DESIGN.md` before making any visual or UI decision. All colour, typography,
spacing, radius, motion and layout rules live there. Do not deviate without explicit user
approval. When reviewing code, flag anything that does not match it.

Two rules from that file are worth repeating because they have already caused shipped bugs:

- **One token vocabulary.** Do not invent a `--yourfeature-*` palette. The codebase already
  carries eight of them, and because `--chrome-*` is declared on `body.chrome-rail` (which
  only exists at ≥1180px), a panel built against it rendered with no background at all on a
  tablet. If a token you need does not exist, add it to the core set in `DESIGN.md`.
- **Nothing that teaches the app may hide behind a `?` at one breakpoint.** The target
  device is a ~960px budget Android tablet. Anything gated above 1180px does not exist for
  the user this product is for.

## Running it

```bash
python -c "import os; os.environ.setdefault('SECRET_KEY','dev'); from app import app; app.run(host='127.0.0.1', port=8977)"
```

## Tests

```bash
python -m pytest tests/ -q
```

**Baseline is 140 passed / 16 failed.** All 16 failures are pre-existing and unrelated to
current work: 14 in `test_planner.py`, 1 in `test_smart_geometry.py`, and 1 in
`test_planner_deeplink.py` (a date-format locale mismatch). Two of the planner failures are
**flaky** — they click `#menuBtn` without dismissing the first-run feature tour, so the
tour intercepts the pointer event when it wins the race. The failure *count* holds at 16
while the *membership* shifts between runs. Do not read a membership change as a regression
without re-running that specific test.

Browser tests need `bypass_csp=True` (the editor forbids `unsafe-eval`) and must dismiss
the tour via `localStorage['inkyscib-feature-tour-v1']` or it swallows every click.

## Deferred work

`TODOS.md` holds it, with enough context to pick each item up cold. Add to it rather than
leaving an intention in a chat log.

## Skill routing

When the user's request matches an available skill, invoke it via the Skill tool. When in
doubt, invoke the skill.

- Product ideas/brainstorming → invoke /office-hours
- Strategy/scope → invoke /plan-ceo-review
- Architecture → invoke /plan-eng-review
- Design system/plan review → invoke /design-consultation or /plan-design-review
- Full review pipeline → invoke /autoplan
- Bugs/errors → invoke /investigate
- QA/testing site behavior → invoke /qa or /qa-only
- Code review/diff check → invoke /review
- Visual polish → invoke /design-review
- Ship/deploy/PR → invoke /ship or /land-and-deploy
- Save progress → invoke /context-save
- Resume context → invoke /context-restore
- Author a backlog-ready spec/issue → invoke /spec
