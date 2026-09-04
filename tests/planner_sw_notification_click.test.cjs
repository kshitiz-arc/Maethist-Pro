'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const workerSource = fs.readFileSync(
  path.resolve(__dirname, '..', 'static', 'js', 'planner-sw.js'),
  'utf8'
);

function loadNotificationClickHandler(clients) {
  let notificationClickHandler = null;
  const workerGlobal = {
    clients,
    addEventListener(type, handler) {
      if (type === 'notificationclick') notificationClickHandler = handler;
    }
  };

  vm.runInNewContext(workerSource, {
    self: workerGlobal,
    URL,
    encodeURIComponent
  }, {
    filename: 'planner-sw.js'
  });

  assert.equal(
    typeof notificationClickHandler,
    'function',
    'the worker must register a notificationclick handler'
  );
  return notificationClickHandler;
}

async function dispatchNotificationClick(handler, data) {
  let closed = 0;
  let waited = null;
  const event = {
    notification: {
      data,
      close() {
        closed += 1;
      }
    },
    waitUntil(promise) {
      waited = Promise.resolve(promise);
    }
  };

  handler(event);
  assert.ok(waited, 'notificationclick work must be passed to waitUntil');
  await waited;
  return { closed };
}

test('notification click focuses an existing writer and opens Planner there', async () => {
  let matchOptions = null;
  let focused = 0;
  let postedMessage = null;
  const openedUrls = [];
  const writeClient = {
    url: 'https://inkyscib.test/write?existing=1',
    async focus() {
      focused += 1;
    },
    postMessage(message) {
      postedMessage = message;
    }
  };
  const handler = loadNotificationClickHandler({
    async matchAll(options) {
      matchOptions = options;
      return [
        { url: 'https://inkyscib.test/' },
        writeClient
      ];
    },
    async openWindow(url) {
      openedUrls.push(url);
    }
  });

  const result = await dispatchNotificationClick(handler, {
    date: '2026-07-18',
    url: '/write?planner=1&date=2026-07-18'
  });

  assert.equal(result.closed, 1);
  assert.equal(matchOptions.type, 'window');
  assert.equal(matchOptions.includeUncontrolled, true);
  assert.equal(focused, 1);
  assert.equal(postedMessage.type, 'INKYSCIB_OPEN_PLANNER');
  assert.equal(postedMessage.date, '2026-07-18');
  assert.deepEqual(openedUrls, []);
});

test('notification click opens a Planner deep link when no writer exists', async () => {
  const openedUrls = [];
  const handler = loadNotificationClickHandler({
    async matchAll() {
      return [
        { url: 'https://inkyscib.test/' },
        { url: 'https://inkyscib.test/library' }
      ];
    },
    async openWindow(url) {
      openedUrls.push(url);
    }
  });

  const result = await dispatchNotificationClick(handler, {
    date: '2026-08-09'
  });

  assert.equal(result.closed, 1);
  assert.deepEqual(openedUrls, [
    '/write?planner=1&date=2026-08-09'
  ]);
});
