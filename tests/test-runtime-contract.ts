#!/usr/bin/env npx tsx

import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import {
  createBrowserHarness,
  SUPPORTED_LANGUAGES,
  getLanguageRuntimeInfo,
  getLanguageRuntimeProfile,
  getRuntimeProjectIoSupport,
  getSupportedLanguageRuntimeInfos,
  getSupportedLanguageProfiles,
  isLanguageSupported,
} from '../packages/harness-browser/src';
import { assertRuntimeRequestSupported } from '../packages/harness-browser/src/runtime-capability-guards';
import { createJavaRuntimeClient } from '../packages/harness-browser/src/java-runtime-client';
import type { JavaWorkerClient } from '../packages/harness-browser/src/java-worker-client';
import { executeJavaScriptCode, executeTypeScriptCode } from '../packages/harness-javascript/src/javascript-executor';
import { generateSolutionScript } from '../packages/harness-python/src/python-harness';
import type { RuntimeKernelInfo } from '../packages/harness-core/src/runtime-project';
import type { Language, LanguageRuntimeProfile, RuntimeCapabilities } from '../packages/harness-core/src/runtime-types';
import {
  javaTraceHooksEventsToRuntimeTrace,
  normalizeJavaSerializedResult,
} from '../packages/harness-core/src/trace-adapters/java';
import {
  runtimeKernelCopyTarget,
  runtimeKernelDirectoryTarget,
  runtimeKernelDeviceOutputTarget,
  runtimeKernelFileCopyTarget,
  runtimeKernelFileReadTarget,
  runtimeKernelLinkTarget,
  runtimeKernelMkdirTarget,
  runtimeKernelMetadataTarget,
  runtimeKernelMutationTarget,
  runtimeKernelOpenTarget,
  runtimeKernelRenameTarget,
  runtimeKernelRemoveTarget,
  runtimeKernelStatTarget,
  runtimeKernelSymlinkTarget,
  runtimeKernelTruncateTarget,
  runtimeKernelVirtualDevices,
  runtimeKernelWriteTarget,
  normalizeRuntimeKernelManifestDevicePath,
} from '../packages/harness-core/src/runtime-kernel';
import {
  RuntimeProjectLiveIoController,
  createRuntimeProjectIoBridge,
  runRuntimeProjectWorkerBridge,
  type RuntimeCommandEvent,
  type RuntimeProjectCommandRequest,
} from '../packages/harness-core/src/runtime-project';
import {
  normalizeRuntimeKernelManifestDevicePath as normalizeWorkerKernelManifestDevicePath,
  normalizeRuntimeKernelDeviceReference as normalizeWorkerKernelDeviceReference,
  runtimeKernelDeviceDirEntries as workerRuntimeKernelDeviceDirEntries,
  runtimeKernelDeviceEntryKind as workerRuntimeKernelDeviceEntryKind,
  runtimeKernelDeviceInputSource as workerRuntimeKernelDeviceInputSource,
  runtimeKernelDeviceOutputTarget as workerRuntimeKernelDeviceOutputTarget,
  runtimeKernelVirtualMutationTarget as workerRuntimeKernelVirtualMutationTarget,
  runtimeKernelVirtualOpenTarget as workerRuntimeKernelVirtualOpenTarget,
  runtimeKernelVirtualPathTarget as workerRuntimeKernelVirtualPathTarget,
} from '../workers/shared/runtime-kernel-policy.js';

function assertCondition(condition: boolean, message: string): void {
  if (!condition) {
    throw new Error(message);
  }
}

function expectThrows(fn: () => void, expectedMessage: string): void {
  let thrown: unknown;
  try {
    fn();
  } catch (error) {
    thrown = error;
  }
  assertCondition(thrown instanceof Error, `Expected error containing "${expectedMessage}"`);
  assertCondition(
    String((thrown as Error).message).includes(expectedMessage),
    `Expected error containing "${expectedMessage}", received "${String((thrown as Error).message)}"`
  );
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return '[' + value.map((item) => stableStringify(item)).join(',') + ']';
  }

  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return '{' + keys.map((key) => JSON.stringify(key) + ':' + stableStringify(obj[key])).join(',') + '}';
}

function assertRuntimeKernelOpenDevicePermissions(): void {
  const devices = [
    { path: '/dev/stdin' as const, readable: true, writable: false, inputDevice: '/dev/stdin' as const },
    { path: '/dev/stdout' as const, readable: false, writable: true, outputDevice: '/dev/stdout' as const },
    { path: '/dev/tty' as const, readable: true, writable: true, inputDevice: '/dev/stdin' as const, outputDevice: '/dev/stdout' as const },
    { path: '/dev/capture' as const, readable: false, writable: true, outputDevice: '/dev/capture' as const },
    { path: '/dev/tee' as const, readable: false, writable: true, outputDevice: '/dev/capture' as const },
    { path: '/dev/pts/0' as const, readable: false, writable: true, outputDevice: '/dev/stdout' as const },
  ];

  assertCondition(
    normalizeWorkerKernelDeviceReference('/dev/pts/0') === '' &&
      normalizeWorkerKernelManifestDevicePath('/dev/pts/0') === '/dev/pts/0' &&
      normalizeRuntimeKernelManifestDevicePath('/dev/pts/0') === '/dev/pts/0',
    'shared kernel policies should keep single-device references distinct from nested manifest devices'
  );
  assertCondition(
    workerRuntimeKernelDeviceOutputTarget(devices, '/dev/pts/0') === '/dev/stdout' &&
      runtimeKernelDeviceOutputTarget(devices, '/dev/pts/0') === '/dev/stdout',
    'shared kernel policies should resolve nested manifest device output aliases'
  );
  assertCondition(
    runtimeKernelDeviceOutputTarget(devices, '/dev/tee') === '/dev/capture',
    'kernel output target should resolve manifest device aliases'
  );
  assertCondition(
    stableStringify(runtimeKernelWriteTarget('/dev/capture', devices)) ===
      '{"device":"/dev/capture","kind":"device","outputDevice":"/dev/capture"}',
    'kernel write target should allow custom output devices'
  );
  assertCondition(
    stableStringify(runtimeKernelWriteTarget('/dev/tee', devices)) ===
      '{"device":"/dev/tee","kind":"device","outputDevice":"/dev/capture"}',
    'kernel write target should preserve source and resolved output devices'
  );
  assertCondition(
    stableStringify(runtimeKernelCopyTarget('/proc/kernel/info', '/dev/tee', devices)) === '{"kind":"file-copy"}',
    'kernel copy target should delegate virtual source-to-device copies to file copy policy'
  );
  assertCondition(
    stableStringify(runtimeKernelFileCopyTarget('/proc/kernel/info', '/dev/tee', devices)) ===
      '{"kind":"device-destination","outputDevice":"/dev/capture","source":{"kind":"proc-file","path":"/proc/kernel/info"}}',
    'kernel file copy target should preserve manifest output device aliases'
  );
  assertCondition(
    stableStringify(runtimeKernelOpenTarget('/dev/stdout', { readable: true }, devices)) ===
      '{"device":"/dev/stdout","kind":"device","readable":false,"writable":false}',
    'kernel open target should not grant reads on write-only devices'
  );
  assertCondition(
    stableStringify(runtimeKernelOpenTarget('/dev/stdin', { writable: true, create: true }, devices)) ===
      '{"device":"/dev/stdin","kind":"device","readable":false,"writable":false}',
    'kernel open target should not grant writes on read-only devices'
  );
  assertCondition(
    stableStringify(runtimeKernelOpenTarget('/dev/tty', { readable: true, writable: true }, devices)) ===
      '{"device":"/dev/tty","kind":"device","readable":true,"writable":true}',
    'kernel open target should grant requested access only when the manifest allows it'
  );
  assertCondition(
    stableStringify(runtimeKernelFileReadTarget('/dev/stdout', devices)) ===
      '{"kind":"error","path":"/dev/stdout","reason":"permission-denied"}',
    'kernel read target should reject high-level reads on write-only devices'
  );
  assertCondition(
    stableStringify(runtimeKernelFileReadTarget('/dev/stdin', devices)) ===
      '{"kind":"device-file","path":"/dev/stdin"}',
    'kernel read target should allow high-level reads on readable devices'
  );
  assertCondition(
    stableStringify(runtimeKernelOpenTarget('/dev/null', { readable: true, writable: true })) ===
      '{"device":"/dev/null","kind":"device","readable":true,"writable":true}',
    'kernel open target should expose /dev/null as readable and writable'
  );
  assertCondition(
    stableStringify(runtimeKernelWriteTarget('/dev/null')) ===
      '{"device":"/dev/null","kind":"device","outputDevice":"/dev/null"}' &&
      stableStringify(runtimeKernelFileReadTarget('/dev/null')) === '{"kind":"device-file","path":"/dev/null"}',
    'kernel policy should route /dev/null through device read/write semantics'
  );
  assertCondition(
    runtimeKernelVirtualDevices().some((device) =>
      device.path === '/dev/null' &&
      device.readable === true &&
      device.writable === true &&
      device.inputDevice === '/dev/null' &&
      device.outputDevice === '/dev/null'
    ),
    'kernel device manifest should include /dev/null'
  );
  assertCondition(
    stableStringify(runtimeKernelMutationTarget('/dev/log', [
      ...devices,
      { path: '/dev/log' as const, readable: false, writable: true, outputDevice: '/dev/stderr' as const },
    ])) === '{"kind":"error","path":"/dev/log","reason":"device-read-only"}',
    'kernel mutation target should recognize manifest custom devices as protected device paths'
  );
  assertCondition(
    stableStringify(runtimeKernelMutationTarget('/dev/log', devices)) ===
      '{"kind":"error","path":"/dev/log","reason":"device-not-found"}',
    'kernel mutation target should reject non-manifest custom device paths as missing'
  );
  assertCondition(
    stableStringify(runtimeKernelMetadataTarget('/dev/log', [
      ...devices,
      { path: '/dev/log' as const, readable: false, writable: true, outputDevice: '/dev/stderr' as const },
    ])) === '{"kind":"ignored-device","path":"/dev/log"}',
    'kernel metadata target should ignore metadata changes on manifest custom devices'
  );
  assertCondition(
    stableStringify(runtimeKernelLinkTarget('/proc/kernel/info', 'copy.txt', devices)) ===
      '{"kind":"error","path":"/proc/kernel/info","reason":"proc-read-only","side":"source"}',
    'kernel link target should reject proc sources through shared policy'
  );
  assertCondition(
    stableStringify(runtimeKernelLinkTarget('source.txt', '/dev/log', [
      ...devices,
      { path: '/dev/log' as const, readable: false, writable: true, outputDevice: '/dev/stderr' as const },
    ])) === '{"kind":"error","path":"/dev/log","reason":"device-read-only","side":"destination"}',
    'kernel link target should reject manifest device destinations through shared policy'
  );
  assertCondition(
    stableStringify(runtimeKernelLinkTarget('source.txt', 'copy.txt', devices)) === '{"kind":"workspace"}',
    'kernel link target should allow workspace hard links'
  );
  assertCondition(
    stableStringify(runtimeKernelRenameTarget('/dev/log', 'copy.txt', [
      ...devices,
      { path: '/dev/log' as const, readable: false, writable: true, outputDevice: '/dev/stderr' as const },
    ])) === '{"kind":"error","path":"/dev/log","reason":"device-read-only","side":"source"}',
    'kernel rename target should reject manifest device sources through shared policy'
  );
  assertCondition(
    stableStringify(runtimeKernelRenameTarget('source.txt', '/proc/kernel/info', devices)) ===
      '{"kind":"error","path":"/proc/kernel/info","reason":"proc-read-only","side":"destination"}',
    'kernel rename target should reject proc destinations through shared policy'
  );
  assertCondition(
    stableStringify(runtimeKernelRenameTarget('source.txt', 'moved.txt', devices)) === '{"kind":"workspace"}',
    'kernel rename target should allow workspace renames'
  );
  assertCondition(
    stableStringify(runtimeKernelSymlinkTarget('/dev/stdout', devices)) ===
      '{"kind":"error","path":"/dev/stdout","reason":"device-read-only"}',
    'kernel symlink target should reject device link paths through shared policy'
  );
  assertCondition(
    stableStringify(runtimeKernelSymlinkTarget('link.txt', devices)) === '{"kind":"workspace"}',
    'kernel symlink target should allow workspace link paths'
  );
  assertCondition(
    stableStringify(runtimeKernelRemoveTarget('/dev/missing', devices)) ===
      '{"kind":"error","path":"/dev/missing","reason":"device-not-found"}',
    'kernel remove target should reject missing manifest devices through shared policy'
  );
  assertCondition(
    stableStringify(runtimeKernelRemoveTarget('stale.txt', devices)) === '{"kind":"workspace"}',
    'kernel remove target should allow workspace removals'
  );
  assertCondition(
    stableStringify(runtimeKernelMkdirTarget('/proc/new', devices)) ===
      '{"kind":"error","path":"/proc/new","reason":"proc-read-only"}',
    'kernel mkdir target should reject proc directories through shared policy'
  );
  assertCondition(
    stableStringify(runtimeKernelMkdirTarget('new-dir', devices)) === '{"kind":"workspace"}',
    'kernel mkdir target should allow workspace directories'
  );
  assertCondition(
    stableStringify(runtimeKernelTruncateTarget('/dev/missing', devices)) ===
      '{"kind":"error","path":"/dev/missing","reason":"device-not-found"}',
    'kernel truncate target should reject missing manifest devices through shared policy'
  );
  assertCondition(
    stableStringify(runtimeKernelTruncateTarget('cache.txt', devices)) === '{"kind":"workspace"}',
    'kernel truncate target should allow workspace files'
  );
}

function assertRuntimeKernelStatTarget(): void {
  const info: RuntimeKernelInfo = {
    name: 'tracekernel',
    version: 'test',
    user: { id: 'test-user', username: 'user', home: '/home/user' },
    host: { hostname: 'tracevm', osName: 'tracekernel' },
    workspace: {
      id: 'test-workspace',
      name: 'weather-api',
      root: '/home/user/weather-api',
      startedAt: '2026-05-18T00:00:00.000Z',
    },
    home: '/home/user',
    cwd: '/home/user/weather-api',
    workspaceRoot: '/home/user/weather-api',
  };
  const devices = [
    { path: '/dev/stdin' as const, readable: true, writable: false, inputDevice: '/dev/stdin' as const },
    { path: '/dev/stdout' as const, readable: false, writable: true, outputDevice: '/dev/stdout' as const },
    { path: '/dev/pts/0' as const, readable: false, writable: true, outputDevice: '/dev/stdout' as const },
  ];

  assertCondition(
    stableStringify(runtimeKernelStatTarget('/dev/stdout', info, devices)) ===
      '{"kind":"stat","path":"/dev/stdout","stat":{"isCharacterDevice":true,"isDirectory":false,"isFile":true,"mode":438,"size":0}}',
    'kernel stat target should stat write-only devices without requiring read permission'
  );
  assertCondition(
    stableStringify(runtimeKernelStatTarget('/dev/stdin', info, devices)) ===
      '{"kind":"stat","path":"/dev/stdin","stat":{"isCharacterDevice":true,"isDirectory":false,"isFile":true,"mode":438,"size":0}}',
    'kernel stat target should stat read-only devices'
  );
  assertCondition(
    stableStringify(runtimeKernelStatTarget('/dev/missing', info, devices)) ===
      '{"kind":"error","path":"/dev/missing","reason":"not-found"}',
    'kernel stat target should reject unknown device namespace paths'
  );
  assertCondition(
    stableStringify(runtimeKernelStatTarget('/dev/pts', info, devices)) ===
      '{"kind":"stat","path":"/dev/pts","stat":{"isCharacterDevice":false,"isDirectory":true,"isFile":false,"mode":493,"size":0}}' &&
      stableStringify(runtimeKernelStatTarget('/dev/pts/0', info, devices)) ===
        '{"kind":"stat","path":"/dev/pts/0","stat":{"isCharacterDevice":true,"isDirectory":false,"isFile":true,"mode":438,"size":0}}',
    'kernel stat target should expose nested manifest device directories and files'
  );
  assertCondition(
    stableStringify(runtimeKernelDirectoryTarget('/dev', devices)) ===
      '{"entries":[{"kind":"directory","name":"pts"},{"kind":"file","name":"stdin"},{"kind":"file","name":"stdout"}],"kind":"directory","path":"/dev"}' &&
      stableStringify(runtimeKernelDirectoryTarget('/dev/pts', devices)) ===
        '{"entries":[{"kind":"file","name":"0"}],"kind":"directory","path":"/dev/pts"}',
    'kernel directory target should list nested manifest device directories'
  );
  const procInfoStat = runtimeKernelStatTarget('/proc/kernel/info', info);
  assertCondition(
    procInfoStat.kind === 'stat' && procInfoStat.stat.isFile && procInfoStat.stat.size > 0,
    'kernel stat target should stat proc files with content size'
  );
  assertCondition(
    stableStringify(runtimeKernelStatTarget('/proc/missing', info)) ===
      '{"kind":"error","path":"/proc/missing","reason":"not-found"}',
    'kernel stat target should reject unknown proc paths'
  );
}

function assertRuntimeProjectIoBridgeOutputDevices(): void {
  const events: RuntimeCommandEvent[] = [];
  const io = createRuntimeProjectIoBridge((event) => events.push(event));

  io.output('stdout', 'direct\n', undefined, '/dev/stdout');
  io.output('stdout', 'tty\n', '/dev/stdout', '/dev/tty');
  io.output('stderr', 'direct-err\n', undefined, '/dev/stderr');
  io.output('stderr', 'log\n', '/dev/stderr', '/dev/log');

  assertCondition(
    stableStringify(events) === stableStringify([
      { type: 'output', stream: 'stdout', device: '/dev/stdout', data: 'direct\n' },
      { type: 'output', stream: 'stdout', device: '/dev/stdout', sourceDevice: '/dev/tty', data: 'tty\n' },
      { type: 'output', stream: 'stderr', device: '/dev/stderr', data: 'direct-err\n' },
      { type: 'output', stream: 'stderr', device: '/dev/stderr', sourceDevice: '/dev/log', data: 'log\n' },
    ]),
    `runtime project bridge should suppress redundant sourceDevice values: ${stableStringify(events)}`
  );
}

function assertWorkerRuntimeKernelPolicyContract(): void {
  const knownDevices = ['/dev/stdout', '/dev/log', '/dev/custom-in'];
  const devices = [
    { path: '/dev/stdout', readable: false, writable: true, outputDevice: '/dev/stdout' },
    { path: '/dev/log', readable: false, writable: true, outputDevice: '/dev/stderr' },
    { path: '/dev/custom-in', readable: true, writable: false, inputDevice: '/dev/stdin' },
    { path: '/dev/pts/0', readable: false, writable: true, outputDevice: '/dev/stdout' },
    { path: '/dev/null', readable: true, writable: true, inputDevice: '/dev/null', outputDevice: '/dev/null' },
  ];
  const readOnlyPaths = ['/tracekernel/custom', '/proc/kernel/info'];
  const classicContext = { self: {} as { TraceRuntimeKernelPolicy?: typeof import('../workers/shared/runtime-kernel-policy.js') } };
  vm.createContext(classicContext);
  vm.runInContext(readFileSync('workers/shared/runtime-kernel-policy-classic.js', 'utf8'), classicContext);
  const classicPolicy = classicContext.self.TraceRuntimeKernelPolicy;

  assertCondition(
    normalizeWorkerKernelDeviceReference('/dev/log') === '/dev/log' &&
      normalizeWorkerKernelDeviceReference('/dev/nested/device') === '',
    'shared worker kernel policy should normalize only single-segment device references'
  );
  assertCondition(
    stableStringify(workerRuntimeKernelVirtualMutationTarget('/proc/kernel/info', { knownDevices, readOnlyPaths })) ===
      stableStringify({ kind: 'error', reason: 'proc-read-only', path: '/proc/kernel/info' }),
    'shared worker kernel policy should reject proc mutations as read-only'
  );
  assertCondition(
    stableStringify(workerRuntimeKernelVirtualPathTarget('/proc/kernel/info', { knownDevices, readOnlyPaths })) ===
      stableStringify({ kind: 'proc', path: '/proc/kernel/info' }),
    'shared worker kernel policy should classify proc paths before materialized read-only files'
  );
  assertCondition(
    stableStringify(workerRuntimeKernelVirtualPathTarget('/dev', { knownDevices, readOnlyPaths })) ===
      stableStringify({ kind: 'device-directory', path: '/dev' }),
    'shared worker kernel policy should classify the device directory'
  );
  assertCondition(
    stableStringify(workerRuntimeKernelVirtualPathTarget('/dev/log', { knownDevices, readOnlyPaths })) ===
      stableStringify({ kind: 'device-file', path: '/dev/log' }),
    'shared worker kernel policy should classify manifest devices'
  );
  assertCondition(
    stableStringify(workerRuntimeKernelVirtualPathTarget('/dev/log', { devices, readOnlyPaths })) ===
      stableStringify({ kind: 'device-file', path: '/dev/log' }) &&
      workerRuntimeKernelDeviceOutputTarget(devices, '/dev/log') === '/dev/stderr' &&
      workerRuntimeKernelDeviceInputSource(devices, '/dev/custom-in') === '/dev/stdin' &&
      workerRuntimeKernelDeviceOutputTarget(devices, '/dev/pts/0') === '/dev/stdout' &&
      stableStringify(workerRuntimeKernelDeviceDirEntries(devices, '/dev')) === stableStringify(['custom-in', 'log', 'null', 'pts', 'stdout']) &&
      stableStringify(workerRuntimeKernelDeviceDirEntries(devices, '/dev/pts')) === stableStringify(['0']) &&
      workerRuntimeKernelDeviceEntryKind(devices, '/dev/pts') === 'directory' &&
      workerRuntimeKernelDeviceEntryKind(devices, '/dev/pts/0') === 'file' &&
      workerRuntimeKernelDeviceOutputTarget(devices, '/dev/null') === '/dev/null',
    'shared worker kernel policy should classify, list, and route manifest devices from device metadata'
  );
  assertCondition(
    stableStringify(workerRuntimeKernelVirtualPathTarget('/dev/pts', { devices, readOnlyPaths })) ===
      stableStringify({ kind: 'device-directory', path: '/dev/pts' }),
    'shared worker kernel policy should classify nested manifest device directories'
  );
  assertCondition(
    stableStringify(workerRuntimeKernelVirtualOpenTarget('/dev/log', { writable: true }, { devices })) ===
      stableStringify({ kind: 'device', device: '/dev/log', readable: false, writable: true }) &&
      stableStringify(workerRuntimeKernelVirtualOpenTarget('/dev/pts/0', { writable: true }, { devices })) ===
        stableStringify({ kind: 'device', device: '/dev/pts/0', readable: false, writable: true }) &&
      stableStringify(workerRuntimeKernelVirtualOpenTarget('/dev/log', { readable: true }, { devices })) ===
        stableStringify({ kind: 'device', device: '/dev/log', readable: false, writable: false }) &&
      stableStringify(workerRuntimeKernelVirtualOpenTarget('/proc/kernel/info', { writable: true }, { devices, procEntryKind: 'file' })) ===
        stableStringify({ kind: 'error', reason: 'read-only', path: '/proc/kernel/info' }) &&
      stableStringify(workerRuntimeKernelVirtualOpenTarget('/proc/kernel', { readable: true }, { devices, procEntryKind: 'directory' })) ===
        stableStringify({ kind: 'error', reason: 'is-directory', path: '/proc/kernel' }),
    'shared worker kernel policy should classify virtual open targets'
  );
  assertCondition(
    stableStringify(workerRuntimeKernelVirtualMutationTarget('/tracekernel/new', { knownDevices, readOnlyPaths })) ===
      stableStringify({ kind: 'error', reason: 'kernel-read-only', path: '/tracekernel/new' }),
    'shared worker kernel policy should protect materialized kernel file namespaces'
  );
  assertCondition(
    stableStringify(workerRuntimeKernelVirtualMutationTarget('/dev/log', { knownDevices, readOnlyPaths })) ===
      stableStringify({ kind: 'error', reason: 'device-read-only', path: '/dev/log' }),
    'shared worker kernel policy should reject manifest device mutations'
  );
  assertCondition(
    stableStringify(workerRuntimeKernelVirtualMutationTarget('/dev/missing', { knownDevices, readOnlyPaths })) ===
      stableStringify({ kind: 'error', reason: 'device-not-found', path: '/dev/missing' }),
    'shared worker kernel policy should reject non-manifest device namespace paths as missing'
  );
  assertCondition(
    stableStringify(workerRuntimeKernelVirtualMutationTarget('src/value.txt', { knownDevices, readOnlyPaths })) ===
      stableStringify({ kind: 'workspace', path: '/src/value.txt' }),
    'shared worker kernel policy should allow workspace mutations'
  );
  assertCondition(
    classicPolicy !== undefined &&
      stableStringify(classicPolicy.runtimeKernelVirtualPathTarget('/dev/log', { knownDevices, readOnlyPaths })) ===
        stableStringify(workerRuntimeKernelVirtualPathTarget('/dev/log', { knownDevices, readOnlyPaths })) &&
      classicPolicy.normalizeRuntimeKernelManifestDevicePath('/dev/pts/0') === normalizeWorkerKernelManifestDevicePath('/dev/pts/0') &&
      stableStringify(classicPolicy.runtimeKernelDeviceDirEntries(devices, '/dev/pts')) ===
        stableStringify(workerRuntimeKernelDeviceDirEntries(devices, '/dev/pts')) &&
      classicPolicy.runtimeKernelDeviceEntryKind(devices, '/dev/pts') === workerRuntimeKernelDeviceEntryKind(devices, '/dev/pts') &&
      stableStringify(classicPolicy.runtimeKernelVirtualMutationTarget('/tracekernel/new', { knownDevices, readOnlyPaths })) ===
        stableStringify(workerRuntimeKernelVirtualMutationTarget('/tracekernel/new', { knownDevices, readOnlyPaths })) &&
      classicPolicy.runtimeKernelDeviceOutputTarget(devices, '/dev/log') === workerRuntimeKernelDeviceOutputTarget(devices, '/dev/log') &&
      classicPolicy.runtimeKernelDeviceInputSource(devices, '/dev/custom-in') === workerRuntimeKernelDeviceInputSource(devices, '/dev/custom-in') &&
      stableStringify(classicPolicy.runtimeKernelVirtualOpenTarget('/dev/log', { writable: true }, { devices })) ===
        stableStringify(workerRuntimeKernelVirtualOpenTarget('/dev/log', { writable: true }, { devices })),
    'classic worker kernel policy should match module worker kernel policy'
  );
}

async function assertRuntimeProjectWorkerBridgeContract(): Promise<void> {
  const controllerEvents: RuntimeCommandEvent[] = [];
  const controllerAppliedChanges: string[] = [];
  const controller = new RuntimeProjectLiveIoController({
    onEvent: (event) => controllerEvents.push(event),
    applyFileChange: async (change, phase) => {
      controllerAppliedChanges.push(`${phase}:${change.path}`);
      return change.path !== 'controller-hidden.txt';
    },
  });
  controller.handleRuntimeEvent({ type: 'output', stream: 'stdout', device: '/dev/stdout', data: 'controller-one\n' });
  controller.handleRuntimeEvent({ type: 'file-change', phase: 'live', change: { path: 'controller-live.txt', contents: 'live\n' } });
  controller.handleRuntimeEvent({ type: 'file-change', phase: 'live', change: { path: 'controller-hidden.txt', contents: 'hidden\n' } });
  controller.handleRuntimeEvent({ type: 'output', stream: 'stdout', device: '/dev/stdout', data: 'controller-two\n' });
  await controller.flush();
  const controllerResult = controller.filterAppliedResultFiles({
    stdout: 'controller-one\ncontroller-two\ncontroller-three\n',
    stderr: '',
    exitCode: 0,
    files: [
      { path: 'controller-live.txt', contents: 'final-live\n' },
      { path: 'controller-hidden.txt', contents: 'final-hidden\n' },
      { path: 'controller-returned.txt', contents: 'returned\n' },
    ],
  });
  controller.emitMissingFinalOutput(controllerResult, (stream, data) => {
    controller.emit({ type: 'output', stream, device: stream === 'stdout' ? '/dev/stdout' : '/dev/stderr', data });
  });

  assertCondition(
    stableStringify(controllerAppliedChanges) === stableStringify(['live:controller-live.txt', 'live:controller-hidden.txt']) &&
      stableStringify(controllerResult.files) === stableStringify([{ path: 'controller-returned.txt', contents: 'returned\n' }]),
    `runtime live I/O controller should apply live changes and filter final-diff duplicates: ${stableStringify({ controllerAppliedChanges, controllerResult })}`
  );
  assertCondition(
    controllerEvents
      .filter((event) => event.type === 'output' && event.stream === 'stdout')
      .map((event) => event.data)
      .join('') === 'controller-one\ncontroller-two\ncontroller-three\n' &&
      !controllerEvents.some((event) => event.type === 'file-change' && event.change.path === 'controller-hidden.txt'),
    `runtime live I/O controller should preserve queued event ordering and reconcile final output suffixes: ${stableStringify(controllerEvents)}`
  );

  const events: RuntimeCommandEvent[] = [];
  const appliedChanges: string[] = [];
  const request: RuntimeProjectCommandRequest<'run'> = {
    code: '',
    source: 'run',
    scriptPath: 'main',
    args: ['alpha'],
    cwd: '/workspace',
    env: {},
    stdin: 'input\n',
    project: {
      files: [{ path: 'main.txt', contents: 'main\n' }],
    },
    onEvent: (event) => events.push(event),
  };

  const result = await runRuntimeProjectWorkerBridge({
    request,
    startPhase: 'process-start',
    startMessage: 'Starting contract worker',
    startDetail: { cwd: request.cwd },
    finishPhase: 'process-exit',
    finishMessage: 'Finished contract worker',
    finishDetail: (commandResult) => ({ exitCode: commandResult.exitCode, returnedFiles: commandResult.files?.length ?? 0 }),
    applyFileChange: async (change, phase) => {
      appliedChanges.push(`${phase}:${change.path}`);
      return change.path !== 'hidden-live.txt';
    },
    run: async (workerRequest, onEvent) => {
      assertCondition(
        !('onEvent' in workerRequest) &&
          workerRequest.stdin === 'input\n' &&
          workerRequest.project.files.length === 1,
        `runtime worker bridge should pass a serializable project request: ${stableStringify(workerRequest)}`
      );
      onEvent({ type: 'output', stream: 'stdout', device: '/dev/stdout', data: 'streamed\n' });
      onEvent({ type: 'file-change', phase: 'live', change: { path: 'live.txt', contents: 'live\n' } });
      onEvent({ type: 'file-change', phase: 'live', change: { path: 'hidden-live.txt', contents: 'hidden\n' } });
      onEvent({ type: 'output', stream: 'stderr', device: '/dev/stderr', data: 'streamed-err\n' });
      return {
        stdout: 'streamed\n',
        stderr: 'streamed-err\n',
        exitCode: 0,
        files: [
          { path: 'live.txt', contents: 'final-live\n' },
          { path: 'hidden-live.txt', contents: 'final-hidden\n' },
          { path: 'returned.txt', contents: 'returned\n' },
        ],
      };
    },
  });

  assertCondition(
    stableStringify(appliedChanges) === stableStringify(['live:live.txt', 'live:hidden-live.txt']),
    `runtime worker bridge should apply live file changes in worker order: ${stableStringify(appliedChanges)}`
  );
  assertCondition(
    result.stdout === 'streamed\n' &&
      result.stderr === 'streamed-err\n' &&
      result.exitCode === 0 &&
      stableStringify(result.files) === stableStringify([{ path: 'returned.txt', contents: 'returned\n' }]),
    `runtime worker bridge should return stdout/stderr and filter already-applied file changes: ${stableStringify(result)}`
  );
  assertCondition(
    events[0]?.type === 'status' &&
      events[0].phase === 'process-start' &&
      events[events.length - 1]?.type === 'status' &&
      events[events.length - 1].phase === 'process-exit',
    `runtime worker bridge should wrap worker events in start/finish status events: ${stableStringify(events)}`
  );
  assertCondition(
    events.filter((event) => event.type === 'output' && event.stream === 'stdout').length === 1 &&
      events.filter((event) => event.type === 'output' && event.stream === 'stderr').length === 1,
    `runtime worker bridge should not duplicate final stdout/stderr after streamed output: ${stableStringify(events)}`
  );

  const partialOutputEvents: RuntimeCommandEvent[] = [];
  const partialOutputResult = await runRuntimeProjectWorkerBridge({
    request: { ...request, onEvent: (event) => partialOutputEvents.push(event) },
    startPhase: 'process-start',
    startMessage: 'Starting partial-output worker',
    finishPhase: 'process-exit',
    finishMessage: 'Finished partial-output worker',
    run: async (_workerRequest, onEvent) => {
      onEvent({ type: 'output', stream: 'stdout', device: '/dev/stdout', data: 'line-one\n' });
      onEvent({ type: 'output', stream: 'stderr', device: '/dev/stderr', data: 'err-one\n' });
      return {
        stdout: 'line-one\nline-two\n',
        stderr: 'err-one\nerr-two\n',
        exitCode: 0,
      };
    },
  });

  assertCondition(
    partialOutputResult.stdout === 'line-one\nline-two\n' &&
      partialOutputResult.stderr === 'err-one\nerr-two\n' &&
      partialOutputResult.exitCode === 0,
    `runtime worker bridge should preserve partial-output command results: ${stableStringify(partialOutputResult)}`
  );
  assertCondition(
    partialOutputEvents
      .filter((event) => event.type === 'output' && event.stream === 'stdout')
      .map((event) => event.data)
      .join('') === 'line-one\nline-two\n' &&
      partialOutputEvents
        .filter((event) => event.type === 'output' && event.stream === 'stderr')
        .map((event) => event.data)
        .join('') === 'err-one\nerr-two\n',
    `runtime worker bridge should stream missing final stdout/stderr suffixes: ${stableStringify(partialOutputEvents)}`
  );
  const partialOutputLastOutputIndex = partialOutputEvents.findLastIndex((event) => event.type === 'output');
  const partialOutputExitIndex = partialOutputEvents.findIndex((event) => event.type === 'status' && event.phase === 'process-exit');
  assertCondition(
    partialOutputLastOutputIndex >= 0 && partialOutputExitIndex > partialOutputLastOutputIndex,
    `runtime worker bridge should emit reconciled final output before process-exit status: ${stableStringify(partialOutputEvents)}`
  );

  assertCondition(
    events.some((event) =>
      event.type === 'file-change' &&
        event.phase === 'live' &&
        event.change.path === 'live.txt'
    ) &&
      !events.some((event) => event.type === 'file-change' && event.change.path === 'hidden-live.txt'),
    `runtime worker bridge should apply live changes before forwarding and honor suppressed events: ${stableStringify(events)}`
  );
  const liveEventIndex = events.findIndex((event) => event.type === 'file-change' && event.change.path === 'live.txt');
  const stderrEventIndex = events.findIndex((event) => event.type === 'output' && event.stream === 'stderr');
  assertCondition(
    liveEventIndex >= 0 && stderrEventIndex > liveEventIndex,
    `runtime worker bridge should preserve file-change before later output ordering: ${stableStringify(events)}`
  );

  const failedEvents: RuntimeCommandEvent[] = [];
  const failedResult = await runRuntimeProjectWorkerBridge({
    request: { ...request, onEvent: (event) => failedEvents.push(event) },
    startPhase: 'process-start',
    startMessage: 'Starting failing contract worker',
    finishPhase: 'process-exit',
    finishMessage: 'Finished failing contract worker',
    applyFileChange: async (change) => {
      throw new Error(`apply-failed:${change.path}`);
    },
    run: async (_workerRequest, onEvent) => {
      onEvent({ type: 'file-change', phase: 'live', change: { path: 'bad-live.txt', contents: 'bad\n' } });
      onEvent({ type: 'output', stream: 'stdout', device: '/dev/stdout', data: 'after-bad\n' });
      return { stdout: 'final-after-bad\n', stderr: '', exitCode: 0 };
    },
  });

  assertCondition(
    failedResult.exitCode === 1 &&
      failedResult.stderr === 'apply-failed:bad-live.txt\n' &&
      failedResult.stdout === '',
    `runtime worker bridge should return command-shaped live apply failures: ${stableStringify(failedResult)}`
  );
  assertCondition(
    failedEvents.some((event) =>
      event.type === 'status' &&
        event.phase === 'process-exit' &&
        event.detail?.exitCode === 1 &&
        event.detail.error === 'apply-failed:bad-live.txt'
    ) &&
      failedEvents.some((event) =>
        event.type === 'output' &&
          event.stream === 'stderr' &&
          event.data === 'apply-failed:bad-live.txt\n'
      ) &&
      !failedEvents.some((event) => event.type === 'output' && event.data.includes('after-bad')),
    `runtime worker bridge should stop later output after live apply failures: ${stableStringify(failedEvents)}`
  );
  const failedErrorOutputIndex = failedEvents.findIndex((event) =>
    event.type === 'output' &&
      event.stream === 'stderr' &&
      event.data === 'apply-failed:bad-live.txt\n'
  );
  const failedExitIndex = failedEvents.findIndex((event) => event.type === 'status' && event.phase === 'process-exit');
  assertCondition(
    failedErrorOutputIndex >= 0 && failedExitIndex > failedErrorOutputIndex,
    `runtime worker bridge should emit apply failure stderr before process-exit status: ${stableStringify(failedEvents)}`
  );
}

function collectEnabledCapabilityPaths(
  value: RuntimeCapabilities | Record<string, unknown>,
  prefix = ''
): string[] {
  return Object.entries(value).flatMap(([key, nestedValue]) => {
    const nextPath = prefix ? `${prefix}.${key}` : key;
    if (typeof nestedValue === 'boolean') {
      return nestedValue ? [nextPath] : [];
    }
    if (nestedValue && typeof nestedValue === 'object' && !Array.isArray(nestedValue)) {
      return collectEnabledCapabilityPaths(nestedValue as Record<string, unknown>, nextPath);
    }
    return [];
  });
}

const COMMON_STABLE_COVERAGE = [
  'execution.styles.function',
  'execution.styles.solutionMethod',
  'execution.styles.opsClass',
  'execution.styles.script',
  'execution.styles.interviewMode',
  'execution.timeouts.clientTimeouts',
  'tracing.supported',
  'tracing.events.line',
  'tracing.events.call',
  'tracing.events.return',
  'tracing.events.exception',
  'tracing.events.timeout',
  'tracing.controls.maxTraceSteps',
  'tracing.controls.maxLineEvents',
  'tracing.controls.maxSingleLineHits',
  'tracing.controls.maxStoredEvents',
  'tracing.controls.minimalTrace',
  'tracing.fidelity.preciseLineMapping',
  'tracing.fidelity.stableFunctionNames',
  'tracing.fidelity.callStack',
  'diagnostics.runtimeErrors',
  'structures.treeNodeRefs',
  'structures.listNodeRefs',
  'structures.mapSerialization',
  'structures.setSerialization',
  'structures.graphSerialization',
  'structures.cycleReferences',
] as const satisfies readonly string[];

const PROJECT_IO_COVERAGE = [
  'project.workspace.supported',
  'project.workspace.kernelFs',
  'project.workspace.virtualDevices',
  'project.workspace.virtualProc',
  'project.filesystem.finalDiff',
  'project.filesystem.liveMutationEvents',
  'project.filesystem.binaryFiles',
  'project.filesystem.directories',
  'project.stdio.stdin',
  'project.stdio.outputEvents',
  'project.stdio.deviceFiles',
] as const satisfies readonly string[];

const LANGUAGE_CONFORMANCE_COVERAGE: Record<Language, readonly string[]> = {
  python: [
    ...COMMON_STABLE_COVERAGE,
    ...PROJECT_IO_COVERAGE,
    'execution.timeouts.runtimeTimeouts',
    'project.filesystem.providerLiveInterception',
    'tracing.events.stdout',
    'diagnostics.mappedErrorLines',
  ],
  javascript: [...COMMON_STABLE_COVERAGE, ...PROJECT_IO_COVERAGE, 'project.filesystem.providerLiveInterception'],
  typescript: [
    ...COMMON_STABLE_COVERAGE,
    'diagnostics.compileErrors',
    'diagnostics.mappedErrorLines',
  ],
  java: [
    'execution.styles.function',
    'execution.styles.solutionMethod',
    'execution.styles.opsClass',
    'execution.styles.script',
    'execution.styles.interviewMode',
    'execution.timeouts.clientTimeouts',
    'execution.timeouts.runtimeTimeouts',
    'project.workspace.supported',
    'project.workspace.kernelFs',
    'project.workspace.virtualDevices',
    'project.workspace.virtualProc',
    'project.filesystem.finalDiff',
    'project.filesystem.liveMutationEvents',
    'project.filesystem.binaryFiles',
    'project.filesystem.directories',
    'project.stdio.stdin',
    'project.stdio.outputEvents',
    'project.stdio.deviceFiles',
    'tracing.supported',
    'tracing.events.line',
    'tracing.events.call',
    'tracing.events.return',
    'tracing.events.exception',
    'tracing.events.timeout',
    'tracing.controls.maxTraceSteps',
    'tracing.controls.maxStoredEvents',
    'tracing.fidelity.preciseLineMapping',
    'tracing.fidelity.stableFunctionNames',
    'tracing.fidelity.callStack',
    'diagnostics.compileErrors',
    'diagnostics.runtimeErrors',
    'diagnostics.stackTraces',
    'structures.treeNodeRefs',
    'structures.listNodeRefs',
    'structures.mapSerialization',
    'structures.setSerialization',
    'structures.cycleReferences',
  ],
  csharp: [
    'execution.styles.function',
    'execution.styles.solutionMethod',
    'execution.styles.opsClass',
    'execution.styles.script',
    'execution.styles.interviewMode',
    'execution.timeouts.clientTimeouts',
    'execution.timeouts.runtimeTimeouts',
    'project.workspace.supported',
    'project.workspace.kernelFs',
    'project.workspace.virtualDevices',
    'project.workspace.virtualProc',
    'project.filesystem.finalDiff',
    'project.filesystem.liveMutationEvents',
    'project.filesystem.binaryFiles',
    'project.filesystem.directories',
    'project.stdio.stdin',
    'project.stdio.outputEvents',
    'project.stdio.deviceFiles',
    'tracing.supported',
    'tracing.events.line',
    'tracing.events.call',
    'tracing.events.return',
    'tracing.events.exception',
    'tracing.events.stdout',
    'tracing.events.timeout',
    'tracing.controls.maxTraceSteps',
    'tracing.controls.maxLineEvents',
    'tracing.controls.maxSingleLineHits',
    'tracing.controls.maxStoredEvents',
    'tracing.controls.minimalTrace',
    'tracing.fidelity.preciseLineMapping',
    'tracing.fidelity.stableFunctionNames',
    'tracing.fidelity.callStack',
    'diagnostics.compileErrors',
    'diagnostics.runtimeErrors',
    'diagnostics.mappedErrorLines',
    'structures.treeNodeRefs',
    'structures.listNodeRefs',
    'structures.mapSerialization',
    'structures.setSerialization',
    'structures.graphSerialization',
    'structures.cycleReferences',
  ],
  cpp: [
    'execution.styles.function',
    'execution.styles.solutionMethod',
    'execution.styles.opsClass',
    'execution.styles.script',
    'execution.styles.interviewMode',
    'execution.timeouts.clientTimeouts',
    'execution.timeouts.runtimeTimeouts',
    'project.workspace.supported',
    'project.workspace.kernelFs',
    'project.workspace.virtualDevices',
    'project.workspace.virtualProc',
    'project.filesystem.finalDiff',
    'project.filesystem.liveMutationEvents',
    'project.filesystem.binaryFiles',
    'project.filesystem.directories',
    'project.stdio.stdin',
    'project.stdio.outputEvents',
    'project.stdio.deviceFiles',
    'tracing.supported',
    'tracing.events.line',
    'tracing.events.call',
    'tracing.events.return',
    'tracing.events.exception',
    'tracing.events.stdout',
    'tracing.events.timeout',
    'tracing.controls.maxTraceSteps',
    'tracing.controls.maxLineEvents',
    'tracing.controls.maxSingleLineHits',
    'tracing.controls.maxStoredEvents',
    'tracing.controls.minimalTrace',
    'tracing.fidelity.preciseLineMapping',
    'tracing.fidelity.stableFunctionNames',
    'tracing.fidelity.callStack',
    'diagnostics.compileErrors',
    'diagnostics.runtimeErrors',
    'diagnostics.mappedErrorLines',
    'structures.treeNodeRefs',
    'structures.listNodeRefs',
    'structures.mapSerialization',
    'structures.setSerialization',
    'structures.graphSerialization',
    'structures.cycleReferences',
  ],
};

function assertProfileCoverageAlignment(profile: LanguageRuntimeProfile): void {
  const declaredCapabilities = new Set(collectEnabledCapabilityPaths(profile.capabilities));
  const coveredCapabilities = new Set(LANGUAGE_CONFORMANCE_COVERAGE[profile.language] ?? []);

  for (const capabilityPath of declaredCapabilities) {
    assertCondition(
      coveredCapabilities.has(capabilityPath),
      `${profile.language} declares capability "${capabilityPath}" without matching conformance coverage`
    );
  }
}

function createUnsupportedProfile(
  overrides: Partial<LanguageRuntimeProfile['capabilities']> = {}
): LanguageRuntimeProfile {
  return {
    language: 'javascript',
    maturity: 'experimental',
    capabilities: {
      execution: {
        styles: {
          function: true,
          solutionMethod: false,
          opsClass: false,
          script: false,
          interviewMode: false,
        },
        timeouts: {
          clientTimeouts: true,
          runtimeTimeouts: false,
        },
      },
      project: {
        workspace: {
          supported: false,
          kernelFs: false,
          virtualDevices: false,
          virtualProc: false,
        },
        filesystem: {
          finalDiff: false,
          liveMutationEvents: false,
          providerLiveInterception: false,
          binaryFiles: false,
          directories: false,
        },
        stdio: {
          stdin: false,
          outputEvents: false,
          deviceFiles: false,
        },
      },
      tracing: {
        supported: false,
        events: {
          line: false,
          call: false,
          return: false,
          exception: false,
          stdout: false,
          timeout: false,
        },
        controls: {
          maxTraceSteps: false,
          maxLineEvents: false,
          maxSingleLineHits: false,
          maxStoredEvents: false,
          minimalTrace: false,
        },
        fidelity: {
          preciseLineMapping: false,
          stableFunctionNames: false,
          callStack: false,
        },
      },
      diagnostics: {
        compileErrors: false,
        runtimeErrors: true,
        mappedErrorLines: false,
        stackTraces: false,
      },
      structures: {
        treeNodeRefs: false,
        listNodeRefs: false,
        mapSerialization: false,
        setSerialization: false,
        graphSerialization: false,
        cycleReferences: false,
      },
      ...overrides,
    },
  };
}

function runPythonCase(
  solutionCode: string,
  functionName: string,
  inputs: Record<string, unknown>
): { success: boolean; output?: unknown; error?: string } {
  const script = generateSolutionScript(solutionCode, functionName, inputs);
  const run = spawnSync('python3', ['-c', script], {
    encoding: 'utf8',
    maxBuffer: 20 * 1024 * 1024,
  });

  if (run.error) {
    throw new Error(`python3 execution failed: ${run.error.message}`);
  }
  if (run.status !== 0) {
    throw new Error(`python3 exited with code ${run.status}: ${run.stderr || run.stdout}`);
  }

  const lines = String(run.stdout || '')
    .trim()
    .split('\n')
    .filter(Boolean);
  const last = lines[lines.length - 1];
  if (!last) {
    throw new Error('No JSON output from python process');
  }

  const parsed = JSON.parse(last) as { success: boolean; output?: unknown; error?: string };
  return parsed;
}

async function testJavaSerializedResultNormalization(): Promise<void> {
  const trace = javaTraceHooksEventsToRuntimeTrace([
    `trace:${JSON.stringify({ kind: 'return', line: 1, function: 'solve', value: [1, true, 'ok'] })}`,
  ]);
  assertCondition(
    stableStringify(normalizeJavaSerializedResult('[1,true,"ok"]')) === stableStringify([1, true, 'ok']),
    'Java TraceHooks result decoding should decode serialized JSON arrays'
  );
  assertCondition(
    stableStringify(trace.events.find((event) => event.kind === 'return')?.value) === stableStringify([1, true, 'ok']),
    'Java TraceHooks runtime trace assembly should decode serialized return values'
  );
  assertCondition(
    normalizeJavaSerializedResult('"true"') === 'true',
    'Java TraceHooks result decoding should decode serialized Java strings without coercing their contents'
  );

  let nextOutput: unknown = 7;
  const workerClient = {
    init: async () => ({ success: true, loadTimeMs: 0 }),
    executeWithTracing: async () => ({
      success: true,
      output: nextOutput,
      events: [`trace:${JSON.stringify({ kind: 'return', line: 1, function: 'solve' })}`],
      trace: javaTraceHooksEventsToRuntimeTrace([
        `trace:${JSON.stringify({ kind: 'return', line: 1, function: 'solve' })}`,
      ]),
      sourceText: 'return 7;',
      executionTimeMs: 1,
      consoleOutput: [],
    }),
    executeCode: async () => ({
      success: true,
      output: nextOutput,
      consoleOutput: [],
    }),
    executeCodeInterviewMode: async () => ({
      success: true,
      output: nextOutput,
      consoleOutput: [],
    }),
  };
  const javaClient = createJavaRuntimeClient(workerClient as unknown as JavaWorkerClient);

  const tracedNumber = await javaClient.executeWithTracing('class Solution {}', 'solve', {});
  assertCondition(tracedNumber.output === 7, 'Java runtime tracing should preserve worker-normalized numeric output');

  nextOutput = false;
  const executedBoolean = await javaClient.executeCode('class Solution {}', 'solve', {});
  assertCondition(executedBoolean.output === false, 'Java runtime executeCode should preserve worker-normalized boolean output');

  nextOutput = 'false';
  const executedString = await javaClient.executeCode('class Solution {}', 'solve', {});
  assertCondition(
    executedString.output === 'false',
    'Java runtime executeCode should preserve already-normalized string output'
  );

  nextOutput = [2, 3];
  const interviewArray = await javaClient.executeCodeInterviewMode('class Solution {}', 'solve', {});
  assertCondition(
    stableStringify(interviewArray.output) === stableStringify([2, 3]),
    'Java runtime interview execution should preserve worker-normalized array output'
  );

  console.log('PASS: Java TraceHooks serialized results normalize without double-parsing runtime outputs');
}

async function main(): Promise<void> {
  assertRuntimeKernelOpenDevicePermissions();
  console.log('PASS: runtime kernel open device permissions');
  assertRuntimeKernelStatTarget();
  console.log('PASS: runtime kernel virtual stat target');
  assertRuntimeProjectIoBridgeOutputDevices();
  console.log('PASS: runtime project bridge output device metadata');
  assertWorkerRuntimeKernelPolicyContract();
  console.log('PASS: worker runtime kernel mutation policy contract');
  await assertRuntimeProjectWorkerBridgeContract();
  console.log('PASS: runtime project worker bridge live I/O contract');

  await testJavaSerializedResultNormalization();
  const profiles = getSupportedLanguageProfiles();

  assertCondition(SUPPORTED_LANGUAGES.includes('python'), 'SUPPORTED_LANGUAGES should include python');
  assertCondition(SUPPORTED_LANGUAGES.includes('javascript'), 'SUPPORTED_LANGUAGES should include javascript');
  assertCondition(SUPPORTED_LANGUAGES.includes('typescript'), 'SUPPORTED_LANGUAGES should include typescript');
  assertCondition(SUPPORTED_LANGUAGES.includes('java'), 'SUPPORTED_LANGUAGES should include java');
  assertCondition(SUPPORTED_LANGUAGES.includes('csharp'), 'SUPPORTED_LANGUAGES should include csharp');
  assertCondition(SUPPORTED_LANGUAGES.includes('cpp'), 'SUPPORTED_LANGUAGES should include cpp');
  assertCondition(
    stableStringify(SUPPORTED_LANGUAGES) === stableStringify(profiles.map((profile) => profile.language)),
    'SUPPORTED_LANGUAGES should stay aligned with the runtime profile registry'
  );
  const runtimeInfos = getSupportedLanguageRuntimeInfos();
  assertCondition(
    stableStringify(SUPPORTED_LANGUAGES) === stableStringify(runtimeInfos.map((info) => info.language)),
    'SUPPORTED_LANGUAGES should stay aligned with the runtime info registry'
  );
  for (const language of SUPPORTED_LANGUAGES) {
    assertCondition(isLanguageSupported(language), `${language} should be reported as supported`);
    assertCondition(
      getLanguageRuntimeProfile(language).language === language,
      `${language} should resolve a matching runtime profile`
    );
    assertCondition(
      getLanguageRuntimeInfo(language).language === language,
      `${language} should resolve matching runtime info`
    );
  }
  const pythonInfo = getLanguageRuntimeInfo('python');
  const javascriptInfo = getLanguageRuntimeInfo('javascript');
  const typescriptInfo = getLanguageRuntimeInfo('typescript');
  const javaInfo = getLanguageRuntimeInfo('java');
  const csharpInfo = getLanguageRuntimeInfo('csharp');
  const cppInfo = getLanguageRuntimeInfo('cpp');
  assertCondition(
    pythonInfo.displayName === 'Python' &&
      /^Python \d+\.\d+\.\d+ \(Pyodide \d+\.\d+\.\d+\)$/.test(pythonInfo.versionLabel),
    'Python runtime info should expose generated Python and Pyodide versions'
  );
  assertCondition(
    pythonInfo.libraries?.some((library) => library.name === 'sortedcontainers' && Boolean(library.version)) === true,
    'Python runtime info should expose sortedcontainers'
  );
  assertCondition(
    javascriptInfo.libraries?.some((library) => library.name === 'lodash' && Boolean(library.version)) === true,
    'JavaScript runtime info should expose lodash'
  );
  assertCondition(
    typescriptInfo.compiler?.name === 'TypeScript' && Boolean(typescriptInfo.compiler.version),
    'TypeScript runtime info should expose the generated compiler version'
  );
  assertCondition(
    typescriptInfo.libraries?.some((library) => library.name === 'lodash' && Boolean(library.version)) === true,
    'TypeScript runtime info should expose the JavaScript runtime libraries'
  );
  assertCondition(
    javaInfo.versionLabel === `Java ${javaInfo.runtime.version}`,
    'Java runtime info should expose the generated Java version'
  );
  assertCondition(
    javaInfo.defaultImports?.includes('javafx.util.Pair') === true,
    'Java runtime info should expose the Pair default import'
  );
  assertCondition(
    Boolean(csharpInfo.runtime.version) &&
      csharpInfo.compiler?.name === 'Microsoft.CodeAnalysis.CSharp' &&
      Boolean(csharpInfo.compiler.version),
    'C# runtime info should expose generated .NET and Roslyn versions'
  );
  assertCondition(
    csharpInfo.standard?.startsWith('C# ') === true && csharpInfo.versionLabel.startsWith(csharpInfo.standard),
    'C# runtime info should expose the generated C# language version'
  );
  assertCondition(
    cppInfo.standard?.startsWith('C++') === true,
    'C++ runtime info should expose the generated C++ standard'
  );
  assertCondition(
    cppInfo.defaultImports?.includes('<regex>') === true,
    'C++ runtime info should expose default header coverage'
  );
  console.log('PASS: runtime language/profile/info registry');

  const browserHarness = createBrowserHarness();
  const pythonClient = browserHarness.getClient('python');
  const javascriptClient = browserHarness.getClient('javascript');
  const typescriptClient = browserHarness.getClient('typescript');
  const javaClient = browserHarness.getClient('java');
  const csharpClient = browserHarness.getClient('csharp');
  const cppClient = browserHarness.getClient('cpp');
  for (const [name, client] of [
    ['python', pythonClient],
    ['javascript', javascriptClient],
    ['typescript', typescriptClient],
    ['java', javaClient],
    ['csharp', csharpClient],
    ['cpp', cppClient],
  ] as const) {
    assertCondition(
      typeof (client as { getCapabilities?: unknown }).getCapabilities === 'undefined',
      `${name} client should not expose getCapabilities`
    );
    assertCondition(typeof client.init === 'function', `${name} client should implement init`);
    assertCondition(typeof client.executeCode === 'function', `${name} client should implement executeCode`);
    assertCondition(
      typeof client.executeWithTracing === 'function',
      `${name} client should implement executeWithTracing`
    );
    assertCondition(
      typeof client.executeCodeInterviewMode === 'function',
      `${name} client should implement executeCodeInterviewMode`
    );
  }
  console.log('PASS: runtime adapter surface contract');

  const pythonProfile = getLanguageRuntimeProfile('python');
  const javascriptProfile = getLanguageRuntimeProfile('javascript');
  const typescriptProfile = getLanguageRuntimeProfile('typescript');
  const javaProfile = getLanguageRuntimeProfile('java');
  const csharpProfile = getLanguageRuntimeProfile('csharp');
  const cppProfile = getLanguageRuntimeProfile('cpp');
  for (const profile of profiles) {
    const expectedMaturity = profile.language === 'java' || profile.language === 'csharp' || profile.language === 'cpp' ? 'experimental' : 'stable';
    assertCondition(
      profile.maturity === expectedMaturity,
      `${profile.language} should be marked ${expectedMaturity} in this release`
    );
    assertProfileCoverageAlignment(profile);
  }
  assertCondition(pythonProfile.capabilities.tracing.supported, 'Python should support tracing');
  assertCondition(
    pythonProfile.capabilities.execution.timeouts.runtimeTimeouts,
    'Python should advertise runtime-side timeouts'
  );
  assertCondition(
    javascriptProfile.capabilities.execution.styles.script,
    'JavaScript should support script mode execution'
  );
  assertCondition(
    javascriptProfile.capabilities.structures.listNodeRefs,
    'JavaScript should advertise linked-list ref hydration'
  );
  assertCondition(
    javascriptProfile.capabilities.project.filesystem.providerLiveInterception &&
      javascriptProfile.capabilities.project.stdio.outputEvents &&
      javascriptProfile.capabilities.project.workspace.kernelFs,
    'JavaScript should advertise live provider interception through tracekernel project I/O'
  );
  assertCondition(
    getRuntimeProjectIoSupport('javascript').tier === 'native-live' &&
      getRuntimeProjectIoSupport(pythonProfile).tier === 'native-live',
    'JavaScript and Python should expose native-live project I/O support tiers'
  );
  assertCondition(typescriptProfile.capabilities.diagnostics.compileErrors, 'TypeScript should support compile errors');
  assertCondition(
    typescriptProfile.capabilities.diagnostics.mappedErrorLines,
    'TypeScript should preserve mapped compile error lines'
  );
  assertCondition(
    !typescriptProfile.capabilities.project.workspace.supported &&
      !typescriptProfile.capabilities.project.filesystem.liveMutationEvents &&
      !typescriptProfile.capabilities.project.stdio.outputEvents,
    'TypeScript should not advertise project I/O until a TypeScript project command runner exists'
  );
  assertCondition(
    getRuntimeProjectIoSupport('typescript').tier === 'unsupported',
    'TypeScript should expose an unsupported project I/O support tier'
  );
  assertCondition(
    pythonProfile.capabilities.project.filesystem.providerLiveInterception &&
      pythonProfile.capabilities.project.filesystem.finalDiff &&
      pythonProfile.capabilities.project.stdio.deviceFiles,
    'Python should advertise Pyodide live project I/O interception plus final-diff reconciliation'
  );
  assertCondition(javaProfile.capabilities.execution.styles.function, 'Java should support function execution');
  assertCondition(javaProfile.capabilities.execution.styles.script, 'Java should support script execution');
  assertCondition(javaProfile.capabilities.execution.styles.interviewMode, 'Java should support interview mode');
  assertCondition(
    javaProfile.capabilities.project.filesystem.liveMutationEvents &&
      javaProfile.capabilities.project.filesystem.finalDiff &&
      !javaProfile.capabilities.project.filesystem.providerLiveInterception,
    'Java should advertise bridged project I/O without provider-native live interception'
  );
  assertCondition(
    getRuntimeProjectIoSupport(javaProfile).tier === 'bridged-live',
    'Java should expose a bridged-live project I/O support tier'
  );
  assertCondition(csharpProfile.capabilities.execution.styles.solutionMethod, 'C# should support solution-method execution');
  assertCondition(csharpProfile.capabilities.execution.styles.opsClass, 'C# should support ops-class execution');
  assertCondition(csharpProfile.capabilities.execution.styles.interviewMode, 'C# should support interview mode');
  assertCondition(csharpProfile.capabilities.tracing.supported, 'C# should support basic tracing');
  assertCondition(csharpProfile.capabilities.tracing.fidelity.callStack, 'C# should attach call-stack frames');
  assertCondition(csharpProfile.capabilities.diagnostics.compileErrors, 'C# should support compile diagnostics');
  assertCondition(csharpProfile.capabilities.structures.listNodeRefs, 'C# should advertise ListNode hydration');
  assertCondition(csharpProfile.capabilities.structures.treeNodeRefs, 'C# should advertise TreeNode hydration');
  assertCondition(csharpProfile.capabilities.structures.mapSerialization, 'C# should advertise map serialization');
  assertCondition(csharpProfile.capabilities.structures.setSerialization, 'C# should advertise set serialization');
  assertCondition(csharpProfile.capabilities.structures.cycleReferences, 'C# should preserve cycle references');
  assertCondition(
    csharpProfile.capabilities.project.filesystem.liveMutationEvents &&
      csharpProfile.capabilities.project.filesystem.finalDiff &&
      !csharpProfile.capabilities.project.filesystem.providerLiveInterception,
    'C# should advertise bridged project I/O without provider-native live interception'
  );
  assertCondition(
    getRuntimeProjectIoSupport(csharpProfile).tier === 'bridged-live',
    'C# should expose a bridged-live project I/O support tier'
  );
  assertCondition(cppProfile.capabilities.execution.styles.function, 'C++ should support function execution');
  assertCondition(cppProfile.capabilities.execution.styles.solutionMethod, 'C++ should support solution-method execution');
  assertCondition(cppProfile.capabilities.execution.styles.opsClass, 'C++ should support ops-class execution');
  assertCondition(cppProfile.capabilities.execution.styles.script, 'C++ should support script execution');
  assertCondition(cppProfile.capabilities.execution.styles.interviewMode, 'C++ should support interview mode');
  assertCondition(cppProfile.capabilities.tracing.supported, 'C++ should support generated-driver v4 trace events');
  assertCondition(cppProfile.capabilities.tracing.events.exception, 'C++ should support lowered exception trace events');
  assertCondition(
    cppProfile.capabilities.project.filesystem.liveMutationEvents &&
      cppProfile.capabilities.project.filesystem.finalDiff &&
      !cppProfile.capabilities.project.filesystem.providerLiveInterception,
    'C++ should advertise bridged project I/O without provider-native live interception'
  );
  assertCondition(
    getRuntimeProjectIoSupport(cppProfile).tier === 'bridged-live',
    'C++ should expose a bridged-live project I/O support tier'
  );
  console.log('PASS: runtime capability profile matrix');

  const unsupportedProfile = createUnsupportedProfile();
  expectThrows(
    () =>
      assertRuntimeRequestSupported(unsupportedProfile, {
        request: 'trace',
        executionStyle: 'function',
        functionName: 'solve',
      }),
    'does not support tracing'
  );
  expectThrows(
    () =>
      assertRuntimeRequestSupported(unsupportedProfile, {
        request: 'execute',
        executionStyle: 'solution-method',
        functionName: 'solve',
      }),
    'does not support execution style "solution-method"'
  );
  expectThrows(
    () =>
      assertRuntimeRequestSupported(unsupportedProfile, {
        request: 'execute',
        executionStyle: 'function',
        functionName: null,
      }),
    'does not support script mode execution'
  );
  expectThrows(
    () =>
      assertRuntimeRequestSupported(unsupportedProfile, {
        request: 'interview',
        executionStyle: 'function',
        functionName: 'solve',
      }),
    'does not support interview execution'
  );
  console.log('PASS: unsupported capability guards');

  const functionCase = {
    functionName: 'compute',
    inputs: { nums: [3, 1, 4], delta: 2 },
    pythonCode: `
def compute(nums, delta):
    return [n + delta for n in nums]
`,
    javascriptCode: `
function compute(nums, delta) {
  return nums.map((n) => n + delta);
}
`,
  };

  const pythonSuccess = runPythonCase(
    functionCase.pythonCode,
    functionCase.functionName,
    functionCase.inputs
  );
  assertCondition(pythonSuccess.success === true, 'Python function case should succeed');

  const pythonTypingSuccess = runPythonCase(
    `
def count_items(nums: List[int]) -> int:
    return len(nums)
`,
    'count_items',
    { nums: [1, 2, 3] }
  );
  assertCondition(pythonTypingSuccess.success === true, 'Python typing annotations should execute');
  assertCondition(pythonTypingSuccess.output === 3, 'Python typing annotation case should return expected output');

  const javascriptSuccess = await executeJavaScriptCode(
    functionCase.javascriptCode,
    functionCase.functionName,
    functionCase.inputs,
    'function'
  );
  assertCondition(javascriptSuccess.success === true, 'JavaScript function case should succeed');
  assertCondition(
    stableStringify(javascriptSuccess.output) === stableStringify(pythonSuccess.output),
    `Cross-runtime output mismatch.\npython=${stableStringify(pythonSuccess.output)}\njavascript=${stableStringify(javascriptSuccess.output)}`
  );
  console.log('PASS: cross-runtime function-style output parity');

  const typescriptSuccess = await executeTypeScriptCode(
    `
function compute(nums: number[], delta: number): number[] {
  return nums.map((n) => n + delta);
}
`,
    functionCase.functionName,
    functionCase.inputs,
    'function'
  );
  assertCondition(typescriptSuccess.success === true, 'TypeScript function case should succeed');
  assertCondition(
    stableStringify(typescriptSuccess.output) === stableStringify(pythonSuccess.output),
    `Cross-runtime output mismatch.\npython=${stableStringify(pythonSuccess.output)}\ntypescript=${stableStringify(typescriptSuccess.output)}`
  );
  console.log('PASS: cross-runtime TypeScript parity');

  const pythonError = runPythonCase('def other():\n    return 1\n', 'missing_function', {});
  const javascriptError = await executeJavaScriptCode(
    'function other() { return 1; }',
    'missing_function',
    {},
    'function'
  );
  assertCondition(pythonError.success === false, 'Python missing function case should fail');
  assertCondition(javascriptError.success === false, 'JavaScript missing function case should fail');
  assertCondition(
    typeof pythonError.error === 'string' && pythonError.error.length > 0,
    'Python missing function case should include error'
  );
  assertCondition(
    typeof javascriptError.error === 'string' && javascriptError.error.length > 0,
    'JavaScript missing function case should include error'
  );
  console.log('PASS: cross-runtime diagnostics contract');

  const opsClassCode = `
class Counter {
  constructor(start) {
    this.v = start;
  }
  inc(delta) {
    this.v += delta;
    return this.v;
  }
  get() {
    return this.v;
  }
}
`;
  const opsClassInputs = {
    operations: ['Counter', 'inc', 'inc', 'get'],
    arguments: [[1], [2], [3], []],
  };
  const jsOpsClass = await executeJavaScriptCode(
    opsClassCode,
    'Counter',
    opsClassInputs,
    'ops-class'
  );
  assertCondition(jsOpsClass.success === true, 'JavaScript ops-class case should succeed');
  assertCondition(
    stableStringify(jsOpsClass.output) === stableStringify([null, 3, 6, 6]),
    `JavaScript ops-class output mismatch: ${stableStringify(jsOpsClass.output)}`
  );
  const tsOpsClass = await executeTypeScriptCode(
    opsClassCode,
    'Counter',
    opsClassInputs,
    'ops-class'
  );
  assertCondition(tsOpsClass.success === true, 'TypeScript ops-class case should succeed');
  assertCondition(
    stableStringify(tsOpsClass.output) === stableStringify([null, 3, 6, 6]),
    `TypeScript ops-class output mismatch: ${stableStringify(tsOpsClass.output)}`
  );
  console.log('PASS: runtime execution style contract');

  const linkedListCycleRefInput = {
    head: {
      __id__: 'n0',
      val: 1,
      next: {
        __id__: 'n1',
        val: 2,
        next: {
          __ref__: 'n0',
        },
      },
    },
  };
  const linkedListCycleCode = `
class Solution {
  hasCycle(head) {
    let slow = head;
    let fast = head;
    while (fast && fast.next) {
      slow = slow.next;
      fast = fast.next.next;
      if (slow === fast) return true;
    }
    return false;
  }
}
`;

  const jsLinkedListCycle = await executeJavaScriptCode(
    linkedListCycleCode,
    'hasCycle',
    linkedListCycleRefInput,
    'solution-method'
  );
  assertCondition(jsLinkedListCycle.success === true, 'JavaScript linked-list ref cycle should execute successfully');
  assertCondition(jsLinkedListCycle.output === true, 'JavaScript linked-list ref cycle should resolve object identity');

  const tsLinkedListCycle = await executeTypeScriptCode(
    linkedListCycleCode,
    'hasCycle',
    linkedListCycleRefInput,
    'solution-method'
  );
  assertCondition(tsLinkedListCycle.success === true, 'TypeScript linked-list ref cycle should execute successfully');
  assertCondition(tsLinkedListCycle.output === true, 'TypeScript linked-list ref cycle should resolve object identity');
  console.log('PASS: runtime linked-list ref hydration contract');

  const treeAliasRefInput = {
    root: {
      __id__: 'root',
      val: 9,
      left: {
        __id__: 'child',
        val: 3,
        left: null,
        right: null,
      },
      right: {
        __ref__: 'child',
      },
    },
  };
  const treeAliasCode = `
function hasAliasedChildren(root) {
  return !!root && root.left === root.right;
}
`;
  const jsTreeAlias = await executeJavaScriptCode(
    treeAliasCode,
    'hasAliasedChildren',
    treeAliasRefInput,
    'function'
  );
  assertCondition(jsTreeAlias.success === true, 'JavaScript tree alias refs should execute successfully');
  assertCondition(jsTreeAlias.output === true, 'JavaScript tree alias refs should preserve shared identity');
  const tsTreeAlias = await executeTypeScriptCode(
    treeAliasCode,
    'hasAliasedChildren',
    treeAliasRefInput,
    'function'
  );
  assertCondition(tsTreeAlias.success === true, 'TypeScript tree alias refs should execute successfully');
  assertCondition(tsTreeAlias.output === true, 'TypeScript tree alias refs should preserve shared identity');
  console.log('PASS: runtime tree ref hydration contract');

  console.log('\nRuntime contract tests passed.');
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
