# Council: what the Planner should add (2026-11-19)

The owner asked for "a huge overhaul to the planner", in neo-brutalism, and
for an LLM council to choose the features. Five advisors answered on their
own. There was no peer-review round. The verdict below is the vote count.

**Question.** The Planner opens over the canvas. Before 2.8.0 it had a
month calendar, a day list, timed tasks, repeats, browser reminders, a
progress count and export to the device calendar. Which features should be
added, ranked, and what should not be built? The students are in CBSE
classes 9-12, on budget tablets, offline, with no accounts.

## Count

| Feature | Contrarian | First Principles | Expansionist | Outsider | Executor |
|---|---|---|---|---|---|
| Start focus from a task, and log the minutes | ✓ | ✓ | ✓ (first) | ✓ | ✓ |
| Exam countdown, with revision spread back from the date | ✓ (first) | ✓ | ✓ | ✓ (first) | ✓ |
| Streak and weekly summary | ✓ | ✓ | ✓ | ✓ | ✓ |
| Link a task to its notebook | ✓ | ✓ | ✓ | ✓ | |
| Chapter or topic on a task (CBSE list) | ✓ | ✓ (first) | | ✓ | ✓ |
| Backup and restore | ✓ | ✓ | ✓ | | ✓ |
| Today and this week first, big touch targets | | ✓ | ✓ | ✓ | ✓ |
| Missed tasks carried to today | | ✓ | | ✓ | |
| School timetable template | ✓ | | | | |
| Spaced revision (1, 3, 7, 21 days) | | | ✓ | | |
| Priority, subtasks | | | no | | ✓ |

Not to build, said by three or more: accounts or sync, push notifications
that need a server, AI-generated plans, XP, badges or leaderboards, and
drag-heavy week or time grids.

## What was built (2.8.0)

- **Focus from a task.** Each open task has a Focus button. It starts the
  focus timer (`Pomodoro.startFocus`). A finished session, through the
  `inkyscib:focus-complete` event, adds its minutes to that task and to the
  day.
- **Exams.** Add an exam with a name and a date. It counts down, and turns
  red within a week. Chapters, typed or filled in from a class's CBSE list,
  become one "Revise:" task each, spread over the days before the exam.
- **Streak and This week.** The streak counts days in a row with something
  ticked off; today not done yet does not break it. This week is seven days,
  each showing how much of it is done, with the week's totals and focus time.
- **Topic and notebook.** A task can take a topic (the CBSE chapters are
  offered) and a notebook, which it opens.
- **Back up and Restore.** The plan is saved as a JSON file. Restore adds
  only what is missing, so it never duplicates anything.
- Missed tasks were already carried to today ("Carried from ..."), so
  nothing changed there.
- **Neo-brutal**, from `static/css/planner-brutal.css`, on the core tokens.

## Not built yet

- A school timetable template and spaced revision. Each had one vote, and
  each is a feature of its own.
- Priority and subtasks: one advisor for them, one explicitly against.
