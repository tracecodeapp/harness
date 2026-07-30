#!/usr/bin/env npx tsx

import { test } from 'node:test';
import {
  createBrowserHarness,
  createBrowserRuntimeEnvironment,
} from '../src/browser';

function assertCondition(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

async function main(): Promise<void> {
  const readyFeatures = {
    worker: true,
    webAssembly: true,
    webCrypto: true,
    sharedArrayBuffer: true,
    crossOriginIsolated: true,
  } as const;
  const selected = createBrowserRuntimeEnvironment({
    providers: ['typescript', 'cpp'],
    engine: 'webkit',
    surface: 'project',
    featureOverrides: readyFeatures,
  });
  const report = await selected.preflightAll();
  const typescript = report.runtimes.find((runtime) => runtime.language === 'typescript');
  const cpp = report.runtimes.find((runtime) => runtime.language === 'cpp');
  const java = report.runtimes.find((runtime) => runtime.language === 'java');
  assertCondition(typescript?.status === 'ready', 'selected TypeScript project provider should report ready');
  assertCondition(cpp?.status === 'degraded', 'WebKit C++ should expose its measured compatibility caveat');
  assertCondition(
    cpp.knownIssues.some((issue) => issue.id === 'webkit-cpp-wasm-null-reference'),
    'WebKit C++ readiness should provide an actionable issue id'
  );
  assertCondition(java?.selected === false && java.status === 'unavailable', 'unselected providers should report unavailable');
  assertCondition(selected.providers.join(',') === 'typescript,cpp', 'provider selection should retain stable order');

  const harness = createBrowserHarness({
    providers: ['typescript', 'cpp'],
    engine: 'webkit',
    featureOverrides: readyFeatures,
  });
  assertCondition(harness.environment.surface === 'classic', 'browser harness should create a Classic environment');
  assertCondition(harness.supportedLanguages.join(',') === 'typescript,cpp', 'harness should expose only selected providers');
  assertCondition(harness.getSupportedLanguageInfos().length === 2, 'language info should follow deployment selection');
  assertCondition(harness.getSupportedLanguageProfiles().length === 2, 'profiles should follow deployment selection');
  assertCondition(!harness.isLanguageSupported('python'), 'unselected source support should not imply deployment support');
  let rejectedUnselectedClient = false;
  try {
    harness.getClient('python');
  } catch (error) {
    rejectedUnselectedClient = error instanceof Error && error.message.includes('not selected');
  }
  assertCondition(rejectedUnselectedClient, 'harness should reject clients outside the deployment selection');
  const harnessCpp = await harness.preflightLanguage('cpp');
  assertCondition(harnessCpp.status === 'degraded', 'harness should expose engine-aware readiness');
  harness.dispose();

  const projectJava = createBrowserRuntimeEnvironment({
    providers: ['java'],
    engine: 'chromium',
    surface: 'project',
    featureOverrides: {
      ...readyFeatures,
      sharedArrayBuffer: false,
      crossOriginIsolated: false,
    },
  });
  const javaReadiness = await projectJava.preflight('java');
  assertCondition(javaReadiness.configured === false, 'Java should require a complete consumer runtime manifest');
  assertCondition(
    javaReadiness.missingFeatures.includes('sharedArrayBuffer') &&
      javaReadiness.missingFeatures.includes('crossOriginIsolated'),
    'project Java should report its missing synchronous bridge requirements'
  );

  let rejectedEmpty = false;
  try {
    createBrowserRuntimeEnvironment({ providers: [] });
  } catch (error) {
    rejectedEmpty = error instanceof Error && error.message.includes('at least one provider');
  }
  assertCondition(rejectedEmpty, 'runtime environments should reject empty provider selections');
  console.log('PASS: browser runtime environment reports configured, engine-aware provider readiness');
}

test('browser runtime environment', main);
