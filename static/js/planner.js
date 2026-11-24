// MAETHIST Planner
// Local-only calendar, recurring tasks, progress, and best-effort reminders.
(function () {
  'use strict';
  // Phosphor icons from the vendored registry (static/js/icon-set.js).
  function phIcon(ref) {
    return window.Inkyscib?.Icon?.svg?.(ref) || '';
  }


  const STORAGE_KEY = 'inkyscib-planner-v1';
  const STORE_VERSION = 1;
  const AUTO_NUDGE_MS = 3 * 60 * 60 * 1000;
  const MAX_TASKS = 1000;
  const MAX_DATE_STATE_ENTRIES = 800;
  const SERVICE_WORKER_URL = '/static/js/planner-sw.js?v=2';
  const SERVICE_WORKER_SCOPE = '/static/js/';
  const REMINDER_SCAN_FALLBACK_MS = 5 * 60 * 1000;
  const DEVICE_CALENDAR_CATCHUP_MS = 5 * 60 * 1000;

  // The CBSE mathematics chapters for classes 9 to 12 (NCERT, rationalised),
  // offered as topics for a task and as the chapters an exam plan spreads.
  const CBSE_CHAPTERS = {
    '9': ['Number Systems', 'Polynomials', 'Coordinate Geometry', 'Linear Equations in Two Variables',
      "Introduction to Euclid's Geometry", 'Lines and Angles', 'Triangles', 'Quadrilaterals', 'Circles',
      "Heron's Formula", 'Surface Areas and Volumes', 'Statistics'],
    '10': ['Real Numbers', 'Polynomials', 'Pair of Linear Equations in Two Variables', 'Quadratic Equations',
      'Arithmetic Progressions', 'Triangles', 'Coordinate Geometry', 'Introduction to Trigonometry',
      'Some Applications of Trigonometry', 'Circles', 'Areas Related to Circles', 'Surface Areas and Volumes',
      'Statistics', 'Probability'],
    '11': ['Sets', 'Relations and Functions', 'Trigonometric Functions', 'Complex Numbers and Quadratic Equations',
      'Linear Inequalities', 'Permutations and Combinations', 'Binomial Theorem', 'Sequences and Series',
      'Straight Lines', 'Conic Sections', 'Introduction to Three Dimensional Geometry', 'Limits and Derivatives',
      'Statistics', 'Probability'],
    '12': ['Relations and Functions', 'Inverse Trigonometric Functions', 'Matrices', 'Determinants',
      'Continuity and Differentiability', 'Application of Derivatives', 'Integrals', 'Application of Integrals',
      'Differential Equations', 'Vector Algebra', 'Three Dimensional Geometry', 'Linear Programming', 'Probability']
  };
  const MAX_EXAMS = 40;
  const MAX_PLAN_CHAPTERS = 60;
  const FOCUS_KEY = 'inkyscib-planner-focus';

  const RECURRENCE_LABELS = {
    none: 'One time',
    daily: 'Every day',
    weekly: 'Every week'
  };

  const monthFormatter = new Intl.DateTimeFormat(undefined, {
    month: 'long',
    year: 'numeric'
  });
  const longDateFormatter = new Intl.DateTimeFormat(undefined, {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
    year: 'numeric'
  });
  const compactDateFormatter = new Intl.DateTimeFormat(undefined, {
    month: 'short',
    day: 'numeric',
    year: 'numeric'
  });
  const weekdayFormatter = new Intl.DateTimeFormat(undefined, {
    weekday: 'short'
  });

  let store = loadStore();
  let bounds = getDateBounds(new Date());
  let selectedDate = bounds.min;
  let viewMonth = startOfMonth(parseDateKey(selectedDate));
  let root = null;
  let trigger = null;
  let ui = {};
  let plannerOpen = false;
  let composerOpen = false;
  let previousFocus = null;
  let closeTimer = 0;
  let celebrationTimer = 0;
  let reminderTimer = 0;
  let tourResumeTimer = 0;
  let notificationTestTimer = 0;
  let pausedFeatureTourStep = null;
  let serviceWorkerRegistrationPromise = null;
  let reminderAudioContext = null;
  let reminderAudioUnlocked = false;
  let reminderScanInFlight = false;
  let storageSyncEnabled = true;
  let storageWarningShown = false;
  let initialized = false;

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init, { once: true });
  } else {
    init();
  }

  function init() {
    if (initialized) return;
    initialized = true;

    trigger = document.getElementById('plannerBtn');
    if (!trigger) return;

    buildPlanner();
    cacheElements();
    bindEvents();
    updateMenuChip();
    updateNotificationControl();
    scheduleReminderScan(1100);

    const params = new URLSearchParams(window.location.search);
    if (params.get('planner') === '1') {
      const requestedDate = params.get('date');
      window.setTimeout(() => {
        openPlanner(requestedDate);
        removePlannerQueryParams();
      }, 0);
    }
  }

  function buildPlanner() {
    root = document.createElement('div');
    root.id = 'plannerModal';
    root.className = 'planner-overlay';
    root.dataset.iconSet = 'phosphor';
    root.hidden = true;
    root.setAttribute('aria-hidden', 'true');
    root.innerHTML = `
      <section class="planner-shell" role="dialog" aria-modal="true" aria-labelledby="plannerTitle" tabindex="-1">
        <header class="planner-header">
          <div class="planner-brand">
            <span class="planner-brand-mark" aria-hidden="true">${phIcon('phosphor:calendar-check')}
            </span>
            <span class="planner-brand-copy">
              <span class="planner-kicker">Local planner</span>
              <strong id="plannerTitle">Plan your day</strong>
              <span id="plannerRange" class="planner-range"></span>
            </span>
          </div>
          <div class="planner-header-actions">
            <button id="plannerNotifyBtn" class="planner-notify-btn" type="button">
              <span class="planner-notify-dot" aria-hidden="true"></span>
              <span id="plannerNotifyText">Enable reminders</span>
            </button>
            <button id="plannerCloseBtn" class="planner-icon-btn planner-close-btn" type="button" aria-label="Close planner">${phIcon('phosphor:x')}
            </button>
          </div>
        </header>

        <section class="planner-study" aria-label="Study at a glance">
          <div class="planner-study-card planner-exams" aria-labelledby="plannerExamsTitle">
            <div class="planner-study-head">
              <h3 id="plannerExamsTitle">Exams</h3>
              <button id="plannerAddExamBtn" class="planner-chip-btn" type="button" aria-expanded="false" aria-controls="plannerExamForm">
                ${phIcon('phosphor:plus')}<span>Add exam</span>
              </button>
            </div>
            <ol id="plannerExamList" class="planner-exam-list"></ol>
            <p id="plannerExamEmpty" class="planner-study-empty">Add a test or a board paper and see the days count down.</p>
            <form id="plannerExamForm" class="planner-exam-form" hidden novalidate>
              <label class="planner-field"><span>Exam</span>
                <input id="plannerExamName" type="text" maxlength="60" placeholder="e.g. Maths board exam" autocomplete="off"></label>
              <label class="planner-field"><span>Date</span>
                <input id="plannerExamDate" type="date"></label>
              <label class="planner-field planner-exam-chapters"><span>Chapters to revise <small>(optional, one per line)</small></span>
                <textarea id="plannerExamChapters" rows="3" placeholder="Leave empty for just a countdown"></textarea></label>
              <div class="planner-exam-fill" role="group" aria-label="Fill in a class's chapters">
                <span>Fill in:</span>
                <button type="button" class="planner-chip-btn" data-fill-class="9">Class 9</button>
                <button type="button" class="planner-chip-btn" data-fill-class="10">Class 10</button>
                <button type="button" class="planner-chip-btn" data-fill-class="11">Class 11</button>
                <button type="button" class="planner-chip-btn" data-fill-class="12">Class 12</button>
              </div>
              <p id="plannerExamError" class="planner-form-error" role="alert" hidden></p>
              <div class="planner-composer-actions">
                <button id="plannerExamCancel" class="planner-secondary-btn" type="button">Cancel</button>
                <button class="planner-save-task-btn" type="submit"><span>Save exam</span></button>
              </div>
            </form>
          </div>
          <div class="planner-study-card planner-streak" aria-live="polite">
            <span class="planner-study-kicker">Streak</span>
            <strong id="plannerStreakValue" class="planner-big-number">0</strong>
            <span id="plannerStreakMeta" class="planner-study-meta">days in a row with something done</span>
          </div>
          <div class="planner-study-card planner-week" aria-labelledby="plannerWeekTitle">
            <div class="planner-study-head">
              <h3 id="plannerWeekTitle">This week</h3>
              <span id="plannerWeekMeta" class="planner-study-meta"></span>
            </div>
            <div id="plannerWeekStrip" class="planner-week-strip" role="group" aria-label="This week's days"></div>
          </div>
          <div class="planner-study-card planner-backup">
            <span class="planner-study-kicker">Your plan</span>
            <button id="plannerBackupBtn" class="planner-chip-btn" type="button">${phIcon('phosphor:download-simple')}<span>Back up</span></button>
            <button id="plannerRestoreBtn" class="planner-chip-btn" type="button">${phIcon('phosphor:upload-simple')}<span>Restore</span></button>
            <input id="plannerRestoreInput" type="file" accept=".json,application/json" hidden>
          </div>
        </section>

        <div class="planner-layout">
          <section class="planner-calendar-pane" aria-label="Planner calendar">
            <div class="planner-calendar-toolbar">
              <div>
                <span class="planner-pane-kicker">Choose a day</span>
                <h3 id="plannerMonthLabel"></h3>
              </div>
              <div class="planner-month-actions">
                <button id="plannerTodayBtn" class="planner-today-btn" type="button">Today</button>
                <button id="plannerPrevMonth" class="planner-icon-btn" type="button" aria-label="Previous month">
                  ${phIcon('phosphor:caret-left')}
                </button>
                <button id="plannerNextMonth" class="planner-icon-btn" type="button" aria-label="Next month">
                  ${phIcon('phosphor:caret-right')}
                </button>
              </div>
            </div>

            <div class="planner-weekdays" aria-hidden="true">
              <span>Sun</span><span>Mon</span><span>Tue</span><span>Wed</span>
              <span>Thu</span><span>Fri</span><span>Sat</span>
            </div>
            <div id="plannerCalendarGrid" class="planner-calendar-grid" role="grid" aria-labelledby="plannerMonthLabel"></div>

            <div class="planner-calendar-foot">
              <span><i class="planner-legend-dot has-task"></i> Tasks planned</span>
              <span><i class="planner-legend-dot is-done"></i> Day complete</span>
            </div>
          </section>

          <section class="planner-day-pane" aria-labelledby="plannerSelectedDate">
            <div class="planner-day-head">
              <div>
                <span id="plannerSelectedKicker" class="planner-pane-kicker">Today</span>
                <h3 id="plannerSelectedDate"></h3>
              </div>
              <button id="plannerAddTaskBtn" class="planner-add-task-btn" type="button">
                ${phIcon('phosphor:plus')}
                <span>Add task</span>
              </button>
            </div>

            <div id="plannerProgressCard" class="planner-progress-card">
              <div class="planner-progress-copy">
                <span id="plannerProgressLabel">A fresh day</span>
                <strong id="plannerProgressValue">0%</strong>
              </div>
              <div id="plannerProgressTrack" class="planner-progress-track" role="progressbar" aria-label="Tasks completed" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0">
                <span></span>
              </div>
              <span id="plannerProgressMeta" class="planner-progress-meta">Add a task to start building momentum.</span>
            </div>

            <form id="plannerTaskForm" class="planner-composer" hidden novalidate>
              <div class="planner-composer-head">
                <div>
                  <span class="planner-pane-kicker">New task</span>
                  <strong id="plannerComposerDate"></strong>
                </div>
                <button id="plannerCancelComposerTop" class="planner-icon-btn" type="button" aria-label="Cancel adding task">
                  ${phIcon('phosphor:x')}
                </button>
              </div>

              <label class="planner-field planner-title-field">
                <span>What needs your attention?</span>
                <input id="plannerTaskTitle" type="text" maxlength="120" autocomplete="off" placeholder="e.g. Finish physics notes" required>
              </label>

              <div class="planner-link-fields">
                <label class="planner-field">
                  <span>Topic <small>(optional)</small></span>
                  <input id="plannerTaskTopic" type="text" maxlength="60" list="plannerTopicList" autocomplete="off" placeholder="e.g. Quadratic Equations">
                  <datalist id="plannerTopicList"></datalist>
                </label>
                <label class="planner-field">
                  <span>Notebook <small>(optional)</small></span>
                  <select id="plannerTaskNotebook"><option value="">None</option></select>
                </label>
              </div>

              <div class="planner-reminder-card">
                <div class="planner-reminder-copy">
                  <span class="planner-reminder-icon" aria-hidden="true">${phIcon('phosphor:bell')}
                  </span>
                  <span>
                    <strong>Remind me</strong>
                    <small id="plannerReminderHint">Off means a smart nudge after 3 hours while MAETHIST is open.</small>
                  </span>
                </div>
                <label class="planner-switch" aria-label="Set a reminder time">
                  <input id="plannerReminderToggle" type="checkbox">
                  <span aria-hidden="true"></span>
                </label>
              </div>

              <div id="plannerTimeFields" class="planner-time-fields" hidden>
                <label class="planner-time-field">
                  <span>Hour</span>
                  <select id="plannerHour" aria-label="Reminder hour"></select>
                </label>
                <span class="planner-time-separator" aria-hidden="true">:</span>
                <label class="planner-time-field">
                  <span>Minute</span>
                  <select id="plannerMinute" aria-label="Reminder minute"></select>
                </label>
                <label class="planner-time-field planner-period-field">
                  <span>Period</span>
                  <select id="plannerPeriod" aria-label="Reminder AM or PM"></select>
                </label>
              </div>

              <fieldset class="planner-recurrence">
                <legend>Repeat</legend>
                <div class="planner-repeat-options">
                  <label>
                    <input type="radio" name="plannerRepeat" value="none" checked>
                    <span><strong>Once</strong><small>This day</small></span>
                  </label>
                  <label>
                    <input type="radio" name="plannerRepeat" value="daily">
                    <span><strong>Daily</strong><small>Every day</small></span>
                  </label>
                  <label>
                    <input type="radio" name="plannerRepeat" value="weekly">
                    <span><strong>Weekly</strong><small>Same day</small></span>
                  </label>
                </div>
              </fieldset>

              <p id="plannerFormError" class="planner-form-error" role="alert" hidden></p>
              <div class="planner-composer-actions">
                <button id="plannerCancelComposer" class="planner-secondary-btn" type="button">Cancel</button>
                <button class="planner-save-task-btn" type="submit">
                  <span>Add to my day</span>
                  ${phIcon('phosphor:caret-right')}
                </button>
              </div>
            </form>

            <div id="plannerTaskList" class="planner-task-list" aria-live="polite"></div>

            <div id="plannerEmptyState" class="planner-empty-state">
              <span class="planner-empty-visual" aria-hidden="true">
                <svg viewBox="0 0 80 80" fill="none">
                  <rect x="16" y="13" width="48" height="53" rx="12"></rect>
                  <path d="M27 8v12M53 8v12M16 29h48"></path>
                  <path d="m29 47 7 7 15-17"></path>
                </svg>
              </span>
              <strong>Your day is wide open.</strong>
              <span>Add the first task and make the plan feel real.</span>
              <button id="plannerEmptyAddBtn" type="button">Plan my first task</button>
            </div>
          </section>
        </div>
      </section>
    `;
    document.body.appendChild(root);

    const toastHost = document.createElement('div');
    toastHost.id = 'plannerToastHost';
    toastHost.className = 'planner-toast-host';
    toastHost.setAttribute('aria-live', 'polite');
    document.body.appendChild(toastHost);
  }

  function cacheElements() {
    ui = {
      shell: root.querySelector('.planner-shell'),
      range: root.querySelector('#plannerRange'),
      notifyBtn: root.querySelector('#plannerNotifyBtn'),
      notifyText: root.querySelector('#plannerNotifyText'),
      notifyDot: root.querySelector('.planner-notify-dot'),
      closeBtn: root.querySelector('#plannerCloseBtn'),
      monthLabel: root.querySelector('#plannerMonthLabel'),
      calendarGrid: root.querySelector('#plannerCalendarGrid'),
      prevMonth: root.querySelector('#plannerPrevMonth'),
      nextMonth: root.querySelector('#plannerNextMonth'),
      todayBtn: root.querySelector('#plannerTodayBtn'),
      selectedKicker: root.querySelector('#plannerSelectedKicker'),
      selectedDate: root.querySelector('#plannerSelectedDate'),
      addTaskBtn: root.querySelector('#plannerAddTaskBtn'),
      progressCard: root.querySelector('#plannerProgressCard'),
      progressLabel: root.querySelector('#plannerProgressLabel'),
      progressValue: root.querySelector('#plannerProgressValue'),
      progressTrack: root.querySelector('#plannerProgressTrack'),
      progressMeta: root.querySelector('#plannerProgressMeta'),
      taskForm: root.querySelector('#plannerTaskForm'),
      taskTitle: root.querySelector('#plannerTaskTitle'),
      composerDate: root.querySelector('#plannerComposerDate'),
      cancelComposerTop: root.querySelector('#plannerCancelComposerTop'),
      cancelComposer: root.querySelector('#plannerCancelComposer'),
      reminderToggle: root.querySelector('#plannerReminderToggle'),
      reminderHint: root.querySelector('#plannerReminderHint'),
      timeFields: root.querySelector('#plannerTimeFields'),
      hour: root.querySelector('#plannerHour'),
      minute: root.querySelector('#plannerMinute'),
      period: root.querySelector('#plannerPeriod'),
      formError: root.querySelector('#plannerFormError'),
      taskList: root.querySelector('#plannerTaskList'),
      emptyState: root.querySelector('#plannerEmptyState'),
      emptyAddBtn: root.querySelector('#plannerEmptyAddBtn'),
      taskTopic: root.querySelector('#plannerTaskTopic'),
      topicList: root.querySelector('#plannerTopicList'),
      taskNotebook: root.querySelector('#plannerTaskNotebook'),
      addExamBtn: root.querySelector('#plannerAddExamBtn'),
      examForm: root.querySelector('#plannerExamForm'),
      examName: root.querySelector('#plannerExamName'),
      examDate: root.querySelector('#plannerExamDate'),
      examChapters: root.querySelector('#plannerExamChapters'),
      examError: root.querySelector('#plannerExamError'),
      examCancel: root.querySelector('#plannerExamCancel'),
      examList: root.querySelector('#plannerExamList'),
      examEmpty: root.querySelector('#plannerExamEmpty'),
      streakValue: root.querySelector('#plannerStreakValue'),
      streakMeta: root.querySelector('#plannerStreakMeta'),
      weekStrip: root.querySelector('#plannerWeekStrip'),
      weekMeta: root.querySelector('#plannerWeekMeta'),
      backupBtn: root.querySelector('#plannerBackupBtn'),
      restoreBtn: root.querySelector('#plannerRestoreBtn'),
      restoreInput: root.querySelector('#plannerRestoreInput'),
      toastHost: document.getElementById('plannerToastHost')
    };
  }

  function bindEvents() {
    trigger.addEventListener('click', () => {
      if (notificationState() === 'granted') primeReminderAudio();
      openPlanner();
    });
    ui.closeBtn.addEventListener('click', closePlanner);
    root.addEventListener('pointerdown', (event) => {
      if (notificationState() === 'granted') primeReminderAudio();
      if (event.target === root) closePlanner();
    });
    root.addEventListener('keydown', handlePlannerKeydown);
    ui.toastHost.addEventListener('keydown', (event) => {
      if (plannerOpen) handlePlannerKeydown(event);
    });

    ui.prevMonth.addEventListener('click', () => changeMonth(-1));
    ui.nextMonth.addEventListener('click', () => changeMonth(1));
    ui.todayBtn.addEventListener('click', () => selectDay(bounds.min));
    ui.calendarGrid.addEventListener('click', (event) => {
      const button = event.target.closest('button[data-date]');
      if (!button || button.disabled) return;
      selectDay(button.dataset.date);
    });
    ui.calendarGrid.addEventListener('keydown', handleCalendarKeydown);

    ui.addTaskBtn.addEventListener('click', openComposer);
    ui.emptyAddBtn.addEventListener('click', openComposer);
    ui.cancelComposer.addEventListener('click', () => closeComposer());
    ui.cancelComposerTop.addEventListener('click', () => closeComposer());
    ui.taskForm.addEventListener('submit', addTask);
    ui.reminderToggle.addEventListener('change', syncReminderFields);
    ui.hour.addEventListener('change', renderTimeOptions);
    ui.minute.addEventListener('change', renderTimeOptions);
    ui.period.addEventListener('change', renderTimeOptions);

    ui.taskList.addEventListener('click', (event) => {
      const action = event.target.closest('button[data-planner-action]');
      if (!action) return;
      const taskId = action.dataset.taskId;
      const occurrenceDate = action.dataset.occurrenceDate;
      if (action.dataset.plannerAction === 'toggle') {
        toggleTask(taskId, occurrenceDate);
      } else if (action.dataset.plannerAction === 'delete') {
        deleteTask(taskId);
      } else if (action.dataset.plannerAction === 'device-calendar') {
        promptDeviceCalendar(taskId, occurrenceDate);
      } else if (action.dataset.plannerAction === 'focus') {
        startTaskFocus(taskId, occurrenceDate);
      } else if (action.dataset.plannerAction === 'notebook') {
        openTaskNotebook(taskId);
      }
    });
    bindStudyEvents();

    ui.notifyBtn.addEventListener('click', () => {
      requestNotificationAccess({ sendTest: true });
    });

    window.addEventListener('storage', (event) => {
      if (event.key !== STORAGE_KEY) return;
      storageSyncEnabled = true;
      store = loadStore();
      updateMenuChip();
      if (plannerOpen) renderAll();
      scheduleReminderScan(250);
    });
    window.addEventListener('focus', handleReturnToPage, { passive: true });
    window.addEventListener('pageshow', handleReturnToPage, { passive: true });
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden) handleReturnToPage();
    });
    window.addEventListener('message', handlePlannerMessage);
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.addEventListener('message', handlePlannerMessage);
    }
  }

  function handlePlannerKeydown(event) {
    event.stopPropagation();

    if (event.key === 'Escape') {
      event.preventDefault();
      if (composerOpen) {
        closeComposer();
      } else {
        closePlanner();
      }
      return;
    }

    if (event.key !== 'Tab') return;
    const focusable = getFocusableElements(ui.shell);
    if (!focusable.length) {
      event.preventDefault();
      ui.shell.focus();
      return;
    }

    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (document.activeElement === ui.shell) {
      event.preventDefault();
      (event.shiftKey ? last : first).focus();
    } else if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }

  function getFocusableElements(container) {
    const selector =
      'button:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])'
    ;
    const elements = Array.from(container.querySelectorAll(selector));
    if (plannerOpen && ui.toastHost) {
      elements.push(...ui.toastHost.querySelectorAll(selector));
    }
    return elements.filter((element) => !element.hidden && element.offsetParent !== null);
  }

  function handleCalendarKeydown(event) {
    const button = event.target.closest('button[data-date]');
    if (!button) return;
    const moves = {
      ArrowLeft: -1,
      ArrowRight: 1,
      ArrowUp: -7,
      ArrowDown: 7
    };
    if (!(event.key in moves) && event.key !== 'Home' && event.key !== 'End') return;

    const buttons = Array.from(ui.calendarGrid.querySelectorAll('button[data-date]'));
    let targetButton = null;

    if (event.key === 'Home' || event.key === 'End') {
      let index = buttons.indexOf(button);
      index = event.key === 'Home'
        ? index - (index % 7)
        : index + 6 - (index % 7);
      const direction = event.key === 'End' ? -1 : 1;
      while (index >= 0 && index < buttons.length && buttons[index].disabled) {
        index += direction;
      }
      targetButton = buttons[index] || null;
    } else {
      const targetDate = addCalendarDays(
        parseDateKey(button.dataset.date),
        moves[event.key]
      );
      const targetKey = toDateKey(targetDate);
      if (targetKey < bounds.min || targetKey > bounds.max) return;

      const targetMonth = startOfMonth(targetDate);
      if (monthOrdinal(targetMonth) !== monthOrdinal(viewMonth)) {
        event.preventDefault();
        viewMonth = targetMonth;
        clampViewMonth();
        renderCalendar();
        focusCalendarDate(targetKey, true);
        return;
      }
      targetButton = buttons.find((candidate) => candidate.dataset.date === targetKey) || null;
    }

    if (!targetButton || targetButton.disabled) return;
    event.preventDefault();
    buttons.forEach((candidate) => {
      candidate.tabIndex = candidate === targetButton ? 0 : -1;
    });
    targetButton.focus();
  }

  function openPlanner(requestedDate) {
    if (!root) {
      init();
      if (!root) return;
    }
    refreshDateBounds();
    window.clearTimeout(tourResumeTimer);
    const tourWasOpen = !!window.Inkyscib?.FeatureTour?.isOpen?.();
    if (tourWasOpen) {
      pausedFeatureTourStep = window.Inkyscib.FeatureTour.getStep?.() ?? 0;
      window.Inkyscib.FeatureTour.close({ markSeen: false });
    }
    const wasOpen = plannerOpen;
    if (!wasOpen) {
      const activeElement = document.activeElement;
      const sideMenu = document.getElementById('sideMenu');
      previousFocus = tourWasOpen
        ? document.getElementById('menuBtn')
        : activeElement && sideMenu && sideMenu.contains(activeElement)
        ? document.getElementById('menuBtn')
        : activeElement;
    }
    selectedDate = clampDateKey(
      isDateKey(requestedDate) ? requestedDate : selectedDate,
      bounds.min,
      bounds.max
    );
    viewMonth = startOfMonth(parseDateKey(selectedDate));

    closeSideMenu();
    window.clearTimeout(closeTimer);
    root.hidden = false;
    root.setAttribute('aria-hidden', 'false');
    document.body.classList.add('planner-open');
    plannerOpen = true;
    renderAll();
    updateNotificationControl();

    window.requestAnimationFrame(() => {
      root.classList.add('is-open');
      if (!wasOpen) ui.shell.focus({ preventScroll: true });
    });
  }

  function closePlanner() {
    if (!plannerOpen) return;
    closeComposer({ restoreFocus: false });
    plannerOpen = false;
    root.classList.remove('is-open');
    root.setAttribute('aria-hidden', 'true');
    document.body.classList.remove('planner-open');
    window.clearTimeout(closeTimer);
    closeTimer = window.setTimeout(() => {
      if (!plannerOpen) root.hidden = true;
    }, 190);

    const focusTarget = previousFocus && previousFocus.isConnected ? previousFocus : trigger;
    previousFocus = null;
    if (focusTarget && typeof focusTarget.focus === 'function') {
      focusTarget.focus({ preventScroll: true });
    }
    window.dispatchEvent(new Event('inkyscib:planner-close'));
    if (pausedFeatureTourStep != null) {
      window.clearTimeout(tourResumeTimer);
      tourResumeTimer = window.setTimeout(() => {
        if (plannerOpen || pausedFeatureTourStep == null) return;
        const step = pausedFeatureTourStep;
        pausedFeatureTourStep = null;
        window.Inkyscib?.FeatureTour?.open?.({ step });
      }, 210);
    }
  }

  function closeSideMenu() {
    document.body.classList.remove('menu-open');
    const sideMenu = document.getElementById('sideMenu');
    if (sideMenu) sideMenu.setAttribute('aria-hidden', 'true');
  }

  function removePlannerQueryParams() {
    if (!window.history || typeof window.history.replaceState !== 'function') return;
    const url = new URL(window.location.href);
    url.searchParams.delete('planner');
    url.searchParams.delete('date');
    const search = url.searchParams.toString();
    window.history.replaceState(
      window.history.state,
      '',
      url.pathname + (search ? '?' + search : '') + url.hash
    );
  }

  function handlePlannerMessage(event) {
    if (event.origin && event.origin !== window.location.origin) return;
    const data = event && event.data ? event.data : {};
    if (data.type !== 'INKYSCIB_OPEN_PLANNER') return;
    openPlanner(data.date);
  }

  function handleReturnToPage() {
    const previousMin = bounds.min;
    refreshDateBounds();
    if (previousMin !== bounds.min) {
      selectedDate = clampDateKey(selectedDate, bounds.min, bounds.max);
      viewMonth = startOfMonth(parseDateKey(selectedDate));
      updateMenuChip();
      if (plannerOpen) renderAll();
    } else if (plannerOpen && composerOpen && selectedDate === bounds.min) {
      renderTimeOptions();
    }
    scanReminders();
  }

  function refreshDateBounds() {
    bounds = getDateBounds(new Date());
  }

  function renderAll() {
    renderStudy();
    refreshDateBounds();
    selectedDate = clampDateKey(selectedDate, bounds.min, bounds.max);
    clampViewMonth();
    ui.range.textContent = 'Today through ' + compactDateFormatter.format(parseDateKey(bounds.max));
    renderCalendar();
    renderDay();
    if (composerOpen) {
      ui.composerDate.textContent = compactDateFormatter.format(parseDateKey(selectedDate));
      renderTimeOptions();
    }
    updateMenuChip();
  }

  function renderCalendar() {
    const year = viewMonth.getFullYear();
    const month = viewMonth.getMonth();
    const firstOfMonth = new Date(year, month, 1, 12);
    const firstCell = addCalendarDays(firstOfMonth, -firstOfMonth.getDay());
    const today = bounds.min;
    const selected = parseDateKey(selectedDate);
    const selectedIsInView = selected.getFullYear() === year && selected.getMonth() === month;
    const rovingDate = selectedIsInView
      ? selectedDate
      : clampDateKey(toDateKey(firstOfMonth), bounds.min, bounds.max);
    const summaries = buildCalendarSummaries(firstCell, 42);
    const fragment = document.createDocumentFragment();

    ui.monthLabel.textContent = monthFormatter.format(viewMonth);
    ui.prevMonth.disabled = monthOrdinal(viewMonth) <= monthOrdinal(startOfMonth(parseDateKey(bounds.min)));
    ui.nextMonth.disabled = monthOrdinal(viewMonth) >= monthOrdinal(startOfMonth(parseDateKey(bounds.max)));

    for (let index = 0; index < 42; index += 1) {
      const date = addCalendarDays(firstCell, index);
      const key = toDateKey(date);
      const inMonth = date.getMonth() === month;
      const allowed = key >= bounds.min && key <= bounds.max;
      const isSelected = key === selectedDate;
      const isToday = key === today;
      const summary = allowed ? summaries[index] : { total: 0, completed: 0 };
      const taskCount = summary.total;
      const completed = summary.completed;

      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'planner-day';
      button.dataset.date = key;
      button.disabled = !allowed;
      button.setAttribute('role', 'gridcell');
      button.setAttribute('aria-label', buildDayAriaLabel(date, taskCount, completed));
      button.setAttribute('aria-pressed', isSelected ? 'true' : 'false');
      button.setAttribute('aria-selected', isSelected ? 'true' : 'false');
      button.tabIndex = key === rovingDate ? 0 : -1;
      button.classList.toggle('is-outside', !inMonth);
      button.classList.toggle('is-selected', isSelected);
      button.classList.toggle('is-today', isToday);
      button.classList.toggle('has-tasks', taskCount > 0);
      button.classList.toggle('is-complete', taskCount > 0 && completed === taskCount);

      const number = document.createElement('span');
      number.className = 'planner-day-number';
      number.textContent = String(date.getDate());
      button.appendChild(number);

      if (taskCount) {
        const status = document.createElement('span');
        status.className = 'planner-day-status';
        status.setAttribute('aria-hidden', 'true');

        const count = document.createElement('span');
        count.className = 'planner-day-count';
        count.textContent = taskCount > 9 ? '9+' : String(taskCount);
        status.appendChild(count);

        const miniProgress = document.createElement('span');
        miniProgress.className = 'planner-day-mini-progress';
        miniProgress.style.setProperty('--day-progress', Math.round((completed / taskCount) * 100) + '%');
        status.appendChild(miniProgress);
        button.appendChild(status);
      }

      fragment.appendChild(button);
    }

    ui.calendarGrid.replaceChildren(fragment);
  }

  function buildDayAriaLabel(date, taskCount, completeCount) {
    let label = longDateFormatter.format(date);
    if (!taskCount) return label + ', no tasks';
    label += ', ' + taskCount + (taskCount === 1 ? ' task' : ' tasks');
    if (completeCount) label += ', ' + completeCount + ' complete';
    return label;
  }

  function renderDay() {
    const date = parseDateKey(selectedDate);
    const records = getOccurrencesForDate(selectedDate).sort(compareOccurrences);
    const completeCount = records.filter((record) => isTaskCompleted(record.task, record.occurrenceDate)).length;
    const percentage = records.length ? Math.round((completeCount / records.length) * 100) : 0;
    const dayDelta = calendarDayDifference(bounds.min, selectedDate);

    ui.selectedKicker.textContent = dayDelta === 0 ? 'Today' : dayDelta === 1 ? 'Tomorrow' : weekdayFormatter.format(date);
    ui.selectedDate.textContent = longDateFormatter.format(date);
    ui.progressTrack.setAttribute('aria-valuenow', String(percentage));
    ui.progressTrack.querySelector('span').style.width = percentage + '%';
    ui.progressValue.textContent = percentage + '%';

    if (!records.length) {
      ui.progressLabel.textContent = 'A fresh day';
      ui.progressMeta.textContent = 'Add a task to start building momentum.';
    } else if (completeCount === records.length) {
      ui.progressLabel.textContent = 'Day complete';
      ui.progressMeta.textContent = 'Everything is checked off. Nicely done.';
    } else if (!completeCount) {
      ui.progressLabel.textContent = records.length === 1 ? 'One clear target' : records.length + ' things to move forward';
      ui.progressMeta.textContent = 'Start anywhere. Progress will build here.';
    } else {
      ui.progressLabel.textContent = completeCount + ' of ' + records.length + ' complete';
      ui.progressMeta.textContent = (records.length - completeCount) + (records.length - completeCount === 1 ? ' task remains.' : ' tasks remain.');
    }

    const fragment = document.createDocumentFragment();
    records.forEach((record) => fragment.appendChild(buildTaskCard(record)));
    ui.taskList.replaceChildren(fragment);
    // A new day's tasks arrive in order (DESIGN.md, staggering); a re-render
    // of the same day, after a tick, does not replay it.
    if (lastStaggeredDay !== selectedDate) {
      lastStaggeredDay = selectedDate;
      window.Inkyscib?.Motion?.stagger?.(ui.taskList);
    }
    ui.emptyState.hidden = records.length > 0 || composerOpen;
    ui.taskList.hidden = records.length === 0;
    ui.addTaskBtn.hidden = composerOpen;
  }

  let lastStaggeredDay = null;

  function buildTaskCard(record) {
    const task = record.task;
    const completed = isTaskCompleted(task, record.occurrenceDate);
    const card = document.createElement('article');
    card.className = 'planner-task-card';
    card.classList.toggle('is-complete', completed);
    card.classList.toggle('is-carryover', record.carryover);

    const toggle = document.createElement('button');
    toggle.type = 'button';
    toggle.className = 'planner-task-check';
    toggle.dataset.plannerAction = 'toggle';
    toggle.dataset.taskId = task.id;
    toggle.dataset.occurrenceDate = record.occurrenceDate;
    toggle.setAttribute(
      'aria-label',
      (completed ? 'Mark task incomplete: ' : 'Mark task complete: ') + task.title
    );
    toggle.setAttribute('aria-pressed', completed ? 'true' : 'false');
    toggle.innerHTML = phIcon('phosphor:check');

    const content = document.createElement('div');
    content.className = 'planner-task-content';
    const title = document.createElement('strong');
    title.className = 'planner-task-title';
    title.textContent = task.title;
    content.appendChild(title);

    const meta = document.createElement('div');
    meta.className = 'planner-task-meta';
    if (record.carryover) {
      meta.appendChild(makeTaskMeta('Carried from ' + compactDateFormatter.format(parseDateKey(record.occurrenceDate)), 'carry'));
    }
    if (task.reminderTime) {
      meta.appendChild(makeTaskMeta(formatReminderTime(task.reminderTime), 'time'));
    } else {
      meta.appendChild(makeTaskMeta('3-hour nudge - while open', 'smart'));
    }
    if (task.recurrence !== 'none') {
      meta.appendChild(makeTaskMeta(RECURRENCE_LABELS[task.recurrence], 'repeat'));
    }
    if (task.topic) meta.prepend(makeTaskMeta(task.topic, 'topic'));
    if (task.focusMinutes) meta.appendChild(makeTaskMeta(formatMinutes(task.focusMinutes) + ' focused', 'focus'));
    if (!completed) {
      const focus = document.createElement('button');
      focus.type = 'button';
      focus.className = 'planner-task-action is-focus';
      focus.dataset.plannerAction = 'focus';
      focus.dataset.taskId = task.id;
      focus.dataset.occurrenceDate = record.occurrenceDate;
      focus.setAttribute('aria-label', 'Start a focus session for ' + task.title);
      focus.innerHTML = phIcon('phosphor:timer') + '<span>Focus</span>';
      meta.appendChild(focus);
    }
    if (task.notebookId) {
      const open = document.createElement('button');
      open.type = 'button';
      open.className = 'planner-task-action is-notebook';
      open.dataset.plannerAction = 'notebook';
      open.dataset.taskId = task.id;
      open.setAttribute('aria-label', 'Open the notebook for ' + task.title);
      open.innerHTML = phIcon('phosphor:notebook') + '<span>Open notebook</span>';
      meta.appendChild(open);
    }
    if (!completed) {
      const deviceAlert = document.createElement('button');
      deviceAlert.type = 'button';
      deviceAlert.className = 'planner-task-device';
      deviceAlert.dataset.plannerAction = 'device-calendar';
      deviceAlert.dataset.taskId = task.id;
      deviceAlert.dataset.occurrenceDate = record.occurrenceDate;
      deviceAlert.title = 'Copy this reminder to your device calendar so it can alert when MAETHIST is closed.';
      deviceAlert.setAttribute(
        'aria-label',
        'Add device calendar alert for ' + task.title +
        '. Works when MAETHIST is closed; later task changes will not sync.'
      );
      deviceAlert.innerHTML = [
        phIcon('phosphor:calendar-check'),
        '<span>Device alert</span>'
      ].join('');
      meta.appendChild(deviceAlert);
    }
    content.appendChild(meta);

    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'planner-task-delete';
    remove.dataset.plannerAction = 'delete';
    remove.dataset.taskId = task.id;
    remove.dataset.occurrenceDate = record.occurrenceDate;
    remove.setAttribute(
      'aria-label',
      (task.recurrence === 'none' ? 'Delete task: ' : 'Delete recurring task: ') + task.title
    );
    remove.innerHTML = phIcon('phosphor:trash');

    card.append(toggle, content, remove);
    return card;
  }

  function makeTaskMeta(label, type) {
    const chip = document.createElement('span');
    chip.className = 'planner-task-chip is-' + type;
    chip.textContent = label;
    return chip;
  }

  function compareOccurrences(left, right) {
    const leftDone = isTaskCompleted(left.task, left.occurrenceDate);
    const rightDone = isTaskCompleted(right.task, right.occurrenceDate);
    if (leftDone !== rightDone) return leftDone ? 1 : -1;
    if (left.carryover !== right.carryover) return left.carryover ? -1 : 1;
    const leftTime = left.task.reminderTime || '99:99';
    const rightTime = right.task.reminderTime || '99:99';
    if (leftTime !== rightTime) return leftTime.localeCompare(rightTime);
    return left.task.createdAt - right.task.createdAt;
  }

  function selectDay(dateKey) {
    if (!isDateKey(dateKey)) return;
    selectedDate = clampDateKey(dateKey, bounds.min, bounds.max);
    viewMonth = startOfMonth(parseDateKey(selectedDate));
    closeComposer({ restoreFocus: false });
    renderAll();
    focusCalendarDate(selectedDate);
    const heading = ui.selectedDate;
    if (heading) heading.scrollIntoView({ block: 'nearest', behavior: prefersReducedMotion() ? 'auto' : 'smooth' });
  }

  function changeMonth(delta) {
    viewMonth = new Date(viewMonth.getFullYear(), viewMonth.getMonth() + delta, 1, 12);
    clampViewMonth();
    renderCalendar();
  }

  function clampViewMonth() {
    const minMonth = startOfMonth(parseDateKey(bounds.min));
    const maxMonth = startOfMonth(parseDateKey(bounds.max));
    if (monthOrdinal(viewMonth) < monthOrdinal(minMonth)) viewMonth = minMonth;
    if (monthOrdinal(viewMonth) > monthOrdinal(maxMonth)) viewMonth = maxMonth;
  }

  function fillComposerChoices() {
    if (ui.topicList && !ui.topicList.childElementCount) {
      const seen = new Set();
      Object.values(CBSE_CHAPTERS).flat().forEach((chapter) => {
        if (seen.has(chapter)) return;
        seen.add(chapter);
        const option = document.createElement('option');
        option.value = chapter;
        ui.topicList.appendChild(option);
      });
    }
    const library = window.Inkyscib && window.Inkyscib.Library;
    if (!library || typeof library.listDocuments !== 'function' || !ui.taskNotebook) return;
    library.listDocuments().then((listing) => {
      const keep = ui.taskNotebook.value;
      ui.taskNotebook.replaceChildren(new Option('None', ''));
      (listing.documents || []).forEach((doc) => ui.taskNotebook.appendChild(new Option(doc.name || 'Untitled', doc.id)));
      ui.taskNotebook.value = keep && [...ui.taskNotebook.options].some((o) => o.value === keep) ? keep : '';
    }).catch(() => {});
  }

  function openComposer() {
    fillComposerChoices();
    if (composerOpen) return;
    composerOpen = true;
    resetComposer();
    ui.taskForm.hidden = false;
    ui.emptyState.hidden = true;
    ui.addTaskBtn.hidden = true;
    ui.composerDate.textContent = compactDateFormatter.format(parseDateKey(selectedDate));
    renderTimeOptions();
    window.requestAnimationFrame(() => ui.taskTitle.focus({ preventScroll: true }));
  }

  function closeComposer(options = {}) {
    if (!composerOpen) return;
    composerOpen = false;
    ui.taskForm.hidden = true;
    ui.addTaskBtn.hidden = false;
    resetComposer();
    if (plannerOpen) renderDay();
    if (options.restoreFocus !== false) focusAfterRender(ui.addTaskBtn);
  }

  function resetComposer() {
    if (ui.taskTopic) ui.taskTopic.value = '';
    if (ui.taskNotebook) ui.taskNotebook.value = '';
    ui.taskForm.reset();
    ui.formError.hidden = true;
    ui.formError.textContent = '';
    ui.timeFields.hidden = true;
    ui.reminderHint.textContent = 'Off means a smart nudge after 3 hours while MAETHIST is open.';
    ui.taskTitle.value = '';
    const defaults = defaultReminderParts(selectedDate, new Date());
    ui.hour.dataset.preferred = String(defaults.hour);
    ui.minute.dataset.preferred = String(defaults.minute);
    ui.period.dataset.preferred = defaults.period;
  }

  function syncReminderFields() {
    ui.formError.hidden = true;
    if (ui.reminderToggle.checked && !hasAnyFutureMinute(selectedDate, new Date())) {
      ui.reminderToggle.checked = false;
      showFormError('There are no reminder minutes left today. Choose tomorrow or use the automatic 3-hour nudge.');
    }
    ui.timeFields.hidden = !ui.reminderToggle.checked;
    ui.reminderHint.textContent = ui.reminderToggle.checked
      ? notificationComposerHint()
      : 'Off means a smart nudge after 3 hours while MAETHIST is open.';
    if (ui.reminderToggle.checked) renderTimeOptions();
  }

  function notificationComposerHint() {
    const state = notificationState();
    if (state === 'granted') return 'App alert ready while MAETHIST is open. After saving, use Device alert for closed-app delivery.';
    if (state === 'denied') return 'App alerts are blocked. After saving, Device alert still works through your calendar.';
    if (state === 'unsupported' || state === 'insecure') return 'After saving, use Device alert to hand this reminder to your calendar.';
    return 'App alert available while open. After saving, use Device alert for closed-app delivery.';
  }

  function renderTimeOptions() {
    if (!composerOpen) return;
    const now = new Date();
    const defaults = defaultReminderParts(selectedDate, now);
    const preferredPeriod = ui.period.value || ui.period.dataset.preferred || defaults.period;
    const preferredHour = Number(ui.hour.value || ui.hour.dataset.preferred || defaults.hour);
    const preferredMinute = Number(ui.minute.value || ui.minute.dataset.preferred || defaults.minute);

    const periods = ['AM', 'PM'].map((period) => ({
      value: period,
      label: period,
      disabled: !timePeriodHasValidMinute(selectedDate, period, now)
    }));
    setSelectOptions(ui.period, periods, preferredPeriod);

    const chosenPeriod = ui.period.value || firstEnabledValue(periods) || 'AM';
    const hours = [];
    for (let hour = 1; hour <= 12; hour += 1) {
      hours.push({
        value: String(hour),
        label: String(hour).padStart(2, '0'),
        disabled: !hourHasValidMinute(selectedDate, hour, chosenPeriod, now)
      });
    }
    setSelectOptions(ui.hour, hours, String(preferredHour));

    const chosenHour = Number(ui.hour.value || firstEnabledValue(hours) || 1);
    const minutes = [];
    for (let minute = 0; minute < 60; minute += 1) {
      const time = partsToTime(chosenHour, minute, chosenPeriod);
      minutes.push({
        value: String(minute),
        label: String(minute).padStart(2, '0'),
        disabled: !isReminderTimeAllowed(selectedDate, time, now)
      });
    }
    setSelectOptions(ui.minute, minutes, String(preferredMinute));

    ui.period.dataset.preferred = ui.period.value;
    ui.hour.dataset.preferred = ui.hour.value;
    ui.minute.dataset.preferred = ui.minute.value;
  }

  function setSelectOptions(select, options, preferredValue) {
    const fragment = document.createDocumentFragment();
    options.forEach((optionData) => {
      const option = document.createElement('option');
      option.value = optionData.value;
      option.textContent = optionData.label;
      option.disabled = !!optionData.disabled;
      fragment.appendChild(option);
    });
    select.replaceChildren(fragment);
    const preferred = options.find((option) => option.value === String(preferredValue) && !option.disabled);
    const fallback = options.find((option) => !option.disabled);
    select.value = preferred ? preferred.value : fallback ? fallback.value : '';
    select.disabled = !fallback;
  }

  function firstEnabledValue(options) {
    const enabled = options.find((option) => !option.disabled);
    return enabled ? enabled.value : '';
  }

  function addTask(event) {
    event.preventDefault();
    const title = ui.taskTitle.value.trim().replace(/\s+/g, ' ');
    if (!title) {
      showFormError('Give this task a short, clear name.');
      ui.taskTitle.focus();
      return;
    }

    let reminderTime = null;
    if (ui.reminderToggle.checked) {
      reminderTime = partsToTime(Number(ui.hour.value), Number(ui.minute.value), ui.period.value);
      if (!isReminderTimeAllowed(selectedDate, reminderTime, new Date())) {
        showFormError('Pick a reminder time that is still ahead on this day.');
        renderTimeOptions();
        return;
      }
    }

    const repeatInput = ui.taskForm.querySelector('input[name="plannerRepeat"]:checked');
    const recurrence = repeatInput && RECURRENCE_LABELS[repeatInput.value] ? repeatInput.value : 'none';
    const task = {
      id: makeId(),
      title: title.slice(0, 120),
      startDate: selectedDate,
      recurrence,
      reminderTime,
      createdAt: Date.now(),
      completed: {},
      topic: (ui.taskTopic.value || '').trim().slice(0, 60),
      notebookId: ui.taskNotebook.value || '',
      focusMinutes: 0,
      notified: {
        reminder: {},
        auto: {}
      }
    };

    if (store.tasks.length >= MAX_TASKS) {
      showFormError('Your planner is full. Remove an old task before adding another.');
      return;
    }

    store.tasks.push(task);
    persistStore();
    composerOpen = false;
    ui.taskForm.hidden = true;
    resetComposer();
    renderAll();
    focusTaskToggle(task.id, selectedDate);
    scheduleReminderScan(250);

    const toastOptions = {
      title: 'Added to your day',
      message: reminderTime
        ? title + ' at ' + formatReminderTime(reminderTime)
        : title + ' - smart nudge in 3 hours if unfinished',
      kind: 'success',
      actionLabel: 'Alert when closed',
      onAction: () => promptDeviceCalendar(task.id, task.startDate)
    };
    showToast(toastOptions);
  }

  function showFormError(message) {
    ui.formError.textContent = message;
    ui.formError.hidden = false;
    // Tie the message to the field, so a screen reader says why it failed.
    if (!ui.formError.id) ui.formError.id = 'plannerFormError';
    ui.taskTitle.setAttribute('aria-invalid', 'true');
    ui.taskTitle.setAttribute('aria-describedby', ui.formError.id);
    ui.taskTitle.addEventListener('input', () => {
      ui.taskTitle.removeAttribute('aria-invalid');
      ui.formError.hidden = true;
    }, { once: true });
  }

  function toggleTask(taskId, occurrenceDate) {
    const task = store.tasks.find((item) => item.id === taskId);
    if (!task || !isDateKey(occurrenceDate)) return;
    const wasCompleted = isTaskCompleted(task, occurrenceDate);

    if (wasCompleted) {
      delete task.completed[occurrenceDate];
    } else {
      task.completed[occurrenceDate] = Date.now();
    }

    persistStore();
    renderAll();
    focusTaskToggle(task.id, occurrenceDate);
    scheduleReminderScan(250);

    if (!wasCompleted) {
      // Secondary action: the tick pops while the bar fills.
      const tick = ui.taskList.querySelector(`.planner-task-check[data-task-id="${CSS.escape(task.id)}"][data-occurrence-date="${occurrenceDate}"]`);
      if (tick) {
        tick.classList.remove('is-just-done');
        void tick.offsetWidth;
        tick.classList.add('is-just-done');
      }
      const records = getOccurrencesForDate(selectedDate);
      const allDone = records.length && records.every((record) => isTaskCompleted(record.task, record.occurrenceDate));
      if (allDone) {
        celebrateProgress();
        showToast({
          title: 'Day complete',
          message: 'Everything is checked off. Take the win.',
          kind: 'celebrate'
        });
      }
    }
  }

  function deleteTask(taskId) {
    const index = store.tasks.findIndex((task) => task.id === taskId);
    if (index < 0) return;
    const removed = store.tasks[index];
    store.tasks.splice(index, 1);
    persistStore();
    renderAll();
    focusAfterRender(ui.addTaskBtn);
    scheduleReminderScan(250);

    showToast({
      title: removed.recurrence === 'none' ? 'Task removed' : 'Recurring task removed',
      message: removed.title,
      kind: 'neutral',
      actionLabel: 'Undo',
      duration: removed.recurrence === 'none' ? 6200 : 9000,
      onAction: () => {
        if (store.tasks.some((task) => task.id === removed.id)) return;
        store.tasks.splice(Math.min(index, store.tasks.length), 0, removed);
        persistStore();
        if (plannerOpen) renderAll();
        updateMenuChip();
        scheduleReminderScan(250);
      }
    });
  }

  function celebrateProgress() {
    window.clearTimeout(celebrationTimer);
    ui.progressCard.classList.remove('is-celebrating');
    void ui.progressCard.offsetWidth;
    ui.progressCard.classList.add('is-celebrating');
    celebrationTimer = window.setTimeout(() => {
      ui.progressCard.classList.remove('is-celebrating');
    }, 900);
  }

  function focusAfterRender(element) {
    window.requestAnimationFrame(() => {
      if (!plannerOpen || !element || element.hidden || !element.isConnected) return;
      element.focus({ preventScroll: true });
    });
  }

  function focusCalendarDate(dateKey, makeRoving) {
    window.requestAnimationFrame(() => {
      if (!plannerOpen) return;
      const buttons = Array.from(ui.calendarGrid.querySelectorAll('button[data-date]'));
      const button = buttons
        .find((candidate) => candidate.dataset.date === dateKey);
      if (!button) return;
      if (makeRoving) {
        buttons.forEach((candidate) => {
          candidate.tabIndex = candidate === button ? 0 : -1;
        });
      }
      button.focus({ preventScroll: true });
    });
  }

  function focusTaskToggle(taskId, occurrenceDate) {
    window.requestAnimationFrame(() => {
      if (!plannerOpen) return;
      const button = Array.from(ui.taskList.querySelectorAll('button[data-planner-action="toggle"]'))
        .find((candidate) =>
          candidate.dataset.taskId === taskId &&
          candidate.dataset.occurrenceDate === occurrenceDate
        );
      if (button) {
        button.focus({ preventScroll: true });
      } else {
        ui.addTaskBtn.focus({ preventScroll: true });
      }
    });
  }

  function updateMenuChip() {
    const chip = trigger ? trigger.querySelector('.planner-menu-chip') : null;
    if (!chip) return;
    refreshDateBounds();
    const remaining = getOccurrencesForDate(bounds.min)
      .filter((record) => !isTaskCompleted(record.task, record.occurrenceDate)).length;
    chip.textContent = remaining ? remaining + (remaining === 1 ? ' today' : ' today') : 'Local';
    chip.classList.toggle('has-plans', remaining > 0);
  }

  function getOccurrencesForDate(dateKey) {
    const occurrences = [];
    const today = bounds.min;

    store.tasks.forEach((task) => {
      if (taskOccursOn(task, dateKey)) {
        occurrences.push({
          task,
          occurrenceDate: dateKey,
          carryover: false
        });
      }

      if (
        dateKey === today &&
        task.recurrence === 'none' &&
        task.startDate < today &&
        !isTaskCompleted(task, task.startDate)
      ) {
        occurrences.push({
          task,
          occurrenceDate: task.startDate,
          carryover: true
        });
      }

      if (isInitialRecurringCarryover(task, dateKey)) {
        occurrences.push({
          task,
          occurrenceDate: task.startDate,
          carryover: true
        });
      }
    });

    return occurrences;
  }

  function buildCalendarSummaries(firstDate, dayCount) {
    const keys = [];
    const keyIndexes = new Map();
    const summaries = Array.from({ length: dayCount }, () => ({
      total: 0,
      completed: 0
    }));

    for (let index = 0; index < dayCount; index += 1) {
      const key = toDateKey(addCalendarDays(firstDate, index));
      keys.push(key);
      keyIndexes.set(key, index);
    }

    const firstKey = keys[0];
    const lastKey = keys[keys.length - 1];
    const todayIndex = keyIndexes.get(bounds.min);

    const addOccurrence = (task, index, occurrenceDate) => {
      if (
        index == null ||
        index < 0 ||
        index >= dayCount ||
        keys[index] < bounds.min ||
        keys[index] > bounds.max
      ) return;
      summaries[index].total += 1;
      if (isTaskCompleted(task, occurrenceDate)) {
        summaries[index].completed += 1;
      }
    };

    store.tasks.forEach((task) => {
      if (task.recurrence === 'none') {
        if (task.startDate >= firstKey && task.startDate <= lastKey) {
          addOccurrence(task, keyIndexes.get(task.startDate), task.startDate);
        }
        if (
          todayIndex != null &&
          task.startDate < bounds.min &&
          !isTaskCompleted(task, task.startDate)
        ) {
          addOccurrence(task, todayIndex, task.startDate);
        }
        return;
      }

      if (task.startDate > lastKey) return;
      let firstIndex;
      let step;
      if (task.recurrence === 'daily') {
        firstIndex = task.startDate <= firstKey
          ? 0
          : keyIndexes.get(task.startDate);
        step = 1;
      } else if (task.recurrence === 'weekly') {
        if (task.startDate <= firstKey) {
          const elapsed = calendarDayDifference(task.startDate, firstKey);
          firstIndex = (7 - (elapsed % 7)) % 7;
        } else {
          firstIndex = keyIndexes.get(task.startDate);
        }
        step = 7;
      } else {
        return;
      }

      if (firstIndex == null) return;
      for (let index = firstIndex; index < dayCount; index += step) {
        addOccurrence(task, index, keys[index]);
      }
      if (todayIndex != null && isInitialRecurringCarryover(task, bounds.min)) {
        addOccurrence(task, todayIndex, task.startDate);
      }
    });

    return summaries;
  }

  function isInitialRecurringCarryover(task, dateKey) {
    if (
      task.recurrence === 'none' ||
      dateKey !== bounds.min ||
      calendarDayDifference(task.startDate, dateKey) !== 1 ||
      toDateKey(new Date(task.createdAt)) !== task.startDate ||
      isTaskCompleted(task, task.startDate)
    ) {
      return false;
    }
    return automaticNudgeAt(task, task.startDate) >= timestampFor(dateKey, '00:00');
  }

  function taskOccursOn(task, dateKey) {
    if (!task || !isDateKey(dateKey) || dateKey < task.startDate) return false;
    if (task.recurrence === 'none') return dateKey === task.startDate;
    if (task.recurrence === 'daily') return true;
    if (task.recurrence === 'weekly') {
      return calendarDayDifference(task.startDate, dateKey) % 7 === 0;
    }
    return false;
  }

  function isTaskCompleted(task, occurrenceDate) {
    return !!(task.completed && task.completed[occurrenceDate]);
  }

  function requestNotificationAccess(options = {}) {
    primeReminderAudio();
    const sendTest = options && options.sendTest === true;
    const state = notificationState();
    if (state === 'unsupported') {
      showToast({
        title: 'In-app reminders are on',
        message: 'This browser does not offer device notifications.',
        kind: 'neutral'
      });
      return Promise.resolve(false);
    }
    if (state === 'insecure') {
      showToast({
        title: 'In-app reminders are on',
        message: 'Device alerts need HTTPS or localhost in this browser.',
        kind: 'neutral'
      });
      return Promise.resolve(false);
    }
    if (state === 'denied') {
      showToast({
        title: 'Device alerts are blocked',
        message: 'Allow notifications for this site in your browser settings. In-app reminders still work.',
        kind: 'warning'
      });
      return Promise.resolve(false);
    }
    if (state === 'granted') {
      return ensureNotificationRegistration().then(() => {
        updateNotificationControl();
        if (sendTest) {
          scheduleNotificationTest();
          return true;
        }
        showToast({
          title: 'App reminders are ready',
          message: 'System alerts work while MAETHIST is open. Use a task\'s Device alert for closed-app reminders.',
          kind: 'success'
        });
        return true;
      }).catch(() => {
        updateNotificationControl();
        showToast({
          title: 'System alert test unavailable',
          message: 'The browser could not start the notification worker. In-app reminders still work.',
          kind: 'warning'
        });
        return false;
      });
    }

    let permissionPromise;
    try {
      permissionPromise = Notification.requestPermission();
    } catch (error) {
      permissionPromise = Promise.resolve('default');
    }

    return Promise.resolve(permissionPromise).then((permission) => {
      updateNotificationControl();
      if (permission !== 'granted') {
        showToast({
          title: 'In-app reminders stay on',
          message: permission === 'denied'
            ? 'Device alerts were blocked. You can change that in browser settings.'
            : 'Device alerts were not enabled.',
          kind: 'neutral'
        });
        return false;
      }
      return ensureNotificationRegistration().then(() => {
        updateNotificationControl();
        if (sendTest) {
          scheduleNotificationTest();
          return true;
        }
        showToast({
          title: 'App reminders enabled',
          message: 'System alerts work while MAETHIST is open. Use a task\'s Device alert for closed-app reminders.',
          kind: 'success'
        });
        return true;
      }).catch(() => {
        showToast({
          title: 'In-app reminders are ready',
          message: 'The browser could not start device alerts on this page.',
          kind: 'warning'
        });
        return false;
      });
    });
  }

  function notificationState() {
    if (!('Notification' in window)) return 'unsupported';
    if (!window.isSecureContext) return 'insecure';
    if (Notification.permission === 'granted') return 'granted';
    if (Notification.permission === 'denied') return 'denied';
    return 'default';
  }

  function updateNotificationControl() {
    if (!ui.notifyBtn) return;
    const state = notificationState();
    ui.notifyBtn.dataset.state = state;
    delete ui.notifyBtn.dataset.testing;
    if (state === 'granted' && notificationTestTimer) {
      ui.notifyBtn.dataset.testing = 'true';
      ui.notifyText.textContent = 'Test in 5 seconds';
      ui.notifyBtn.title = 'Lock your screen now. MAETHIST will send a system notification with your device sound settings.';
    } else if (state === 'granted') {
      ui.notifyText.textContent = 'Reminders on · test';
      ui.notifyBtn.title = 'Test app alerts while MAETHIST remains open. Device alert on each task works after closing it.';
    } else if (state === 'denied') {
      ui.notifyText.textContent = 'Alerts blocked';
      ui.notifyBtn.title = 'Enable notifications for this site in browser settings.';
    } else if (state === 'unsupported' || state === 'insecure') {
      ui.notifyText.textContent = 'In-app reminders';
      ui.notifyBtn.title = 'System notifications are not available here. In-app reminders still work.';
    } else {
      ui.notifyText.textContent = 'Enable reminders';
      ui.notifyBtn.title = 'Turn on system alerts while MAETHIST is open. Use Device alert for closed-app reminders.';
    }
    ui.notifyBtn.setAttribute('aria-label', ui.notifyText.textContent + '. ' + ui.notifyBtn.title);
    if (composerOpen) ui.reminderHint.textContent = ui.reminderToggle.checked
      ? notificationComposerHint()
      : 'Off means a smart nudge after 3 hours while MAETHIST is open.';
  }

  function scheduleNotificationTest() {
    window.clearTimeout(notificationTestTimer);
    notificationTestTimer = window.setTimeout(() => {
      notificationTestTimer = 0;
      updateNotificationControl();
      const testDate = toDateKey(new Date());
      dispatchDeviceNotification(
        'MAETHIST Planner',
        'Lock-screen test — planner notifications are ready.',
        testDate,
        'inkyscib-planner-lock-screen-test',
        Date.now(),
        { forceSystemAlert: true, renotify: true }
      ).then((success) => {
        if (document.hidden) return;
        showToast({
          title: success ? 'Test alert sent' : 'Test alert could not be sent',
          message: success
            ? 'If it was hidden or silent, allow MAETHIST on the lock screen and turn on notification sound in device settings.'
            : 'Check this site’s notification permission, then try again.',
          kind: success ? 'success' : 'warning',
          duration: 7600
        });
      });
    }, 5000);
    updateNotificationControl();
    showToast({
      title: 'Lock-screen test armed',
      message: 'The alert arrives in 5 seconds. Lock your screen now.',
      kind: 'reminder',
      duration: 6200
    });
  }

  function primeReminderAudio() {
    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    if (!AudioContextClass) return Promise.resolve(false);
    try {
      if (!reminderAudioContext || reminderAudioContext.state === 'closed') {
        reminderAudioContext = new AudioContextClass();
      }
      if (reminderAudioContext.state === 'running') {
        reminderAudioUnlocked = true;
        return Promise.resolve(true);
      }
      return Promise.resolve(reminderAudioContext.resume()).then(() => {
        reminderAudioUnlocked = reminderAudioContext.state === 'running';
        return reminderAudioUnlocked;
      }).catch(() => false);
    } catch (error) {
      return Promise.resolve(false);
    }
  }

  function playReminderChime() {
    if (
      document.hidden ||
      notificationState() !== 'granted' ||
      !reminderAudioContext
    ) {
      return false;
    }

    const play = () => {
      if (document.hidden || reminderAudioContext.state !== 'running') return false;
      const startAt = reminderAudioContext.currentTime + 0.015;
      const tones = [
        { frequency: 740, offset: 0, duration: 0.18, volume: 0.034 },
        { frequency: 940, offset: 0.12, duration: 0.22, volume: 0.026 }
      ];

      try {
        tones.forEach((tone) => {
          const oscillator = reminderAudioContext.createOscillator();
          const gain = reminderAudioContext.createGain();
          const toneStart = startAt + tone.offset;
          const toneEnd = toneStart + tone.duration;

          oscillator.type = 'sine';
          oscillator.frequency.setValueAtTime(tone.frequency, toneStart);
          gain.gain.setValueAtTime(0.0001, toneStart);
          gain.gain.exponentialRampToValueAtTime(tone.volume, toneStart + 0.025);
          gain.gain.exponentialRampToValueAtTime(0.0001, toneEnd);
          oscillator.connect(gain);
          gain.connect(reminderAudioContext.destination);
          oscillator.onended = () => {
            oscillator.disconnect();
            gain.disconnect();
          };
          oscillator.start(toneStart);
          oscillator.stop(toneEnd + 0.02);
        });
        return true;
      } catch (error) {
        return false;
      }
    };

    if (reminderAudioContext.state === 'running') return play();
    if (!reminderAudioUnlocked) return false;
    Promise.resolve(reminderAudioContext.resume())
      .then(() => play())
      .catch(() => false);
    return true;
  }

  function ensureNotificationRegistration() {
    if (!('serviceWorker' in navigator)) {
      return Promise.reject(new Error('Service workers are unavailable'));
    }
    if (serviceWorkerRegistrationPromise) return serviceWorkerRegistrationPromise;

    serviceWorkerRegistrationPromise = navigator.serviceWorker
      .register(SERVICE_WORKER_URL, { scope: SERVICE_WORKER_SCOPE })
      .then((registration) => waitForActiveRegistration(registration))
      .catch((error) => {
        serviceWorkerRegistrationPromise = null;
        throw error;
      });
    return serviceWorkerRegistrationPromise;
  }

  function waitForActiveRegistration(registration) {
    if (registration.active) return Promise.resolve(registration);
    const worker = registration.installing || registration.waiting;
    if (!worker) {
      return Promise.reject(new Error('Planner notification worker is unavailable'));
    }

    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (active) => {
        if (settled) return;
        settled = true;
        if (active || registration.active) {
          resolve(registration);
        } else {
          reject(new Error('Planner notification worker did not activate'));
        }
      };
      worker.addEventListener('statechange', () => {
        if (worker.state === 'activated' || registration.active) finish(true);
        if (worker.state === 'redundant') finish(false);
      });
      window.setTimeout(() => finish(false), 5000);
    });
  }

  function dispatchDeviceNotification(title, body, date, tag, timestamp, deliveryOptions = {}) {
    if (notificationState() !== 'granted') return Promise.resolve(false);
    const targetUrl = window.location.pathname + '?planner=1&date=' + encodeURIComponent(date);
    const useSystemAlert = deliveryOptions.forceSystemAlert === true || document.hidden;
    const options = {
      body,
      icon: '/static/icons/maethist-192.png',
      badge: '/static/icons/maethist-badge-96.png',
      tag,
      timestamp,
      renotify: deliveryOptions.renotify === true,
      requireInteraction: useSystemAlert,
      actions: [
        {
          action: 'open-planner',
          title: 'Open planner'
        }
      ],
      data: {
        date,
        url: targetUrl
      }
    };
    if (useSystemAlert) {
      options.vibrate = [120, 70, 120];
    } else {
      // The in-app chime handles foreground reminders without a double sound.
      options.silent = true;
    }

    return ensureNotificationRegistration()
      .then((registration) => registration.showNotification(title, options))
      .then(() => true)
      .catch(() => {
        try {
          const fallbackOptions = Object.assign({}, options);
          delete fallbackOptions.actions;
          const notification = new Notification(title, fallbackOptions);
          notification.onclick = () => {
            window.focus();
            openPlanner(date);
            notification.close();
          };
          return true;
        } catch (error) {
          return false;
        }
      });
  }

  function promptDeviceCalendar(taskId, occurrenceDate) {
    const task = store.tasks.find((item) => item.id === taskId);
    if (!task) return;
    const copiedReminder = task.reminderTime
      ? (task.recurrence === 'none' ? 'this reminder' : 'this repeating reminder')
      : (task.recurrence === 'none' ? 'the 3-hour nudge' : 'this repeating smart nudge');

    showToast({
      title: 'Alerts when MAETHIST is closed',
      message: 'Your device calendar gets a copy of ' + copiedReminder +
        '. Later edits, completion, or deletion in MAETHIST will not sync to that copy.',
      kind: 'reminder',
      actionLabel: 'Create calendar file',
      duration: 11000,
      onAction: () => exportTaskToDeviceCalendar(task.id, occurrenceDate)
    });
  }

  function exportTaskToDeviceCalendar(taskId, occurrenceDate) {
    const task = store.tasks.find((item) => item.id === taskId);
    if (!task) return Promise.resolve(false);

    const calendar = buildDeviceCalendar(task, occurrenceDate, new Date());
    if (!calendar.events.length) {
      showToast({
        title: 'No device alert needed',
        message: 'This one-time task is already complete, so no calendar reminder was created.',
        kind: 'neutral',
        duration: 7000
      });
      return Promise.resolve(false);
    }

    const mediaType = 'text/calendar;charset=utf-8';
    let file;
    try {
      file = typeof File === 'function'
        ? new File([calendar.content], calendar.filename, { type: mediaType })
        : new Blob([calendar.content], { type: mediaType });
    } catch (error) {
      showDeviceCalendarError();
      return Promise.resolve(false);
    }

    let canShareFile = false;
    if (
      typeof File === 'function' &&
      file instanceof File &&
      typeof navigator.share === 'function' &&
      typeof navigator.canShare === 'function'
    ) {
      try {
        canShareFile = navigator.canShare({ files: [file] });
      } catch (error) {
        canShareFile = false;
      }
    }

    if (canShareFile) {
      let sharePromise;
      try {
        // Keep this call in the original click stack: Web Share requires
        // transient user activation on mobile browsers.
        sharePromise = navigator.share({
          files: [file],
          title: 'MAETHIST Planner',
          text: 'Add this local reminder to your device calendar.'
        });
      } catch (error) {
        sharePromise = Promise.reject(error);
      }

      return Promise.resolve(sharePromise)
        .then(() => {
          showDeviceCalendarReady('shared', calendar.hasCatchUp);
          return true;
        })
        .catch((error) => {
          if (error && error.name === 'AbortError') return false;
          const downloaded = downloadDeviceCalendarFile(file, calendar.filename);
          if (downloaded) {
            showDeviceCalendarReady('downloaded', calendar.hasCatchUp);
          } else {
            showDeviceCalendarError();
          }
          return downloaded;
        });
    }

    const downloaded = downloadDeviceCalendarFile(file, calendar.filename);
    if (downloaded) {
      showDeviceCalendarReady('downloaded', calendar.hasCatchUp);
    } else {
      showDeviceCalendarError();
    }
    return Promise.resolve(downloaded);
  }

  function downloadDeviceCalendarFile(file, filename) {
    if (!window.URL || typeof window.URL.createObjectURL !== 'function') return false;
    try {
      const url = window.URL.createObjectURL(file);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = filename;
      anchor.rel = 'noopener';
      anchor.hidden = true;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      window.setTimeout(() => window.URL.revokeObjectURL(url), 30000);
      return true;
    } catch (error) {
      return false;
    }
  }

  function showDeviceCalendarReady(delivery, hasCatchUp) {
    const lead = delivery === 'shared'
      ? 'Choose your calendar app and tap Add or Save.'
      : 'Open the downloaded .ics file and tap Add or Save.';
    showToast({
      title: 'Calendar file ready',
      message: lead + (hasCatchUp
        ? ' An overdue alert was moved about five minutes ahead so there is time to import it.'
        : ' Your calendar can then alert even when MAETHIST is closed.'),
      kind: 'success',
      duration: 11000
    });
  }

  function showDeviceCalendarError() {
    showToast({
      title: 'Calendar file unavailable',
      message: 'This browser could not create the local calendar handoff. Try again from Chrome, Edge, or Safari.',
      kind: 'warning',
      duration: 8500
    });
  }

  function buildDeviceCalendar(task, occurrenceDate, nowValue) {
    const now = nowValue instanceof Date && Number.isFinite(nowValue.getTime())
      ? new Date(nowValue.getTime())
      : new Date();
    const events = buildDeviceCalendarEvents(task, occurrenceDate, now);
    const stamp = formatIcsUtc(now);
    const created = formatIcsUtc(new Date(task.createdAt));
    const sequence = deviceCalendarSequence(task, now);
    const safeTaskId = safeIcsTaskId(task.id);
    const lines = [
      'BEGIN:VCALENDAR',
      'PRODID:-//Inkyscib//Planner Device Alerts//EN',
      'VERSION:2.0',
      'CALSCALE:GREGORIAN',
      'METHOD:PUBLISH',
      'X-WR-CALNAME:' + escapeIcsText('MAETHIST Planner')
    ];

    events.forEach((event) => {
      const reminderType = task.reminderTime
        ? 'Scheduled reminder'
        : 'Smart nudge';
      const recurrenceCopy = event.recurrence
        ? ' Repeats ' + (event.recurrence === 'daily' ? 'daily.' : 'weekly.')
        : '';
      const description = reminderType + ' copied from MAETHIST.' + recurrenceCopy +
        ' This device-calendar copy can alert while MAETHIST is closed. ' +
        'Later edits, completion, or deletion in MAETHIST do not sync to Calendar.';

      lines.push(
        'BEGIN:VEVENT',
        'UID:' + safeTaskId + '.' + event.uidKind + '@planner.maethist',
        'DTSTAMP:' + stamp,
        'CREATED:' + created,
        'LAST-MODIFIED:' + stamp,
        'SEQUENCE:' + sequence,
        'DTSTART:' + formatIcsLocal(event.startAt),
        'DURATION:PT15M'
      );
      if (event.recurrence && event.count > 0) {
        lines.push(
          'RRULE:FREQ=' + event.recurrence.toUpperCase() + ';COUNT=' + event.count
        );
      }
      if (event.excludeDates.length) {
        lines.push(
          'EXDATE:' + event.excludeDates
            .map((dateKey) => formatIcsLocal(timestampFor(dateKey, event.timeValue)))
            .join(',')
        );
      }
      lines.push(
        'SUMMARY:' + escapeIcsText(task.title),
        'DESCRIPTION:' + escapeIcsText(description),
        'CATEGORIES:' + escapeIcsText('MAETHIST Planner'),
        'STATUS:CONFIRMED',
        'TRANSP:TRANSPARENT',
        'BEGIN:VALARM',
        'ACTION:DISPLAY',
        'TRIGGER:PT0S',
        'DESCRIPTION:' + escapeIcsText('MAETHIST reminder - ' + task.title),
        'END:VALARM',
        'END:VEVENT'
      );
    });

    lines.push('END:VCALENDAR');
    return {
      content: lines.map(foldIcsLine).join('\r\n') + '\r\n',
      filename: deviceCalendarFilename(task, occurrenceDate),
      events,
      hasCatchUp: events.some((event) => event.catchUp)
    };
  }

  function buildDeviceCalendarEvents(task, occurrenceDate, now) {
    const events = [];
    const nowTimestamp = now.getTime();
    const today = toDateKey(now);
    const maxDate = getDateBounds(now).max;
    const requestedOccurrence = isDateKey(occurrenceDate) &&
      taskOccursOn(task, occurrenceDate)
      ? occurrenceDate
      : task.startDate;

    const addOneTimeEvent = (uidKind, startAt, catchUp) => {
      events.push({
        uidKind,
        startAt,
        timeValue: timeValueForTimestamp(startAt),
        recurrence: null,
        count: 0,
        excludeDates: [],
        catchUp: !!catchUp
      });
    };

    const addCatchUp = (uidKind) => {
      addOneTimeEvent(uidKind, nextDeviceCalendarCatchUpAt(now), true);
    };

    const addSeries = (uidKind, timeValue, seedDate) => {
      let startDate = advanceOccurrenceToAtLeast(task, seedDate, today);
      if (!startDate || startDate > maxDate) return;
      const dueAt = timestampFor(startDate, timeValue);
      const completed = isTaskCompleted(task, startDate);
      if (dueAt <= nowTimestamp || completed) {
        if (dueAt <= nowTimestamp && !completed) {
          addCatchUp(uidKind + '-overdue-' + compactIcsDate(startDate));
        }
        startDate = nextTaskOccurrence(task, startDate);
      }
      if (!startDate) return;
      startDate = advanceOccurrenceToAtLeast(task, startDate, today);
      if (!startDate || startDate > maxDate) return;

      const count = recurringOccurrenceCount(startDate, maxDate, task.recurrence);
      if (!count) return;
      const excludeDates = Object.keys(task.completed || {})
        .filter((dateKey) =>
          dateKey >= startDate &&
          dateKey <= maxDate &&
          taskOccursOn(task, dateKey)
        )
        .sort();
      events.push({
        uidKind,
        startAt: timestampFor(startDate, timeValue),
        timeValue,
        recurrence: task.recurrence,
        count,
        excludeDates,
        catchUp: false
      });
    };

    if (task.recurrence === 'none') {
      if (isTaskCompleted(task, task.startDate)) return events;
      const dueAt = task.reminderTime
        ? timestampFor(task.startDate, task.reminderTime)
        : automaticNudgeAt(task, task.startDate);
      if (dueAt <= nowTimestamp) {
        addCatchUp(task.reminderTime ? 'explicit-overdue' : 'auto-overdue');
      } else {
        addOneTimeEvent(task.reminderTime ? 'explicit' : 'auto', dueAt, false);
      }
      return events;
    }

    if (task.reminderTime) {
      addSeries('explicit-series', task.reminderTime, requestedOccurrence);
      return events;
    }

    const createdOnStartDate = toDateKey(new Date(task.createdAt)) === task.startDate;
    let seriesSeed = requestedOccurrence;
    if (createdOnStartDate && requestedOccurrence === task.startDate) {
      if (!isTaskCompleted(task, task.startDate)) {
        const firstDueAt = automaticNudgeAt(task, task.startDate);
        if (firstDueAt <= nowTimestamp) {
          addCatchUp('auto-first-overdue');
        } else {
          addOneTimeEvent('auto-first', firstDueAt, false);
        }
      }
      seriesSeed = nextTaskOccurrence(task, task.startDate);
    }
    if (seriesSeed) addSeries('auto-series', '12:00', seriesSeed);
    return events;
  }

  function advanceOccurrenceToAtLeast(task, dateKey, minimumDate) {
    let cursor = isDateKey(dateKey) ? dateKey : task.startDate;
    let guard = 0;
    while (cursor && cursor < minimumDate && guard < 1000) {
      cursor = nextTaskOccurrence(task, cursor);
      guard += 1;
    }
    return cursor;
  }

  function nextTaskOccurrence(task, dateKey) {
    if (!isDateKey(dateKey) || task.recurrence === 'none') return '';
    const dayStep = task.recurrence === 'weekly' ? 7 : 1;
    return toDateKey(addCalendarDays(parseDateKey(dateKey), dayStep));
  }

  function recurringOccurrenceCount(startDate, maxDate, recurrence) {
    const difference = calendarDayDifference(startDate, maxDate);
    if (difference < 0) return 0;
    return recurrence === 'weekly'
      ? Math.floor(difference / 7) + 1
      : difference + 1;
  }

  function nextDeviceCalendarCatchUpAt(now) {
    const catchUp = new Date(now.getTime() + DEVICE_CALENDAR_CATCHUP_MS);
    if (catchUp.getSeconds() || catchUp.getMilliseconds()) {
      catchUp.setMinutes(catchUp.getMinutes() + 1);
    }
    catchUp.setSeconds(0, 0);
    return catchUp.getTime();
  }

  function timeValueForTimestamp(timestamp) {
    const date = new Date(timestamp);
    return String(date.getHours()).padStart(2, '0') + ':' +
      String(date.getMinutes()).padStart(2, '0');
  }

  function formatIcsLocal(value) {
    const date = value instanceof Date ? value : new Date(value);
    return [
      date.getFullYear(),
      String(date.getMonth() + 1).padStart(2, '0'),
      String(date.getDate()).padStart(2, '0'),
      'T',
      String(date.getHours()).padStart(2, '0'),
      String(date.getMinutes()).padStart(2, '0'),
      String(date.getSeconds()).padStart(2, '0')
    ].join('');
  }

  function formatIcsUtc(value) {
    const date = value instanceof Date && Number.isFinite(value.getTime())
      ? value
      : new Date();
    return [
      date.getUTCFullYear(),
      String(date.getUTCMonth() + 1).padStart(2, '0'),
      String(date.getUTCDate()).padStart(2, '0'),
      'T',
      String(date.getUTCHours()).padStart(2, '0'),
      String(date.getUTCMinutes()).padStart(2, '0'),
      String(date.getUTCSeconds()).padStart(2, '0'),
      'Z'
    ].join('');
  }

  function escapeIcsText(value) {
    return String(value)
      .replace(/\\/g, '\\\\')
      .replace(/\r\n|\r|\n/g, '\\n')
      .replace(/;/g, '\\;')
      .replace(/,/g, '\\,');
  }

  function foldIcsLine(value) {
    const line = String(value);
    const chunks = [];
    let current = '';
    let byteLength = 0;
    for (const character of line) {
      const characterBytes = utf8OctetLength(character);
      const byteLimit = chunks.length ? 74 : 75;
      if (current && byteLength + characterBytes > byteLimit) {
        chunks.push(current);
        current = character;
        byteLength = characterBytes;
      } else {
        current += character;
        byteLength += characterBytes;
      }
    }
    chunks.push(current);
    return chunks
      .map((chunk, index) => (index ? ' ' : '') + chunk)
      .join('\r\n');
  }

  function utf8OctetLength(character) {
    const codePoint = character.codePointAt(0);
    if (codePoint <= 0x7f) return 1;
    if (codePoint <= 0x7ff) return 2;
    if (codePoint <= 0xffff) return 3;
    return 4;
  }

  function deviceCalendarSequence(task, now) {
    const createdAt = Number(task.createdAt);
    if (!Number.isFinite(createdAt)) return 0;
    const secondsSinceCreation = Math.floor((now.getTime() - createdAt) / 1000);
    return Math.max(0, Math.min(2147483647, secondsSinceCreation + 1));
  }

  function safeIcsTaskId(value) {
    const source = String(value || 'task');
    const safe = source.replace(/[^A-Za-z0-9._-]/g, '-').slice(0, 64) || 'task';
    let hash = 2166136261;
    for (let index = 0; index < source.length; index += 1) {
      hash ^= source.charCodeAt(index);
      hash = Math.imul(hash, 16777619);
    }
    return safe + '-' + (hash >>> 0).toString(36);
  }

  function compactIcsDate(dateKey) {
    return String(dateKey).replace(/-/g, '');
  }

  function deviceCalendarFilename(task, occurrenceDate) {
    let slug = String(task.title || 'task').toLowerCase();
    try {
      slug = slug.normalize('NFKD').replace(/[\u0300-\u036f]/g, '');
    } catch (error) {
      // Older browsers still get a safe ASCII filename below.
    }
    slug = slug.replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 42);
    const dateKey = isDateKey(occurrenceDate) ? occurrenceDate : task.startDate;
    return 'inkyscib-' + dateKey + '-' + (slug || 'task') + '.ics';
  }

  function scanReminders() {
    window.clearTimeout(reminderTimer);
    if (reminderScanInFlight) {
      scheduleReminderScan(800);
      return;
    }
    const previousToday = bounds.min;
    refreshDateBounds();
    if (previousToday !== bounds.min) {
      selectedDate = clampDateKey(selectedDate, bounds.min, bounds.max);
      viewMonth = startOfMonth(parseDateKey(selectedDate));
      updateMenuChip();
      if (plannerOpen) renderAll();
    }

    if (document.hidden && notificationState() !== 'granted') {
      scheduleReminderScan(REMINDER_SCAN_FALLBACK_MS);
      return;
    }

    // Every mutation is persisted immediately, so refreshing here safely
    // reduces duplicate notifications when multiple MAETHIST tabs are open.
    if (storageSyncEnabled) store = loadStore();
    const now = Date.now();
    const today = bounds.min;
    const records = getOccurrencesForDate(today);
    const explicitDue = [];
    const autoDue = [];

    records.forEach((record) => {
      const task = record.task;
      const occurrenceDate = record.occurrenceDate;
      if (isTaskCompleted(task, occurrenceDate)) return;

      if (task.reminderTime) {
        const dueAt = timestampFor(occurrenceDate, task.reminderTime);
        if (
          dueAt <= now &&
          !task.notified.reminder[occurrenceDate]
        ) {
          explicitDue.push({ record, dueAt });
        }
        return;
      }

      const dueAt = automaticNudgeAt(task, occurrenceDate);
      if (
        dueAt <= now &&
        !task.notified.auto[occurrenceDate]
      ) {
        autoDue.push({ record, dueAt });
      }
    });

    if (!explicitDue.length && !autoDue.length) {
      scheduleReminderScan();
      return;
    }

    const foreground = !document.hidden;
    const deliveries = presentReminderBatches(
      explicitDue,
      autoDue,
      records,
      today,
      foreground
    );

    if (foreground) {
      markReminderItems(explicitDue, 'reminder', now);
      markReminderItems(autoDue, 'auto', now);
      persistStore();
      if (plannerOpen) renderAll();
      updateMenuChip();
      scheduleReminderScan();
      return;
    }

    reminderScanInFlight = true;
    Promise.all(deliveries.map((delivery) =>
      delivery.promise.then((success) => ({
        delivery,
        success
      }))
    )).then((results) => {
      let deliveredAny = false;
      results.forEach(({ delivery, success }) => {
        if (!success) return;
        deliveredAny = true;
        markReminderItems(delivery.items, delivery.kind, Date.now());
      });
      if (deliveredAny) persistStore();
      if (plannerOpen) renderAll();
      updateMenuChip();
      return deliveredAny;
    }).then((deliveredAny) => {
      scheduleReminderScan(deliveredAny ? undefined : REMINDER_SCAN_FALLBACK_MS);
    }).finally(() => {
      reminderScanInFlight = false;
    });
  }

  function presentReminderBatches(explicitDue, autoDue, records, today, showInApp) {
    const deliveries = [];
    const hasDueItems = !!(explicitDue.length || autoDue.length);
    const foregroundChimePlayed = showInApp && hasDueItems
      ? playReminderChime()
      : false;
    let foregroundSystemAlertPending = showInApp && hasDueItems && !foregroundChimePlayed;
    if (explicitDue.length) {
      const one = explicitDue.length === 1 ? explicitDue[0] : null;
      const message = one
        ? one.record.task.title
        : explicitDue.length + ' task reminders are ready.';
      const timestamp = one ? one.dueAt : Math.min(...explicitDue.map((item) => item.dueAt));
      if (showInApp) {
        showToast({
          title: 'Planner reminder',
          message,
          kind: 'reminder',
          actionLabel: 'View plan',
          onAction: () => openPlanner(today),
          duration: 9000
        });
      }
      deliveries.push({
        kind: 'reminder',
        items: explicitDue,
        promise: dispatchDeviceNotification(
          'MAETHIST Planner',
          message + ' - click to view',
          today,
          one
            ? 'inkyscib-planner-' + one.record.task.id + '-' + one.record.occurrenceDate
            : 'inkyscib-planner-reminders-' + today,
          timestamp,
          { forceSystemAlert: foregroundSystemAlertPending }
        )
      });
      foregroundSystemAlertPending = false;
    }

    if (autoDue.length) {
      const remaining = records.filter((record) => !isTaskCompleted(record.task, record.occurrenceDate)).length;
      const message = remaining + (remaining === 1 ? ' task left' : ' tasks left') + ' - click to view';
      if (showInApp) {
        showToast({
          title: 'Keep the momentum',
          message,
          kind: 'smart',
          actionLabel: 'Open today',
          onAction: () => openPlanner(today),
          duration: 9000
        });
      }
      deliveries.push({
        kind: 'auto',
        items: autoDue,
        promise: dispatchDeviceNotification(
          'MAETHIST Planner',
          message,
          today,
          'inkyscib-planner-smart-' + today,
          Math.min(...autoDue.map((item) => item.dueAt)),
          { forceSystemAlert: foregroundSystemAlertPending }
        )
      });
    }
    return deliveries;
  }

  function markReminderItems(items, kind, timestamp) {
    items.forEach(({ record }) => {
      record.task.notified[kind][record.occurrenceDate] = timestamp;
    });
  }

  function scheduleReminderScan(delayOverride) {
    window.clearTimeout(reminderTimer);
    if (!initialized || !trigger) return;
    if (Number.isFinite(delayOverride)) {
      reminderTimer = window.setTimeout(scanReminders, Math.max(200, delayOverride));
      return;
    }

    const now = Date.now();
    const today = bounds.min;
    let nextAt = startOfNextLocalDay(new Date(now)).getTime() + 150;
    const records = getOccurrencesForDate(today);

    records.forEach((record) => {
      if (isTaskCompleted(record.task, record.occurrenceDate)) return;
      let dueAt;
      let wasSent;
      if (record.task.reminderTime) {
        dueAt = timestampFor(record.occurrenceDate, record.task.reminderTime);
        wasSent = !!record.task.notified.reminder[record.occurrenceDate];
      } else {
        dueAt = automaticNudgeAt(record.task, record.occurrenceDate);
        wasSent = !!record.task.notified.auto[record.occurrenceDate];
      }
      if (!wasSent && dueAt <= now) {
        nextAt = Math.min(nextAt, now + 250);
      } else if (!wasSent && dueAt > now) {
        nextAt = Math.min(nextAt, dueAt + 100);
      }
    });

    const delay = Math.max(200, Math.min(nextAt - now, 2147483000));
    reminderTimer = window.setTimeout(scanReminders, delay);
  }

  function automaticNudgeAt(task, occurrenceDate) {
    const createdDate = toDateKey(new Date(task.createdAt));
    if (createdDate === occurrenceDate) return task.createdAt + AUTO_NUDGE_MS;
    return timestampFor(occurrenceDate, '12:00');
  }

  function showToast(options) {
    if (!ui.toastHost) return;
    const toast = document.createElement('article');
    toast.className = 'planner-toast is-' + (options.kind || 'neutral');

    const icon = document.createElement('span');
    icon.className = 'planner-toast-icon';
    icon.setAttribute('aria-hidden', 'true');
    icon.innerHTML = phIcon('phosphor:bell');

    const copy = document.createElement('span');
    copy.className = 'planner-toast-copy';
    const title = document.createElement('strong');
    title.textContent = options.title || 'Planner';
    const message = document.createElement('span');
    message.textContent = options.message || '';
    copy.append(title, message);

    toast.append(icon, copy);

    if (options.actionLabel && typeof options.onAction === 'function') {
      const action = document.createElement('button');
      action.type = 'button';
      action.className = 'planner-toast-action';
      action.textContent = options.actionLabel;
      action.addEventListener('click', () => {
        options.onAction();
        dismissToast(toast);
      }, { once: true });
      toast.appendChild(action);
    }

    const close = document.createElement('button');
    close.type = 'button';
    close.className = 'planner-toast-close';
    close.setAttribute('aria-label', 'Dismiss notification');
    close.innerHTML = phIcon('phosphor:x');
    close.addEventListener('click', () => dismissToast(toast), { once: true });
    toast.appendChild(close);

    const timerLine = document.createElement('span');
    timerLine.className = 'planner-toast-timer';
    const duration = Number(options.duration) || 5200;
    timerLine.style.setProperty('--toast-duration', duration + 'ms');
    toast.appendChild(timerLine);

    while (ui.toastHost.children.length >= 3) {
      const oldest = ui.toastHost.firstElementChild;
      const oldestHadFocus = oldest && oldest.contains(document.activeElement);
      oldest.remove();
      if (oldestHadFocus && plannerOpen) focusAfterRender(ui.closeBtn);
    }
    ui.toastHost.appendChild(toast);
    window.requestAnimationFrame(() => toast.classList.add('is-visible'));
    const timeout = window.setTimeout(() => dismissToast(toast), duration);
    toast.dataset.timeout = String(timeout);
  }

  function dismissToast(toast) {
    if (!toast || !toast.isConnected) return;
    const hadFocus = toast.contains(document.activeElement);
    const timeout = Number(toast.dataset.timeout);
    if (timeout) window.clearTimeout(timeout);
    toast.classList.remove('is-visible');
    window.setTimeout(() => {
      toast.remove();
      if (hadFocus && plannerOpen) focusAfterRender(ui.closeBtn);
    }, 220);
  }

  // ---------------------------------------------------------------------
  // Study: exams, streak, this week, focus and notebooks, backup.
  // Chosen by an LLM council (docs/council/council-planner-2026-11-19.md).
  // ---------------------------------------------------------------------

  function normalizeExams(raw) {
    if (!Array.isArray(raw)) return [];
    return raw.slice(0, MAX_EXAMS).map((exam) => {
      if (!exam || typeof exam !== 'object' || !isDateKey(exam.date)) return null;
      const name = typeof exam.name === 'string' ? exam.name.trim().slice(0, 60) : '';
      if (!name) return null;
      return { id: typeof exam.id === 'string' && exam.id ? exam.id.slice(0, 100) : makeId(), name, date: exam.date };
    }).filter(Boolean);
  }

  function formatMinutes(total) {
    const minutes = Math.max(0, Math.round(total));
    if (minutes < 60) return minutes + ' min';
    const hours = Math.floor(minutes / 60);
    const rest = minutes % 60;
    return hours + ' h' + (rest ? ' ' + rest + ' min' : '');
  }

  function completedDateKeys() {
    const keys = new Set();
    store.tasks.forEach((task) => Object.keys(task.completed || {}).forEach((key) => keys.add(key)));
    return keys;
  }

  // Days in a row, ending today, with at least one thing ticked off. Today
  // not done yet does not break it: the run up to yesterday still counts.
  function currentStreak() {
    const done = completedDateKeys();
    let day = parseDateKey(toDateKey(new Date()));
    if (!done.has(toDateKey(day))) day = addCalendarDays(day, -1);
    let streak = 0;
    while (done.has(toDateKey(day)) && streak < 3660) {
      streak += 1;
      day = addCalendarDays(day, -1);
    }
    return streak;
  }

  function weekDays() {
    const today = parseDateKey(toDateKey(new Date()));
    const monday = addCalendarDays(today, -((today.getDay() + 6) % 7));
    return Array.from({ length: 7 }, (_, i) => toDateKey(addCalendarDays(monday, i)));
  }

  function renderStudy() {
    if (!ui.examList) return;
    const todayKey = toDateKey(new Date());
    const exams = (store.exams || []).filter((exam) => exam.date >= todayKey).sort((a, b) => a.date.localeCompare(b.date));
    ui.examList.replaceChildren(...exams.map((exam) => {
      const days = calendarDayDifference(todayKey, exam.date);
      const item = document.createElement('li');
      item.className = 'planner-exam' + (days <= 7 ? ' is-soon' : '');
      item.innerHTML = '<span class="planner-exam-days"><b></b><small></small></span><span class="planner-exam-copy"><strong></strong><small></small></span>' +
        '<button type="button" class="planner-icon-btn planner-exam-delete">' + phIcon('phosphor:trash') + '</button>';
      item.querySelector('b').textContent = days === 0 ? 'Today' : String(days);
      item.querySelector('.planner-exam-days small').textContent = days === 0 ? '' : (days === 1 ? 'day' : 'days');
      item.querySelector('strong').textContent = exam.name;
      item.querySelector('.planner-exam-copy small').textContent = compactDateFormatter.format(parseDateKey(exam.date));
      const remove = item.querySelector('.planner-exam-delete');
      remove.dataset.examId = exam.id;
      remove.setAttribute('aria-label', 'Remove the exam ' + exam.name);
      return item;
    }));
    ui.examEmpty.hidden = exams.length > 0;

    const streak = currentStreak();
    if (ui.streakValue.textContent !== String(streak) && plannerOpen) {
      // Exaggeration, kept to one place: the streak number jumps when it grows.
      ui.streakValue.classList.remove('is-bumped');
      void ui.streakValue.offsetWidth;
      ui.streakValue.classList.add('is-bumped');
    }
    ui.streakValue.textContent = String(streak);
    ui.streakMeta.textContent = streak === 1 ? 'day with something done' : 'days in a row with something done';

    const days = weekDays();
    let planned = 0;
    let done = 0;
    let minutes = 0;
    ui.weekStrip.replaceChildren(...days.map((key) => {
      const records = key >= bounds.min && key <= bounds.max ? getOccurrencesForDate(key) : [];
      const finished = records.filter((r) => isTaskCompleted(r.task, r.occurrenceDate)).length;
      planned += records.length;
      done += finished;
      minutes += Number((store.focusDays || {})[key]) || 0;
      const day = document.createElement('button');
      day.type = 'button';
      day.className = 'planner-week-day';
      day.dataset.weekDate = key;
      day.disabled = key < bounds.min || key > bounds.max;
      day.classList.toggle('is-today', key === todayKey);
      day.classList.toggle('is-selected', key === selectedDate);
      day.classList.toggle('is-complete', records.length > 0 && finished === records.length);
      const date = parseDateKey(key);
      day.innerHTML = '<span></span><b></b><i aria-hidden="true"></i>';
      day.querySelector('span').textContent = weekdayFormatter.format(date);
      day.querySelector('b').textContent = String(date.getDate());
      day.querySelector('i').style.setProperty('--fill', records.length ? (finished / records.length) : 0);
      day.setAttribute('aria-label', longDateFormatter.format(date) + ': ' + finished + ' of ' + records.length + ' done');
      return day;
    }));
    ui.weekMeta.textContent = done + ' of ' + planned + ' done' + (minutes ? ' · ' + formatMinutes(minutes) + ' focused' : '');
  }

  function bindStudyEvents() {
    ui.addExamBtn.addEventListener('click', () => {
      const open = ui.examForm.hidden;
      ui.examForm.hidden = !open;
      ui.addExamBtn.setAttribute('aria-expanded', String(open));
      if (open) {
        ui.examDate.min = bounds.min;
        ui.examDate.max = bounds.max;
        ui.examError.hidden = true;
        ui.examName.focus();
      }
    });
    ui.examCancel.addEventListener('click', closeExamForm);
    ui.examForm.addEventListener('click', (event) => {
      const fill = event.target.closest('[data-fill-class]');
      if (fill) ui.examChapters.value = CBSE_CHAPTERS[fill.dataset.fillClass].join('\n');
    });
    ui.examForm.addEventListener('submit', saveExam);
    ui.examList.addEventListener('click', (event) => {
      const remove = event.target.closest('[data-exam-id]');
      if (!remove) return;
      store.exams = (store.exams || []).filter((exam) => exam.id !== remove.dataset.examId);
      persistStore();
      renderStudy();
    });
    ui.weekStrip.addEventListener('click', (event) => {
      const day = event.target.closest('[data-week-date]');
      if (day && !day.disabled) selectDay(day.dataset.weekDate);
    });
    ui.backupBtn.addEventListener('click', backupPlanner);
    ui.restoreBtn.addEventListener('click', () => ui.restoreInput.click());
    ui.restoreInput.addEventListener('change', restorePlanner);
    document.addEventListener('inkyscib:focus-complete', logFocusSession);
  }

  function closeExamForm() {
    ui.examForm.hidden = true;
    ui.addExamBtn.setAttribute('aria-expanded', 'false');
    ui.examForm.reset();
    ui.addExamBtn.focus();
  }

  // Save an exam, and if chapters were listed, spread one revision task per
  // chapter over the days between now and the day before the exam.
  function saveExam(event) {
    event.preventDefault();
    const name = ui.examName.value.trim().replace(/\s+/g, ' ').slice(0, 60);
    const date = ui.examDate.value;
    const fail = (message) => { ui.examError.textContent = message; ui.examError.hidden = false; };
    if (!name) return fail('Give the exam a name.');
    if (!isDateKey(date) || date < bounds.min || date > bounds.max) return fail('Pick a date between today and a year from now.');
    if ((store.exams || []).length >= MAX_EXAMS) return fail('That is a lot of exams. Remove a past one first.');
    store.exams = (store.exams || []).concat({ id: makeId(), name, date });

    const chapters = ui.examChapters.value.split('\n').map((line) => line.trim()).filter(Boolean).slice(0, MAX_PLAN_CHAPTERS);
    let planned = 0;
    if (chapters.length) {
      const first = toDateKey(new Date());
      const span = Math.max(1, calendarDayDifference(first, date));
      chapters.forEach((chapter, i) => {
        if (store.tasks.length >= MAX_TASKS) return;
        const offset = Math.min(span - 1, Math.floor((i * span) / chapters.length));
        const day = toDateKey(addCalendarDays(parseDateKey(first), Math.max(0, offset)));
        store.tasks.push({
          id: makeId(), title: ('Revise: ' + chapter).slice(0, 120), startDate: day, recurrence: 'none',
          reminderTime: null, createdAt: Date.now(), completed: {}, topic: chapter.slice(0, 60), notebookId: '',
          focusMinutes: 0, notified: { reminder: {}, auto: {} }
        });
        planned += 1;
      });
    }
    persistStore();
    closeExamForm();
    renderAll();
    showToast({
      title: 'Exam added',
      message: planned
        ? name + ': ' + planned + ' revision task' + (planned === 1 ? '' : 's') + ' spread over the days before it.'
        : name + ' is on the countdown.',
      kind: 'success'
    });
  }

  function startTaskFocus(taskId, occurrenceDate) {
    const task = store.tasks.find((item) => item.id === taskId);
    const pomodoro = window.Inkyscib && window.Inkyscib.Pomodoro;
    if (!task || !pomodoro || typeof pomodoro.startFocus !== 'function') return;
    try {
      window.sessionStorage.setItem(FOCUS_KEY, JSON.stringify({ taskId, occurrenceDate }));
    } catch (error) { /* storage blocked: the minutes still go to the day */ }
    closePlanner();
    pomodoro.startFocus(task.title);
  }

  // A finished focus session from the timer: its minutes go to the day, and
  // to the task it was started from, if any.
  function logFocusSession(event) {
    const minutes = Math.max(0, Math.round(Number(event.detail && event.detail.minutes) || 0));
    if (!minutes) return;
    const today = toDateKey(new Date());
    store.focusDays = store.focusDays || {};
    store.focusDays[today] = (Number(store.focusDays[today]) || 0) + minutes;
    let linked = null;
    try { linked = JSON.parse(window.sessionStorage.getItem(FOCUS_KEY) || 'null'); } catch (error) { linked = null; }
    const task = linked && store.tasks.find((item) => item.id === linked.taskId);
    if (task) task.focusMinutes = (task.focusMinutes || 0) + minutes;
    try { window.sessionStorage.removeItem(FOCUS_KEY); } catch (error) { /* nothing to clear */ }
    persistStore();
    if (plannerOpen) renderAll();
  }

  function openTaskNotebook(taskId) {
    const task = store.tasks.find((item) => item.id === taskId);
    const library = window.Inkyscib && window.Inkyscib.Library;
    if (!task || !task.notebookId || !library) return;
    closePlanner();
    Promise.resolve(library.openDocument(task.notebookId)).catch(() => {
      showToast({ title: 'Notebook not found', message: 'It may have been deleted.', kind: 'warning' });
    });
  }

  function backupPlanner() {
    const payload = JSON.stringify({
      app: 'maethist-planner',
      version: STORE_VERSION,
      exportedAt: new Date().toISOString(),
      tasks: store.tasks,
      exams: store.exams || [],
      focusDays: store.focusDays || {}
    }, null, 2);
    const url = URL.createObjectURL(new Blob([payload], { type: 'application/json' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = 'maethist-planner-' + toDateKey(new Date()) + '.json';
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    showToast({ title: 'Plan backed up', message: 'Keep the file somewhere safe; Restore brings it back.', kind: 'success' });
  }

  // Restore adds what is not already here (by id), so restoring twice, or
  // onto a planner with new tasks, never duplicates or loses anything.
  function restorePlanner() {
    const file = ui.restoreInput.files && ui.restoreInput.files[0];
    ui.restoreInput.value = '';
    if (!file) return;
    file.text().then((text) => {
      const data = JSON.parse(text);
      if (!data || data.app !== 'maethist-planner' || !Array.isArray(data.tasks)) throw new Error('not a planner backup');
      const have = new Set(store.tasks.map((task) => task.id));
      const incoming = data.tasks.map(normalizeTask).filter((task) => task && !have.has(task.id));
      store.tasks = store.tasks.concat(incoming).slice(0, MAX_TASKS);
      const examIds = new Set((store.exams || []).map((exam) => exam.id));
      store.exams = (store.exams || []).concat(normalizeExams(data.exams).filter((exam) => !examIds.has(exam.id))).slice(0, MAX_EXAMS);
      const days = sanitizeDateStateMap(data.focusDays);
      store.focusDays = Object.assign({}, days, store.focusDays || {});
      persistStore();
      renderAll();
      showToast({ title: 'Plan restored', message: incoming.length + ' task' + (incoming.length === 1 ? '' : 's') + ' added.', kind: 'success' });
    }).catch(() => {
      showToast({ title: 'That file is not a planner backup', message: 'Choose a file made with Back up.', kind: 'warning' });
    });
  }

  function persistStore() {
    const payload = JSON.stringify({
      version: STORE_VERSION,
      tasks: store.tasks,
      exams: store.exams || [],
      focusDays: store.focusDays || {}
    });
    try {
      if (typeof window.safeSetItem === 'function') {
        storageSyncEnabled = window.safeSetItem(STORAGE_KEY, payload) !== false;
      } else {
        window.localStorage.setItem(STORAGE_KEY, payload);
        storageSyncEnabled = true;
      }
    } catch (error) {
      storageSyncEnabled = false;
      // The planner remains usable for this tab if storage is unavailable.
    }
    if (storageSyncEnabled) {
      storageWarningShown = false;
      return true;
    }
    if (!storageWarningShown && initialized && plannerOpen && ui.toastHost) {
      storageWarningShown = true;
      showToast({
        title: 'Planner could not save',
        message: 'This change is available in this tab, but may disappear after a reload. Free device storage or allow site storage.',
        kind: 'warning',
        duration: 9000
      });
    }
    return false;
  }

  function loadStore() {
    let raw = null;
    try {
      raw = typeof window.safeGetItem === 'function'
        ? window.safeGetItem(STORAGE_KEY)
        : window.localStorage.getItem(STORAGE_KEY);
    } catch (error) {
      raw = null;
    }

    if (!raw) return { version: STORE_VERSION, tasks: [], exams: [], focusDays: {} };
    try {
      const parsed = JSON.parse(raw);
      const tasks = Array.isArray(parsed && parsed.tasks)
        ? parsed.tasks.slice(0, MAX_TASKS).map(normalizeTask).filter(Boolean)
        : [];
      return {
        version: STORE_VERSION,
        tasks,
        exams: normalizeExams(parsed && parsed.exams),
        focusDays: sanitizeDateStateMap(parsed && parsed.focusDays)
      };
    } catch (error) {
      return { version: STORE_VERSION, tasks: [], exams: [], focusDays: {} };
    }
  }

  function normalizeTask(raw) {
    if (!raw || typeof raw !== 'object') return null;
    const title = typeof raw.title === 'string' ? raw.title.trim().replace(/\s+/g, ' ').slice(0, 120) : '';
    if (!title || !isDateKey(raw.startDate)) return null;

    const recurrence = RECURRENCE_LABELS[raw.recurrence] ? raw.recurrence : 'none';
    const reminderTime = isTimeValue(raw.reminderTime) ? raw.reminderTime : null;
    const createdAt = Number.isFinite(Number(raw.createdAt)) ? Number(raw.createdAt) : timestampFor(raw.startDate, '09:00');
    const id = typeof raw.id === 'string' && raw.id ? raw.id.slice(0, 100) : makeId();
    const notified = raw.notified && typeof raw.notified === 'object' ? raw.notified : {};

    return {
      id,
      title,
      startDate: raw.startDate,
      recurrence,
      reminderTime,
      createdAt,
      completed: sanitizeDateStateMap(raw.completed),
      topic: typeof raw.topic === 'string' ? raw.topic.trim().slice(0, 60) : '',
      notebookId: typeof raw.notebookId === 'string' ? raw.notebookId.slice(0, 100) : '',
      focusMinutes: Number.isFinite(Number(raw.focusMinutes)) ? Math.max(0, Math.round(Number(raw.focusMinutes))) : 0,
      notified: {
        reminder: sanitizeDateStateMap(notified.reminder),
        auto: sanitizeDateStateMap(notified.auto)
      }
    };
  }

  function sanitizeDateStateMap(raw) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
    const entries = Object.entries(raw)
      .filter(([key, value]) => isDateKey(key) && Number.isFinite(Number(value)))
      .slice(-MAX_DATE_STATE_ENTRIES);
    return Object.fromEntries(entries.map(([key, value]) => [key, Number(value)]));
  }

  function makeId() {
    if (window.crypto && typeof window.crypto.randomUUID === 'function') {
      return window.crypto.randomUUID();
    }
    return 'planner-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
  }

  function getDateBounds(now) {
    const localNow = now instanceof Date ? now : new Date(now);
    const minDate = new Date(localNow.getFullYear(), localNow.getMonth(), localNow.getDate(), 12);
    const targetYear = minDate.getFullYear() + 1;
    const maxDay = new Date(targetYear, minDate.getMonth() + 1, 0, 12).getDate();
    const maxDate = new Date(
      targetYear,
      minDate.getMonth(),
      Math.min(minDate.getDate(), maxDay),
      12
    );
    return {
      min: toDateKey(minDate),
      max: toDateKey(maxDate)
    };
  }

  function toDateKey(date) {
    return [
      date.getFullYear(),
      String(date.getMonth() + 1).padStart(2, '0'),
      String(date.getDate()).padStart(2, '0')
    ].join('-');
  }

  function parseDateKey(key) {
    const parts = String(key).split('-').map(Number);
    return new Date(parts[0], parts[1] - 1, parts[2], 12);
  }

  function isDateKey(value) {
    if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
    const date = parseDateKey(value);
    return Number.isFinite(date.getTime()) && toDateKey(date) === value;
  }

  function clampDateKey(value, min, max) {
    if (!isDateKey(value) || value < min) return min;
    if (value > max) return max;
    return value;
  }

  function startOfMonth(date) {
    return new Date(date.getFullYear(), date.getMonth(), 1, 12);
  }

  function startOfNextLocalDay(date) {
    return new Date(date.getFullYear(), date.getMonth(), date.getDate() + 1, 0, 0, 0, 0);
  }

  function addCalendarDays(date, count) {
    return new Date(date.getFullYear(), date.getMonth(), date.getDate() + count, 12);
  }

  function monthOrdinal(date) {
    return date.getFullYear() * 12 + date.getMonth();
  }

  function calendarDayOrdinal(dateKey) {
    const parts = String(dateKey).split('-').map(Number);
    return Math.floor(Date.UTC(parts[0], parts[1] - 1, parts[2]) / 86400000);
  }

  function calendarDayDifference(fromKey, toKey) {
    return calendarDayOrdinal(toKey) - calendarDayOrdinal(fromKey);
  }

  function isTimeValue(value) {
    if (typeof value !== 'string' || !/^\d{2}:\d{2}$/.test(value)) return false;
    const [hour, minute] = value.split(':').map(Number);
    return hour >= 0 && hour <= 23 && minute >= 0 && minute <= 59;
  }

  function timestampFor(dateKey, timeValue) {
    const dateParts = String(dateKey).split('-').map(Number);
    const timeParts = String(timeValue).split(':').map(Number);
    return new Date(
      dateParts[0],
      dateParts[1] - 1,
      dateParts[2],
      timeParts[0],
      timeParts[1],
      0,
      0
    ).getTime();
  }

  function partsToTime(hour12, minute, period) {
    let hour = Number(hour12) % 12;
    if (period === 'PM') hour += 12;
    return String(hour).padStart(2, '0') + ':' + String(Number(minute)).padStart(2, '0');
  }

  function timeToParts(timeValue) {
    const [hour24, minute] = timeValue.split(':').map(Number);
    return {
      hour: hour24 % 12 || 12,
      minute,
      period: hour24 >= 12 ? 'PM' : 'AM'
    };
  }

  function formatReminderTime(timeValue) {
    const parts = timeToParts(timeValue);
    return parts.hour + ':' + String(parts.minute).padStart(2, '0') + ' ' + parts.period;
  }

  function defaultReminderParts(dateKey, now) {
    if (dateKey !== toDateKey(now)) {
      return { hour: 9, minute: 0, period: 'AM' };
    }

    const rounded = new Date(now.getTime());
    rounded.setSeconds(0, 0);
    rounded.setMinutes(Math.ceil((rounded.getMinutes() + 1) / 5) * 5);
    if (toDateKey(rounded) !== dateKey) {
      return { hour: 11, minute: 59, period: 'PM' };
    }
    const hour24 = rounded.getHours();
    return {
      hour: hour24 % 12 || 12,
      minute: rounded.getMinutes(),
      period: hour24 >= 12 ? 'PM' : 'AM'
    };
  }

  function isReminderTimeAllowed(dateKey, timeValue, now) {
    if (!isDateKey(dateKey) || !isTimeValue(timeValue)) return false;
    const today = toDateKey(now);
    if (dateKey > today) return true;
    if (dateKey < today) return false;
    const [hour, minute] = timeValue.split(':').map(Number);
    const targetMinute = hour * 60 + minute;
    const currentMinute = now.getHours() * 60 + now.getMinutes();
    return targetMinute > currentMinute;
  }

  function timePeriodHasValidMinute(dateKey, period, now) {
    for (let hour = 1; hour <= 12; hour += 1) {
      if (hourHasValidMinute(dateKey, hour, period, now)) return true;
    }
    return false;
  }

  function hourHasValidMinute(dateKey, hour, period, now) {
    for (let minute = 0; minute < 60; minute += 1) {
      if (isReminderTimeAllowed(dateKey, partsToTime(hour, minute, period), now)) return true;
    }
    return false;
  }

  function hasAnyFutureMinute(dateKey, now) {
    return timePeriodHasValidMinute(dateKey, 'AM', now) ||
      timePeriodHasValidMinute(dateKey, 'PM', now);
  }

  function prefersReducedMotion() {
    return !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  }

  window.Inkyscib = window.Inkyscib || {};
  window.Inkyscib.Planner = {
    open: openPlanner,
    close: closePlanner,
    getDateBounds,
    occursOn: taskOccursOn,
    isReminderTimeAllowed,
    automaticNudgeAt,
    scanReminders,
    getState: () => JSON.parse(JSON.stringify(store))
  };
})();
