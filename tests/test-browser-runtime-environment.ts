#!/usr/bin/env npx tsx

import { test } from 'node:test';
import {
  BROWSER_RUNTIME_ASSET_PROTOCOL_VERSION,
  createBrowserRuntimeHost,
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

  const host = createBrowserRuntimeHost({
    providers: ['typescript', 'cpp'],
    engine: 'webkit',
    featureOverrides: readyFeatures,
  });
  assertCondition(host.environment.surface === 'classic', 'browser host should create a Classic environment');
  assertCondition(host.supportedLanguages.join(',') === 'typescript,cpp', 'host should expose only selected providers');
  assertCondition(!host.isLanguageSupported('python'), 'unselected source support should not imply deployment support');
  let rejectedUnselectedWarmup = false;
  try {
    await host.warmLanguage('python');
  } catch (error) {
    rejectedUnselectedWarmup =
      error instanceof Error && error.message.includes('not selected');
  }
  assertCondition(
    rejectedUnselectedWarmup,
    'host should reject lifecycle operations outside the deployment selection'
  );
  const hostCpp = await host.preflightLanguage('cpp');
  assertCondition(
    hostCpp.status === 'unavailable' &&
      hostCpp.error?.includes('Browser runtime asset preflight failed for cpp.'),
    'the default host must preflight its built-in TraceCC release before declaring C++ ready'
  );
  host.dispose();

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
  assertCondition(
    javaReadiness.configured === true,
    'Java engine assets should be configured by the bridge provider rather than public manifest roles'
  );
  assertCondition(
    javaReadiness.missingFeatures.includes('sharedArrayBuffer') &&
      javaReadiness.missingFeatures.includes('crossOriginIsolated'),
    'project Java should report its missing synchronous bridge requirements'
  );

  const csharpRoleManifest = {
    runtime: 'csharp',
    runtimeVersion: 'test-role-split',
    protocolVersion: BROWSER_RUNTIME_ASSET_PROTOCOL_VERSION,
    workerFormat: 'module',
    loaderFormat: 'module',
    assets: {
      worker: { url: '/workers/csharp-worker.js' },
      assetBaseUrl: { url: '/workers/vendor/csharp' },
      compilerAssetBaseUrl: {
        url: '/workers/vendor/csharp-compiler',
        size: 1,
      },
      runnerAssetBaseUrl: {
        url: '/workers/vendor/csharp-runner',
        size: 1,
      },
    },
  } as const;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    throw new Error('Judge role bundle unavailable');
  };
  try {
    const projectCSharp = createBrowserRuntimeEnvironment({
      providers: ['csharp'],
      surface: 'project',
      featureOverrides: readyFeatures,
      assets: { runtimeManifests: { csharp: csharpRoleManifest } },
    });
    assertCondition(
      (await projectCSharp.preflight('csharp')).status === 'ready',
      'C# project readiness must not depend on Judge-only compiler and runner bundles'
    );
    const classicCSharp = createBrowserRuntimeEnvironment({
      providers: ['csharp'],
      surface: 'classic',
      featureOverrides: readyFeatures,
      assets: { runtimeManifests: { csharp: csharpRoleManifest } },
    });
    assertCondition(
      (await classicCSharp.preflight('csharp')).status === 'unavailable',
      'C# Judge readiness must preflight its compiler and runner role bundles'
    );
    const disabledPreparedCSharp = createBrowserRuntimeEnvironment({
      providers: ['csharp'],
      surface: 'classic',
      csharpPreparedAuthority: false,
      featureOverrides: readyFeatures,
      assets: { runtimeManifests: { csharp: csharpRoleManifest } },
    });
    assertCondition(
      (await disabledPreparedCSharp.preflight('csharp')).status === 'ready',
      'disabled C# prepared authority must not preflight unused compiler and runner bundles'
    );
  } finally {
    globalThis.fetch = originalFetch;
  }

  const noCryptoCSharp = createBrowserRuntimeEnvironment({
    providers: ['csharp'],
    surface: 'classic',
    featureOverrides: { ...readyFeatures, webCrypto: false },
  });
  assertCondition(
    (await noCryptoCSharp.preflight('csharp')).missingFeatures.includes(
      'webCrypto'
    ),
    'default packed C# Judge runners must declare their Web Crypto requirement'
  );
  const disabledPreparedNoCryptoCSharp = createBrowserRuntimeEnvironment({
    providers: ['csharp'],
    surface: 'classic',
    csharpPreparedAuthority: false,
    featureOverrides: { ...readyFeatures, webCrypto: false },
  });
  assertCondition(
    (await disabledPreparedNoCryptoCSharp.preflight('csharp')).status ===
      'ready',
    'C# readiness must not require Web Crypto when prepared authority is disabled'
  );
  const disabledPreparedHost = createBrowserRuntimeHost({
    providers: ['csharp'],
    csharp: { preparedAuthority: false },
    featureOverrides: { ...readyFeatures, webCrypto: false },
  });
  assertCondition(
    disabledPreparedHost.environment.csharpPreparedAuthority === false &&
      (await disabledPreparedHost.preflightLanguage('csharp')).status ===
        'ready',
    'the public browser host must propagate disabled C# prepared authority into readiness'
  );
  disabledPreparedHost.dispose();
  const inheritedPreparedEnvironment = createBrowserRuntimeEnvironment({
    providers: ['csharp'],
    surface: 'classic',
    csharpPreparedAuthority: false,
    featureOverrides: { ...readyFeatures, webCrypto: false },
  });
  const inheritedPreparedHost = createBrowserRuntimeHost({
    environment: inheritedPreparedEnvironment,
  });
  assertCondition(
    inheritedPreparedHost.environment.csharpPreparedAuthority === false &&
      (await inheritedPreparedHost.preflightLanguage('csharp')).status ===
        'ready',
    'the public browser host must inherit prepared-authority mode from a shared environment'
  );
  inheritedPreparedHost.dispose();
  const legacyNoCryptoCSharp = createBrowserRuntimeEnvironment({
    providers: ['csharp'],
    surface: 'classic',
    featureOverrides: { ...readyFeatures, webCrypto: false },
    assets: {
      runtimeManifests: {
        csharp: {
          runtime: 'csharp',
          runtimeVersion: 'legacy-general',
          protocolVersion: BROWSER_RUNTIME_ASSET_PROTOCOL_VERSION,
          workerFormat: 'module',
          loaderFormat: 'module',
          assets: {
            worker: { url: '/legacy/csharp-worker.js' },
            assetBaseUrl: { url: '/legacy/csharp' },
          },
        },
      },
    },
  });
  assertCondition(
    (await legacyNoCryptoCSharp.preflight('csharp')).status === 'ready',
    'legacy unpacked C# manifests must not inherit the packed-runner Web Crypto requirement'
  );

  let rejectedEmpty = false;
  try {
    createBrowserRuntimeEnvironment({ providers: [] });
  } catch (error) {
    rejectedEmpty = error instanceof Error && error.message.includes('at least one provider');
  }
  assertCondition(rejectedEmpty, 'runtime environments should reject empty provider selections');

  const navigatorDescriptor = Object.getOwnPropertyDescriptor(
    globalThis,
    'navigator'
  );
  try {
    const engineCases = [
      {
        expected: 'webkit',
        label: 'Chrome on iOS',
        userAgent:
          'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) ' +
          'AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/123.0.6312.52 ' +
          'Mobile/15E148 Safari/604.1',
      },
      {
        expected: 'chromium',
        label: 'desktop Chrome',
        userAgent:
          'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) ' +
          'AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36',
      },
    ] as const;
    for (const engineCase of engineCases) {
      Object.defineProperty(globalThis, 'navigator', {
        configurable: true,
        value: { userAgent: engineCase.userAgent },
      });
      const detected = createBrowserRuntimeEnvironment({
        providers: ['python'],
        featureOverrides: readyFeatures,
      });
      assertCondition(
        detected.engine === engineCase.expected,
        `${engineCase.label} should select ${engineCase.expected}, received ${detected.engine}`
      );
    }
  } finally {
    if (navigatorDescriptor) {
      Object.defineProperty(globalThis, 'navigator', navigatorDescriptor);
    } else {
      delete (globalThis as { navigator?: unknown }).navigator;
    }
  }

  console.log('PASS: browser runtime environment reports configured, engine-aware provider readiness');
}

test('browser runtime environment', main);
