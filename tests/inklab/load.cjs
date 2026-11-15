'use strict';

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '..', '..');

// Runs InkLab's classic scripts the way the page and the worker do: each file
// is an IIFE that attaches to `self.InkLab`. They are compiled with
// runInThisContext rather than runInNewContext so the arrays, objects and
// promises they return belong to this realm. A value from another realm has a
// different Array.prototype, and assert.deepStrictEqual rejects it for that
// alone.
function loadInkLab(...relativePaths) {
  const self = {};
  for (const relativePath of relativePaths) {
    const filename = path.join(ROOT, relativePath);
    const source = fs.readFileSync(filename, 'utf8');
    const run = vm.runInThisContext(`(function (self) {${source}\n})`, { filename });
    run(self);
  }
  return self.InkLab;
}

module.exports = { ROOT, loadInkLab };
