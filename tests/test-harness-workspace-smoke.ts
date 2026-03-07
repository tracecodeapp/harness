#!/usr/bin/env npx tsx

import assert from 'node:assert/strict';

import * as core from '../packages/harness-core/src';
import * as browser from '../packages/harness-browser/src';
import * as python from '../packages/harness-python/src';
import * as javascript from '../packages/harness-javascript/src';

assert.equal(typeof core.normalizeRuntimeTraceContract, 'function', 'core should export trace contract helpers');
assert.equal(typeof core.adaptPythonTraceExecutionResult, 'function', 'core should export python trace adapters');
assert.equal(typeof browser.getRuntimeClient, 'function', 'browser should export runtime client selection');
assert.equal(typeof browser.getPythonRuntimeClient, 'function', 'browser should export python runtime client');
assert.equal(typeof python.generateSolutionScript, 'function', 'python should export harness helpers');
assert.equal(typeof python.templateToPythonLiteral, 'function', 'python should export template literal helper');
assert.equal(typeof javascript.executeJavaScriptCode, 'function', 'javascript should export JS executor');
assert.equal(
  typeof javascript.withTypeScriptRuntimeDeclarations,
  'function',
  'javascript should export TS runtime declarations helper'
);

console.log('Harness workspace smoke test passed.');
