#!/usr/bin/env npx tsx

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import vm from 'node:vm';

const GLOBAL_CAPABILITIES = [
  'fetch',
  'XMLHttpRequest',
  'WebSocket',
  'WebSocketStream',
  'EventSource',
  'WebTransport',
  'RTCPeerConnection',
  'webkitRTCPeerConnection',
  'RTCDataChannel',
  'indexedDB',
  'caches',
  'Cache',
  'CacheStorage',
  'cookieStore',
  'webkitRequestFileSystem',
  'webkitRequestFileSystemSync',
  'webkitResolveLocalFileSystemURL',
  'webkitResolveLocalFileSystemSyncURL',
  'Worker',
  'SharedWorker',
  'BroadcastChannel',
  'importScripts',
] as const;

const NAVIGATOR_CAPABILITIES = ['sendBeacon', 'storage', 'locks', 'serviceWorker'] as const;

function assertCondition(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

interface LockdownHarness {
  attempted: string[];
  context: vm.Context;
  originalGlobals: Map<string, unknown>;
  originalNavigator: Map<string, unknown>;
  protocolCalls: string[];
  selfObject: Record<string, unknown>;
}

function createLockdownHarness(): LockdownHarness {
  const attempted: string[] = [];
  const protocolCalls: string[] = [];
  const selfObject: Record<string, unknown> = {};
  const navigatorObject: Record<string, unknown> = {};
  const originalGlobals = new Map<string, unknown>();
  const originalNavigator = new Map<string, unknown>();

  for (const name of GLOBAL_CAPABILITIES) {
    const capability = Object.assign(
      function nativeCapability() {
        attempted.push(name);
      },
      { open: () => attempted.push(`${name}.open`) }
    );
    selfObject[name] = capability;
    originalGlobals.set(name, capability);
  }
  for (const name of NAVIGATOR_CAPABILITIES) {
    const capability = Object.assign(
      function nativeNavigatorCapability() {
        attempted.push(`navigator.${name}`);
      },
      { open: () => attempted.push(`navigator.${name}.open`) }
    );
    navigatorObject[name] = capability;
    originalNavigator.set(name, capability);
  }
  selfObject.navigator = navigatorObject;
  selfObject.postMessage = (value: string) => protocolCalls.push(`post:${value}`);
  selfObject.traceKernelDispatch = () => {
    protocolCalls.push('http:dispatch');
    return { status: 204 };
  };

  const context = vm.createContext({
    self: selfObject,
    console,
  });
  const source = readFileSync(
    join(process.cwd(), 'workers/shared/runtime-kernel-policy-classic.js'),
    'utf8'
  );
  vm.runInContext(source, context, { filename: 'runtime-kernel-policy-classic.js' });
  return {
    attempted,
    context,
    originalGlobals,
    originalNavigator,
    protocolCalls,
    selfObject,
  };
}

function assertRestored(harness: LockdownHarness, label: string): void {
  for (const [name, value] of harness.originalGlobals) {
    assertCondition(harness.selfObject[name] === value, `${label}: global ${name} was not restored`);
  }
  const navigatorObject = harness.selfObject.navigator as Record<string, unknown>;
  for (const [name, value] of harness.originalNavigator) {
    assertCondition(navigatorObject[name] === value, `${label}: navigator.${name} was not restored`);
  }
}

async function runAuthorityProbe(harness: LockdownHarness, label: string): Promise<void> {
  const result = await vm.runInContext(
    `(async () => {
      const trustedPost = self.postMessage.bind(self);
      const trustedHttp = self.traceKernelDispatch.bind(self);
      return self.TraceRuntimeKernelPolicy.withRuntimeUserAuthorityLockdown(async () => {
      const denied = [];
      for (const name of ${JSON.stringify(GLOBAL_CAPABILITIES)}) {
        try { self[name](); denied.push(name + ':allowed'); }
        catch (error) { denied.push(name + ':' + (error.code || error.name)); }
      }
      for (const name of ${JSON.stringify(NAVIGATOR_CAPABILITIES)}) {
        try { self.navigator[name](); denied.push('navigator.' + name + ':allowed'); }
        catch (error) { denied.push('navigator.' + name + ':' + (error.code || error.name)); }
      }
      try { Object.defineProperty(self, 'fetch', { configurable: true, value: () => 'bypass' }); }
      catch (error) { denied.push('defineProperty:' + (error.code || error.name)); }
      try { Reflect.deleteProperty(self, 'fetch'); }
      catch (error) { denied.push('deleteProperty:' + (error.code || error.name)); }
      try { Object.setPrototypeOf(self, {}); }
      catch (error) { denied.push('setPrototypeOf:' + (error.code || error.name)); }
      denied.push('reflectSet:' + Reflect.set(self, 'fetch', () => 'bypass'));
      try { self.fetch(); denied.push('postMutation:allowed'); }
      catch (error) { denied.push('postMutation:' + (error.code || error.name)); }
      trustedPost('still-live');
      denied.push('http:' + trustedHttp().status);
      await Promise.resolve();
      return denied;
    });
    })()`,
    harness.context
  ) as string[];

  const expectedDenied = [
    ...GLOBAL_CAPABILITIES.map((name) => `${name}:EACCES`),
    ...NAVIGATOR_CAPABILITIES.map((name) => `navigator.${name}:EACCES`),
    'defineProperty:EACCES',
    'deleteProperty:EACCES',
    'setPrototypeOf:EACCES',
    'reflectSet:false',
    'postMutation:EACCES',
    'http:204',
  ];
  assertCondition(
    JSON.stringify(result) === JSON.stringify(expectedDenied),
    `${label}: authority result mismatch\n${JSON.stringify(result, null, 2)}`
  );
  assertCondition(harness.attempted.length === 0, `${label}: invoked native authority: ${harness.attempted.join(', ')}`);
  assertCondition(
    harness.protocolCalls.join(',') === 'post:still-live,http:dispatch',
    `${label}: captured protocol/TraceKernel controls failed: ${harness.protocolCalls.join(',')}`
  );
  assertRestored(harness, label);
}

async function testAuthorityIsDeniedAndReusableStateRestores(): Promise<void> {
  const harness = createLockdownHarness();
  const bindingDescriptor = Object.getOwnPropertyDescriptor(harness.selfObject, 'TraceRuntimeKernelPolicy');
  assertCondition(
    bindingDescriptor?.configurable === false && bindingDescriptor.writable === false && Object.isFrozen(bindingDescriptor.value),
    'Classic worker policy binding must be frozen, non-writable, and non-configurable'
  );
  const poisoning = vm.runInContext(
    `(() => {
      const trusted = self.TraceRuntimeKernelPolicy;
      try { self.TraceRuntimeKernelPolicy = { poisoned: true }; } catch {}
      const deleted = Reflect.deleteProperty(self, 'TraceRuntimeKernelPolicy');
      let redefined = true;
      try { Object.defineProperty(self, 'TraceRuntimeKernelPolicy', { value: { poisoned: true } }); }
      catch { redefined = false; }
      return [self.TraceRuntimeKernelPolicy === trusted, deleted, redefined];
    })()`,
    harness.context
  ) as [boolean, boolean, boolean];
  assertCondition(
    JSON.stringify(poisoning) === '[true,false,false]',
    `Classic worker policy binding was poisonable: ${JSON.stringify(poisoning)}`
  );
  await runAuthorityProbe(harness, 'first execution');
  harness.protocolCalls.length = 0;
  await runAuthorityProbe(harness, 'reused execution');

  let callbackError = '';
  try {
    await vm.runInContext(
      `self.TraceRuntimeKernelPolicy.withRuntimeUserAuthorityLockdown(() => { throw new Error('user-failure'); })`,
      harness.context
    );
  } catch (error) {
    callbackError = error instanceof Error ? error.message : String(error);
  }
  assertCondition(callbackError.endsWith('user-failure'), `User exception changed under lockdown: ${callbackError}`);
  assertRestored(harness, 'failed execution');
  console.log('PASS: ambient worker authority is denied and reusable worker descriptors restore');
}

async function testNestedLockdownDoesNotRestoreEarly(): Promise<void> {
  const harness = createLockdownHarness();
  const result = await vm.runInContext(
    `(async () => self.TraceRuntimeKernelPolicy.withRuntimeUserAuthorityLockdown(async () => {
      const nested = await self.TraceRuntimeKernelPolicy.withRuntimeUserAuthorityLockdown(() => {
        try { self.fetch(); return 'allowed'; }
        catch (error) { return error.code; }
      });
      let afterNested;
      try { self.fetch(); afterNested = 'allowed'; }
      catch (error) { afterNested = error.code; }
      return [nested, afterNested];
    }))()`,
    harness.context
  ) as string[];
  assertCondition(JSON.stringify(result) === '["EACCES","EACCES"]', `Nested lockdown restored early: ${result}`);
  assertRestored(harness, 'nested execution');
  console.log('PASS: nested authority lockdown retains the outer execution boundary');
}

async function testCapabilityLimitedAuthorityOverride(): Promise<void> {
  const harness = createLockdownHarness();
  const result = await vm.runInContext(
    `(async () => self.TraceRuntimeKernelPolicy.withRuntimeUserAuthorityLockdown(() => {
      const fetchResult = self.fetch('allowed-runtime-asset');
      let websocketResult;
      try { self.WebSocket(); websocketResult = 'allowed'; }
      catch (error) { websocketResult = error.code; }
      let mutationResult;
      try {
        Object.defineProperty(self, 'fetch', { configurable: true, value: () => 'bypass' });
        mutationResult = 'allowed';
      } catch (error) {
        mutationResult = error.code;
      }
      return [fetchResult, websocketResult, mutationResult];
    }, {
      authorityOverrides: {
        fetch: (value) => 'guarded:' + value,
      },
    }))()`,
    harness.context
  ) as string[];
  assertCondition(
    JSON.stringify(result) === '["guarded:allowed-runtime-asset","EACCES","EACCES"]',
    `Capability override widened authority unexpectedly: ${JSON.stringify(result)}`
  );
  assertCondition(harness.attempted.length === 0, 'Capability override invoked the original ambient fetch');
  assertRestored(harness, 'capability override');
  console.log('PASS: authority lockdown supports a guarded runtime capability without widening ambient authority');
}

async function testPolicyBindingResistsCrossCommandPoisoning(): Promise<void> {
  const harness = createLockdownHarness();
  const poisonResult = await vm.runInContext(
    `(async () => self.TraceRuntimeKernelPolicy.withRuntimeUserAuthorityLockdown(() => {
      'use strict';
      const deleted = Reflect.deleteProperty(self, 'TraceRuntimeKernelPolicy');
      let replaced;
      try {
        Object.defineProperty(self, 'TraceRuntimeKernelPolicy', { value: Object.freeze({}) });
        replaced = 'allowed';
      } catch (error) {
        replaced = error.name;
      }
      let assigned;
      try {
        self.TraceRuntimeKernelPolicy = Object.freeze({});
        assigned = 'allowed';
      } catch (error) {
        assigned = error.name;
      }
      return [deleted, replaced, assigned];
    }))()`,
    harness.context
  ) as [boolean, string, string];
  assertCondition(
    JSON.stringify(poisonResult) === '[false,"TypeError","TypeError"]',
    `User execution could poison the shared policy binding: ${JSON.stringify(poisonResult)}`
  );
  await runAuthorityProbe(harness, 'post-policy-poison execution');
  console.log('PASS: immutable shared policy binding guards subsequent commands after poisoning attempts');
}

async function testInstallationFailureIsFailClosed(): Promise<void> {
  const source = readFileSync(
    join(process.cwd(), 'workers/shared/runtime-kernel-policy-classic.js'),
    'utf8'
  );
  const selfObject: Record<string, unknown> = {};
  Object.defineProperty(selfObject, 'fetch', {
    configurable: false,
    enumerable: true,
    writable: false,
    value: () => 'native',
  });
  const context = vm.createContext({ self: selfObject, console });
  vm.runInContext(source, context, { filename: 'runtime-kernel-policy-classic.js' });
  let callbackRan = false;
  let rejected = false;
  try {
    await (selfObject as Record<string, any>).TraceRuntimeKernelPolicy.withRuntimeUserAuthorityLockdown(
      () => {
        callbackRan = true;
      }
    );
  } catch {
    rejected = true;
  }
  assertCondition(rejected && !callbackRan, 'Lockdown installation failure must reject before user code executes');
  assertCondition(selfObject.fetch instanceof Function, 'Partial lockdown was not restored');
  console.log('PASS: authority lockdown installation fails closed before user execution');
}

async function testPermanentLockdownSealsPrototypeAndDeferredEscapes(): Promise<void> {
  const harness = createLockdownHarness();
  const workerGlobalPrototype = Object.create(Object.getPrototypeOf(harness.selfObject)) as Record<string, unknown>;
  const nativePrototypeFetch = () => {
    harness.attempted.push('prototype.fetch');
    return 'native-fetch';
  };
  const nativePrototypeTimeout = (callback: () => void) => {
    return setTimeout(callback, 0);
  };
  Object.defineProperty(workerGlobalPrototype, 'fetch', {
    configurable: true,
    enumerable: true,
    writable: true,
    value: nativePrototypeFetch,
  });
  Object.defineProperty(workerGlobalPrototype, 'setTimeout', {
    configurable: true,
    enumerable: true,
    writable: true,
    value: nativePrototypeTimeout,
  });
  for (const name of [
    'webkitRequestFileSystem',
    'webkitRequestFileSystemSync',
    'webkitResolveLocalFileSystemURL',
    'webkitResolveLocalFileSystemSyncURL',
  ]) {
    Object.defineProperty(workerGlobalPrototype, name, {
      configurable: true,
      enumerable: true,
      writable: true,
      value: () => harness.attempted.push(`prototype.${name}`),
    });
  }
  Object.setPrototypeOf(harness.selfObject, workerGlobalPrototype);

  const result = await vm.runInContext(
    `(async () => {
      const trustedPost = self.postMessage.bind(self);
      const trustedHttp = self.traceKernelDispatch.bind(self);
      return self.TraceRuntimeKernelPolicy.withRuntimeUserAuthorityLockdown(async () => {
        const outcomes = [];
        const key = 'con' + 'structor';
        try {
          const escapedScope = ({})[key][key]('return self')();
          escapedScope.fetch('https://computed.invalid/');
          outcomes.push('computed:allowed');
        }
        catch (error) { outcomes.push('computed:' + (error.code || error.name)); }
        try {
          let cursor = Object.getPrototypeOf(self);
          let descriptor;
          while (cursor && !descriptor) {
            descriptor = Object.getOwnPropertyDescriptor(cursor, 'fetch');
            cursor = Object.getPrototypeOf(cursor);
          }
          descriptor.value.call(self, 'https://escape.invalid/');
          outcomes.push('descriptor:allowed');
        } catch (error) { outcomes.push('descriptor:' + (error.code || error.name)); }
        try {
          let cursor = Object.getPrototypeOf(self);
          let descriptor;
          while (cursor && !descriptor) {
            descriptor = Object.getOwnPropertyDescriptor(cursor, 'webkitRequestFileSystemSync');
            cursor = Object.getPrototypeOf(cursor);
          }
          descriptor.value.call(self, 0, 1024);
          outcomes.push('legacy-fs:allowed');
        } catch (error) { outcomes.push('legacy-fs:' + (error.code || error.name)); }
        try {
          let cursor = Object.getPrototypeOf(self);
          let descriptor;
          while (cursor && !descriptor) {
            descriptor = Object.getOwnPropertyDescriptor(cursor, 'setTimeout');
            cursor = Object.getPrototypeOf(cursor);
          }
          self.__deferredAuthorityOutcome = 'pending';
          descriptor.value(() => {
            try { self.fetch('https://deferred.invalid/'); self.__deferredAuthorityOutcome = 'allowed'; }
            catch (error) { self.__deferredAuthorityOutcome = error.code || error.name; }
          }, 0);
          outcomes.push('deferred:scheduled');
        } catch (error) { outcomes.push('deferred:' + (error.code || error.name)); }
        trustedPost('still-live');
        outcomes.push('http:' + trustedHttp().status);
        return outcomes;
      }, { scope: self, mode: 'permanent' });
    })()`,
    harness.context
  ) as string[];

  assertCondition(
    JSON.stringify(result) === JSON.stringify([
      'computed:EACCES',
      'descriptor:EACCES',
      'legacy-fs:EACCES',
      'deferred:scheduled',
      'http:204',
    ]),
    `Permanent authority result mismatch: ${JSON.stringify(result)}`
  );
  assertCondition(harness.attempted.length === 0, `Permanent lockdown invoked native authority: ${harness.attempted}`);
  await new Promise((resolve) => setTimeout(resolve, 10));
  assertCondition(
    harness.selfObject.__deferredAuthorityOutcome === 'EACCES',
    `Deferred task regained authority after callback settlement: ${String(harness.selfObject.__deferredAuthorityOutcome)}`
  );
  assertCondition(
    harness.protocolCalls.join(',') === 'post:still-live,http:dispatch',
    `Captured protocol capabilities failed after permanent sealing: ${harness.protocolCalls}`
  );
  const prototypeFetchDescriptor = Object.getOwnPropertyDescriptor(workerGlobalPrototype, 'fetch');
  assertCondition(
    prototypeFetchDescriptor?.configurable === false && prototypeFetchDescriptor.value !== nativePrototypeFetch,
    'Permanent lockdown must replace and seal the live WorkerGlobalScope prototype descriptor'
  );
  const postBoundaryResult = vm.runInContext(
    `(() => {
      try { self.fetch('https://after.invalid/'); return 'allowed'; }
      catch (error) { return error.code || error.name; }
    })()`,
    harness.context
  );
  assertCondition(postBoundaryResult === 'EACCES', 'Permanent lockdown restored authority after the callback settled');
  console.log('PASS: permanent authority lockdown seals computed, prototype, and deferred escapes');
}

function testLanguageWorkerIntegrationAndCppBoundary(): void {
  const pythonSource = readFileSync(join(process.cwd(), 'workers/python/pyodide-worker.js'), 'utf8');
  const javaSource = readFileSync(join(process.cwd(), 'workers/java/java-worker.js'), 'utf8');
  const csharpSource = readFileSync(join(process.cwd(), 'workers/csharp/csharp-worker.js'), 'utf8');
  const cppSource = readFileSync(join(process.cwd(), 'workers/cpp/cpp-worker.js'), 'utf8');
  assertCondition(
    pythonSource.includes('function withPythonUserAuthorityLockdown') &&
      pythonSource.includes('let trustedPythonUserAuthorityLockdown = null;') &&
      pythonSource.includes('trustedPythonUserAuthorityLockdown = lockdown;') &&
      pythonSource.includes('return trustedPythonUserAuthorityLockdown(callback, { scope: self, mode });') &&
      pythonSource.includes("throw new Error('Python user execution requires the shared runtime authority lockdown policy.')") &&
      pythonSource.includes('const runtimeCore = loadPyodideRuntimeCore();\n  return withPythonUserAuthorityLockdown(() =>\n    runtimeCore.executeWithTracing') &&
      pythonSource.includes('const runtimeCore = loadPyodideRuntimeCore();\n  return withPythonUserAuthorityLockdown(() =>\n    runtimeCore.executeCode(') &&
      pythonSource.includes('const runtimeCore = loadPyodideRuntimeCore();\n  return withPythonUserAuthorityLockdown(() =>\n    runtimeCore.executeCodeBatch') &&
      /return withPythonUserAuthorityLockdown\(\s*\(\) => executeProjectPythonUserCall/.test(pythonSource),
    'Python worker must warm trusted assets before fail-closed standalone, batch, and project user execution'
  );
  assertCondition(
    javaSource.includes('withJavaUserAuthorityLockdown') &&
      javaSource.includes('const trustedJavaUserAuthorityLockdown') &&
      javaSource.includes('await warmRunHost();') &&
      javaSource.includes('await withJavaUserAuthorityLockdown'),
    'Java worker must warm trusted assets before wrapping each user request'
  );
  assertCondition(
    csharpSource.includes('withCSharpUserAuthorityLockdown') &&
      csharpSource.includes('trustedRuntimeUserAuthorityLockdown = lockdown') &&
      csharpSource.includes('await withCSharpUserAuthorityLockdown'),
    'C# standalone and project execution must use the shared authority boundary'
  );
  assertCondition(
    cppSource.includes("item.module === 'wasi_snapshot_preview1'") &&
      cppSource.includes("item.module === 'tracecode_kernel'") &&
      cppSource.includes('imports[item.module][item.name] = () => ENOTSUP'),
    'C++ user Wasm imports must remain limited to WASI/TraceKernel and fail-closed stubs'
  );
  console.log('PASS: Python/Java/C# execution uses lockdown; C++ user Wasm has no ambient JS import authority');
}

async function main(): Promise<void> {
  await testAuthorityIsDeniedAndReusableStateRestores();
  await testNestedLockdownDoesNotRestoreEarly();
  await testCapabilityLimitedAuthorityOverride();
  await testPolicyBindingResistsCrossCommandPoisoning();
  await testInstallationFailureIsFailClosed();
  await testPermanentLockdownSealsPrototypeAndDeferredEscapes();
  testLanguageWorkerIntegrationAndCppBoundary();
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
