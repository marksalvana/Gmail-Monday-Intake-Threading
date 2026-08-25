'use strict';
/**
 * Test harness.
 *
 * Loads Code.gs — THE EXACT FILE THAT GETS PASTED — into a VM sandbox and
 * exposes its globals. Previously the tests ran against sixteen source modules
 * and the single-file bundle was a separate, derived artefact that had to be
 * verified on its own. Testing the shipped file directly removes that gap: what
 * passes here is byte-for-byte what runs in Apps Script.
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

function loadSandbox() {
  const file = path.join(__dirname, '..', 'Code.gs');
  const sandbox = { console, JSON, Math, Date, String, Number, Object, Array,
                    RegExp, Error, isNaN, parseInt, parseFloat, Buffer };
  sandbox.global = sandbox;
  vm.createContext(sandbox);
  new vm.Script(fs.readFileSync(file, 'utf8'), { filename: 'Code.gs' }).runInContext(sandbox);
  return sandbox;
}

const suites = [];
let current = null;
let passed = 0;
const failures = [];

function suite(name) { current = { name, checks: [] }; suites.push(current); }
function check(name, fn) { current.checks.push({ name, fn }); }

function fail(msg, expected, got) {
  const e = new Error(msg + (expected !== undefined
    ? ` — expected ${JSON.stringify(expected)}, got ${JSON.stringify(got)}` : ''));
  e.assertion = true;
  throw e;
}
function eq(got, expected, msg) {
  const a = JSON.stringify(got), b = JSON.stringify(expected);
  if (a !== b) { fail(msg || 'not equal', expected, got); }
}
function truthy(got, msg) { if (!got) { fail(msg || 'expected truthy', true, got); } }

function report() {
  suites.forEach((s) => {
    console.log('\n' + s.name);
    s.checks.forEach((c) => {
      try { c.fn(); passed++; console.log('  ✓ ' + c.name); }
      catch (e) {
        failures.push({ suite: s.name, check: c.name, err: e });
        console.log('  ✗ ' + c.name + '\n      ' + e.message);
      }
    });
  });
  console.log('\n' + '-'.repeat(62));
  if (failures.length) {
    console.log(`${passed} passed, ${failures.length} FAILED`);
    process.exitCode = 1;
  } else {
    console.log(`ALL PASS — ${passed} assertions`);
  }
}

module.exports = { loadSandbox, suite, check, eq, truthy, report };
