#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

const allowedProfiles = new Set(['bounded', 'full', 'artifacts', 'tracejvm']);
const profileArgument = process.argv.find((argument) =>
  argument.startsWith('--profile=')
);
const profile =
  profileArgument?.slice('--profile='.length) ??
  process.env.TRACECODE_TRACEKERNEL_GATE_PROFILE ??
  'bounded';
if (!allowedProfiles.has(profile)) {
  throw new Error(
    `Unknown TraceKernel kernelization profile ${JSON.stringify(profile)}. ` +
      `Expected one of ${[...allowedProfiles].join(', ')}.`
  );
}

const pnpm = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm';
const startedAt = Date.now();
const completed = [];

function runStep(name, command, args, options = {}) {
  console.log(`\n=== TraceKernel kernelization gate: ${name} ===`);
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
    '../tracejvm',
  ]
    .filter(Boolean)
    .map((candidate) => resolve(candidate));
  const root = candidates.find((candidate) =>
    existsSync(resolve(candidate, 'package.json'))
  );
  if (!root) {
    throw new Error(
      'The TraceJVM kernelization gate requires TRACECODE_TRACEJVM_ROOT or a ' +
        'sibling tracejvm checkout.'
    );
  }
  return root;
}

async function runKernelAndAdapterGates(extended) {
  await pnpmStep(
    extended
      ? 'TraceKernel core conformance with 100 adversarial teardown rounds'
      : 'TraceKernel core conformance',
    'test:tracekernel',
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
      ? 'test:tracekernel:soak:extended'
      : 'test:tracekernel:soak:bounded'
  );
  await pnpmStep(
    'JavaScript/TypeScript browser kernel adapter',
    'test:tracekernel:browser'
  );
  await pnpmStep(
    'Python and JavaScript cross-language kernel adapter',
    'test:tracekernel:python-browser'
  );
  await pnpmStep(
    'C++/JavaScript and nested C++ kernel adapter',
    'test:tracekernel:cpp-browser'
  );
  await pnpmStep(
    'C# and JavaScript cross-language kernel adapter',
    'test:tracekernel:csharp-browser'
  );
}

async function runTraceJVMGates() {
  const traceJVMRoot = resolveTraceJVMRoot();
  await pnpmStep(
    'TraceJVM independent package, compatibility, profile, and lifecycle',
    'test:standalone-release',
    { cwd: traceJVMRoot }
  );
  await pnpmStep(
    'TraceKernel and TraceJVM browser integration',
    'test:tracekernel:tracejvm-browser',
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

if (profile === 'bounded') {
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
        // Java uses TraceJVM and has its own gate below. The generic Java
        // provider matrix intentionally remains a separate CheerpJ
        // compatibility monitor rather than a TraceKernel kernelization
        // dependency.
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
      schema: 'tracekernel-kernelization-gates-v1',
      profile,
      status: 'passed',
      elapsedMs: Date.now() - startedAt,
      steps: completed,
    },
    null,
    2
  )}`
);
