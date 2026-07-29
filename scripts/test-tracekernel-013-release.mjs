#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

const allowedProfiles = new Set(['ci', 'full', 'artifacts', 'tracejvm']);
const profileArgument = process.argv.find((argument) =>
  argument.startsWith('--profile=')
);
const profile =
  profileArgument?.slice('--profile='.length) ??
  process.env.TRACECODE_TRACEKERNEL_RELEASE_PROFILE ??
  'ci';
if (!allowedProfiles.has(profile)) {
  throw new Error(
    `Unknown TraceKernel release profile ${JSON.stringify(profile)}. ` +
      `Expected one of ${[...allowedProfiles].join(', ')}.`
  );
}

const pnpm = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm';
const startedAt = Date.now();
const completed = [];

function runStep(name, command, args, options = {}) {
  console.log(`\n=== TraceKernel 0.13 release gate: ${name} ===`);
  const stepStartedAt = Date.now();
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(command, args, {
      cwd: options.cwd ?? process.cwd(),
      env: {
        ...process.env,
        ...options.env,
      },
      stdio: 'inherit',
    });
    child.once('error', rejectRun);
    child.once('exit', (code, signal) => {
      if (code !== 0) {
        rejectRun(
          new Error(
            `${name} failed with ${
              signal ? `signal ${signal}` : `exit code ${code}`
            }.`
          )
        );
        return;
      }
      const elapsedMs = Date.now() - stepStartedAt;
      completed.push({ name, elapsedMs });
      console.log(`PASS: ${name} (${elapsedMs}ms)`);
      resolveRun();
    });
  });
}

function pnpmStep(name, script, options) {
  return runStep(name, pnpm, ['run', script], options);
}

function resolveTraceJVMRoot() {
  const candidates = [
    process.env.TRACECODE_TRACEJVM_ROOT,
    '../tracejvm-tracekernel-013',
    '../tracejvm',
  ]
    .filter(Boolean)
    .map((candidate) => resolve(candidate));
  const root = candidates.find((candidate) =>
    existsSync(resolve(candidate, 'package.json'))
  );
  if (!root) {
    throw new Error(
      'The TraceJVM release gate requires TRACECODE_TRACEJVM_ROOT or a ' +
        'sibling tracejvm-tracekernel-013/tracejvm checkout.'
    );
  }
  return root;
}

async function runKernelAndAdapterGates(extended) {
  await pnpmStep(
    extended
      ? 'TraceKernel core conformance with 100 adversarial teardown rounds'
      : 'TraceKernel core conformance',
    'test:tracekernel-013',
    extended
      ? {
          env: {
            TRACECODE_TRACEKERNEL_ADVERSARIAL_ROUNDS: '100',
          },
        }
      : undefined
  );
  await pnpmStep(
    extended
      ? 'mixed-runtime 1,000-child and 100-session soak'
      : 'bounded mixed-runtime soak',
    extended
      ? 'test:tracekernel-013-soak:extended'
      : 'test:tracekernel-013-soak:ci'
  );
  await pnpmStep(
    'JavaScript/TypeScript browser kernel adapter',
    'test:tracekernel-013-browser'
  );
  await pnpmStep(
    'Python and JavaScript cross-language kernel adapter',
    'test:tracekernel-013-python-browser'
  );
  await pnpmStep(
    'C++/JavaScript and nested C++ kernel adapter',
    'test:tracekernel-013-cpp-browser'
  );
  await pnpmStep(
    'C# and JavaScript cross-language kernel adapter',
    'test:tracekernel-013-csharp-browser'
  );
}

async function runTraceJVMGates() {
  const traceJVMRoot = resolveTraceJVMRoot();
  await pnpmStep(
    'TraceJVM independent package, compatibility, profile, and lifecycle release',
    'test:standalone-release',
    { cwd: traceJVMRoot }
  );
  await pnpmStep(
    'TraceKernel and TraceJVM browser integration',
    'test:tracekernel-013-tracejvm-browser',
    {
      env: {
        TRACECODE_TRACEJVM_ROOT: traceJVMRoot,
        TRACECODE_TRACEJVM_ENGINES: 'chromium,firefox,webkit',
      },
    }
  );
}

async function runArtifactGates() {
  await pnpmStep('production package build', 'build');
  await pnpmStep('packed package surface', 'test:packaged-surface');
  await pnpmStep('language package surfaces', 'test:language-packages');
  await pnpmStep('generated and copied asset parity', 'test:asset-sync');
  await pnpmStep('packed example consumer', 'test:example-app-packaged');
}

if (profile === 'ci') {
  await runKernelAndAdapterGates(false);
} else if (profile === 'tracejvm') {
  await runTraceJVMGates();
} else if (profile === 'artifacts') {
  await runArtifactGates();
} else {
  await runKernelAndAdapterGates(true);
  await pnpmStep(
    'cross-engine live TKFS visibility',
    'test:project-live-fs-browser-matrix'
  );
  await pnpmStep(
    'non-Java project providers across Chromium, Firefox, and WebKit',
    'test:project-browser-matrix',
    {
      env: {
        // Java 0.13 is TraceJVM and has its own gate below. The generic Java
        // provider matrix intentionally remains a separate CheerpJ
        // compatibility monitor rather than a TraceKernel release dependency.
        TRACECODE_PROJECT_MATRIX_LANGUAGES:
          'python,javascript,typescript,csharp,cpp',
      },
    }
  );
  await runTraceJVMGates();
  await runArtifactGates();
}

console.log(
  `\n${JSON.stringify(
    {
      schema: 'tracekernel-013-release-gates-v1',
      profile,
      status: 'passed',
      elapsedMs: Date.now() - startedAt,
      steps: completed,
    },
    null,
    2
  )}`
);
