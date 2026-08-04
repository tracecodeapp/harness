#!/usr/bin/env npx tsx

import { test } from 'node:test';
import { createServer } from 'node:http';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { extname, join, normalize, sep } from 'node:path';
import { chromium } from 'playwright';

const ROOT = process.cwd();

interface ExecuteResult {
  success: boolean;
  output?: unknown;
  error?: string;
  events?: Array<{ kind?: string; line?: number }>;
  compiledArtifactKey?: string;
  compiledArtifactBase64?: string;
  compiledArtifactSha256?: string;
  timings?: {
    compileCacheHit?: boolean;
    hostArtifactCacheHit?: boolean;
    artifactCacheHit?: boolean;
    compileMs?: number;
    compileCacheEntries?: number;
    compileCacheBytes?: number;
    compileArtifactBytes?: number;
    executionRealm?: string;
    totalMs?: number;
  };
}

interface ProjectExecuteResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

function assertCondition(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function contentType(pathname: string): string {
  switch (extname(pathname)) {
    case '.html':
      return 'text/html; charset=utf-8';
    case '.js':
    case '.mjs':
      return 'text/javascript; charset=utf-8';
    case '.json':
      return 'application/json; charset=utf-8';
    case '.wasm':
      return 'application/wasm';
    default:
      return 'application/octet-stream';
  }
}

async function main(): Promise<void> {
  assertCondition(
    existsSync(join(ROOT, 'workers', 'vendor', 'csharp', '_framework', 'dotnet.js')),
    'Expected the vendored C# runtime; run pnpm update:csharp-runtime first.'
  );

  const server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    const candidate = normalize(join(ROOT, decodeURIComponent(url.pathname)));
    if (candidate !== ROOT && !candidate.startsWith(`${ROOT}${sep}`)) {
      response.writeHead(403).end('Forbidden');
      return;
    }
    const file = statSync(candidate, { throwIfNoEntry: false })?.isDirectory()
      ? join(candidate, 'index.html')
      : candidate;
    if (!existsSync(file)) {
      response.writeHead(404).end('Not found');
      return;
    }
    response.writeHead(200, {
      'Content-Type': contentType(file),
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'require-corp',
    });
    response.end(readFileSync(file));
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  assertCondition(address && typeof address !== 'string', 'Expected a TCP server address.');
  const origin = `http://127.0.0.1:${address.port}`;

  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.goto(`${origin}/tests/fixtures/csharp-worker/blank.html`);
    await page.evaluate('globalThis.__name = (fn) => fn');
    const metrics = await page.evaluate(async ({ origin }) => {
      const assetBaseUrl = `${origin}/workers/vendor/csharp`;
      const compilerArtifacts = new Map<string, string>();

      async function createWorkerHarness() {
        const worker = new Worker('/workers/csharp/csharp-worker.js', { type: 'module' });
        let nextId = 0;
        const pending = new Map<string, {
          resolve(value: unknown): void;
          reject(error: Error): void;
          protocolToken: string;
        }>();
        worker.addEventListener('message', (event) => {
          if (event.data?.type === 'compiler-artifact-cache-request') {
            const request = event.data?.payload ?? {};
            if (request.operation === 'put' && typeof request.key === 'string' && typeof request.value === 'string') {
              compilerArtifacts.set(request.key, request.value);
            }
            const value = request.operation === 'get' && typeof request.key === 'string'
              ? compilerArtifacts.get(request.key)
              : undefined;
            worker.postMessage({
              type: 'compiler-artifact-cache-response',
              requestId: event.data.requestId,
              protocolToken: event.data.protocolToken,
              payload: {
                hit: value !== undefined,
                ...(value === undefined ? {} : { value }),
                stored: request.operation === 'put' && compilerArtifacts.has(request.key),
              },
            });
            return;
          }
          const id = event.data?.id;
          if (!id) return;
          const request = pending.get(id);
          if (!request || event.data?.protocolToken !== request.protocolToken) return;
          if (event.data?.type === 'project-event') return;
          pending.delete(id);
          if (event.data?.type === 'error') {
            request.reject(new Error(event.data?.payload?.error ?? 'C# worker error'));
          } else {
            request.resolve(event.data?.payload);
          }
        });
        worker.addEventListener('error', (event) => {
          const error = new Error(event.message || 'C# worker failed');
          for (const request of pending.values()) request.reject(error);
          pending.clear();
        });
        function send<T = ExecuteResult>(type: string, payload: unknown): Promise<T> {
          const id = String(++nextId);
          const protocolToken = `csharp-lifecycle-${id}-${crypto.randomUUID()}`;
          return new Promise<T>((resolve, reject) => {
            pending.set(id, { resolve, reject, protocolToken });
            worker.postMessage({ id, type, payload, protocolToken });
          });
        }
        function terminate(reason = new Error('C# test worker terminated')): void {
          worker.terminate();
          for (const request of pending.values()) request.reject(reason);
          pending.clear();
        }
        await send('init', { assetBaseUrl });
        return { send, terminate };
      }

      const source = [
        'public class Solution {',
        '  private static int seen;',
        '  public int Touch(int value) {',
        '    seen += 1;',
        '    return seen * 100 + value;',
        '  }',
        '}',
      ].join('\n');
      const editedSource = source.replace('seen * 100 + value', 'seen * 1000 + value');
      const request = (code: string, value: number) => ({
        code,
        functionName: 'Touch',
        inputs: { value },
        executionStyle: 'solution-method',
        assetBaseUrl,
        timeoutMs: 10_000,
      });

      const firstWorker = await createWorkerHarness();
      const cold = await firstWorker.send('execute-code', request(source, 7));
      const warm = await firstWorker.send('execute-code', request(source, 9));
      const edited = await firstWorker.send('execute-code', request(editedSource, 3));
      const cacheIntegritySource = source.replace(
        'seen * 100 + value',
        'seen * 10 + value'
      );
      const cacheIntegritySeed = await firstWorker.send(
        'execute-code',
        request(cacheIntegritySource, 5)
      );
      const cacheIntegrityKey = cacheIntegritySeed.compiledArtifactKey ?? '';
      const cacheIntegrityValue = compilerArtifacts.get(cacheIntegrityKey);
      if (cacheIntegrityValue) {
        const corruptedEnvelope = JSON.parse(cacheIntegrityValue);
        corruptedEnvelope.sha256 = '0'.repeat(64);
        compilerArtifacts.set(
          cacheIntegrityKey,
          JSON.stringify(corruptedEnvelope)
        );
      }
      const cacheIntegrityWorker = await createWorkerHarness();
      const cacheIntegrityRestored = await cacheIntegrityWorker.send(
        'execute-code',
        request(cacheIntegritySource, 6)
      );
      cacheIntegrityWorker.terminate();

      const prepared = await firstWorker.send<ExecuteResult>('prepare-program', {
        mode: 'code',
        code: source,
        functionName: 'Touch',
        executionStyle: 'solution-method',
        assetBaseUrl,
        timeoutMs: 10_000,
      });
      const preparedProgram = {
        mode: 'code',
        code: source,
        functionName: 'Touch',
        executionStyle: 'solution-method',
        compiledArtifactKey: prepared.compiledArtifactKey,
        compiledArtifactBase64: prepared.compiledArtifactBase64,
        compiledArtifactSha256: prepared.compiledArtifactSha256,
      };
      const preparedFirst = await firstWorker.send('execute-prepared-code', {
        prepared: preparedProgram,
        inputs: { value: 13 },
        assetBaseUrl,
        timeoutMs: 10_000,
      });
      const preparedSecond = await firstWorker.send('execute-prepared-code', {
        prepared: preparedProgram,
        inputs: { value: 17 },
        assetBaseUrl,
        timeoutMs: 10_000,
      });
      const tamperedArtifactBytes = Uint8Array.from(
        atob(prepared.compiledArtifactBase64 ?? ''),
        (character) => character.charCodeAt(0)
      );
      tamperedArtifactBytes[tamperedArtifactBytes.length - 1] ^= 1;
      const tamperedPrepared = await firstWorker.send('execute-prepared-code', {
        prepared: {
          ...preparedProgram,
          compiledArtifactBase64: btoa(
            String.fromCharCode(...tamperedArtifactBytes)
          ),
        },
        inputs: { value: 17 },
        assetBaseUrl,
        timeoutMs: 10_000,
      });

      const scriptSource = [
        'int result = TraceCode.Internal.TraceCodeJsonInput.Read<int>("value", 0);',
      ].join('\n');
      const scriptPreparation = await firstWorker.send<ExecuteResult>('prepare-program', {
        mode: 'code',
        code: scriptSource,
        functionName: '',
        executionStyle: 'function',
        assetBaseUrl,
        timeoutMs: 10_000,
      });
      const preparedScript = {
        mode: 'code',
        code: scriptSource,
        functionName: '',
        executionStyle: 'function',
        compiledArtifactKey: scriptPreparation.compiledArtifactKey,
        compiledArtifactBase64: scriptPreparation.compiledArtifactBase64,
        compiledArtifactSha256: scriptPreparation.compiledArtifactSha256,
      };
      const preparedScriptFirst = await firstWorker.send('execute-prepared-code', {
        prepared: preparedScript,
        inputs: { value: 37 },
        assetBaseUrl,
        timeoutMs: 10_000,
      });
      const preparedScriptSecond = await firstWorker.send('execute-prepared-code', {
        prepared: preparedScript,
        inputs: { value: 41 },
        assetBaseUrl,
        timeoutMs: 10_000,
      });

      const opsSource = [
        'public class Counter {',
        '  private int value;',
        '  public Counter(int start) { value = start; }',
        '  public int Add(int delta) { value += delta; return value; }',
        '}',
      ].join('\n');
      const opsPreparation = await firstWorker.send<ExecuteResult>('prepare-program', {
        mode: 'code',
        code: opsSource,
        functionName: 'Counter',
        executionStyle: 'ops-class',
        assetBaseUrl,
        timeoutMs: 10_000,
      });
      const preparedOps = {
        mode: 'code',
        code: opsSource,
        functionName: 'Counter',
        executionStyle: 'ops-class',
        compiledArtifactKey: opsPreparation.compiledArtifactKey,
        compiledArtifactBase64: opsPreparation.compiledArtifactBase64,
        compiledArtifactSha256: opsPreparation.compiledArtifactSha256,
      };
      const preparedOpsFirst = await firstWorker.send('execute-prepared-code', {
        prepared: preparedOps,
        inputs: {
          operations: ['Counter', 'Add', 'Add'],
          arguments: [[2], [3], [5]],
        },
        assetBaseUrl,
        timeoutMs: 10_000,
      });
      const preparedOpsSecond = await firstWorker.send('execute-prepared-code', {
        prepared: preparedOps,
        inputs: {
          operations: ['Counter', 'Add'],
          arguments: [[10], [7]],
        },
        assetBaseUrl,
        timeoutMs: 10_000,
      });

      const processStateSource = [
        'using System;',
        'using System.Globalization;',
        'using System.IO;',
        'public class Solution {',
        '  public string State(bool mutate) {',
        '    const string path = "/tmp/tracecode-prepared-process-state.txt";',
        '    const string environmentKey = "TRACECODE_PREPARED_PROCESS_STATE";',
        '    const string switchName = "TraceCode.PreparedProcessState";',
        '    if (mutate) {',
        '      File.WriteAllText(path, "leak");',
        '      Directory.SetCurrentDirectory("/tmp");',
        '      Environment.SetEnvironmentVariable(environmentKey, "leak");',
        '      var currentCulture = (CultureInfo)CultureInfo.InvariantCulture.Clone();',
        '      currentCulture.NumberFormat.NegativeSign = "current-leak";',
        '      CultureInfo.CurrentCulture = currentCulture;',
        '      var currentUICulture = (CultureInfo)CultureInfo.InvariantCulture.Clone();',
        '      currentUICulture.DateTimeFormat.DateSeparator = "ui-leak";',
        '      CultureInfo.CurrentUICulture = currentUICulture;',
        '      var defaultCulture = (CultureInfo)CultureInfo.InvariantCulture.Clone();',
        '      defaultCulture.NumberFormat.PositiveSign = "default-leak";',
        '      CultureInfo.DefaultThreadCurrentCulture = defaultCulture;',
        '      var defaultUICulture = (CultureInfo)CultureInfo.InvariantCulture.Clone();',
        '      defaultUICulture.DateTimeFormat.TimeSeparator = "default-ui-leak";',
        '      CultureInfo.DefaultThreadCurrentUICulture = defaultUICulture;',
        '      AppContext.SetSwitch(switchName, true);',
        '    }',
        '    AppContext.TryGetSwitch(switchName, out bool switchValue);',
        '    return string.Join("|", new[] {',
        '      File.Exists(path).ToString(),',
        '      Environment.GetEnvironmentVariable(environmentKey) ?? "<null>",',
        '      Directory.GetCurrentDirectory(),',
        '      CultureInfo.CurrentCulture.NumberFormat.NegativeSign,',
        '      CultureInfo.CurrentUICulture.DateTimeFormat.DateSeparator,',
        '      CultureInfo.DefaultThreadCurrentCulture?.NumberFormat.PositiveSign ?? "<null>",',
        '      CultureInfo.DefaultThreadCurrentUICulture?.DateTimeFormat.TimeSeparator ?? "<null>",',
        '      switchValue.ToString(),',
        '    });',
        '  }',
        '}',
      ].join('\n');
      const processStatePreparation = await firstWorker.send<ExecuteResult>('prepare-program', {
        mode: 'code',
        code: processStateSource,
        functionName: 'State',
        executionStyle: 'solution-method',
        assetBaseUrl,
        timeoutMs: 10_000,
      });
      const preparedProcessState = {
        mode: 'code',
        code: processStateSource,
        functionName: 'State',
        executionStyle: 'solution-method',
        compiledArtifactKey: processStatePreparation.compiledArtifactKey,
        compiledArtifactBase64: processStatePreparation.compiledArtifactBase64,
        compiledArtifactSha256:
          processStatePreparation.compiledArtifactSha256,
      };
      const executeProcessStateInFreshWorker = async (mutate: boolean) => {
        const worker = await createWorkerHarness();
        try {
          return await worker.send('execute-prepared-code', {
            prepared: preparedProcessState,
            inputs: { mutate },
            assetBaseUrl,
            timeoutMs: 10_000,
          });
        } finally {
          worker.terminate();
        }
      };
      const processStateBaseline = await executeProcessStateInFreshWorker(false);
      const processStateMutation = await executeProcessStateInFreshWorker(true);
      const processStateAfterMutation = await executeProcessStateInFreshWorker(false);

      const unavailableArtifact = await firstWorker.send('execute-prepared-code', {
        prepared: {
          mode: 'code',
          code: [
            'public class Solution {',
            '  public int NeverCompilePreparedFallback(int value) => value + 9000;',
            '}',
          ].join('\n'),
          functionName: 'NeverCompilePreparedFallback',
          executionStyle: 'solution-method',
        },
        inputs: { value: 5 },
        assetBaseUrl,
        timeoutMs: 10_000,
      });

      const failureSource = [
        'public class Solution {',
        '  public int Fail(int value) {',
        '    throw new System.InvalidOperationException("prepared failure " + value);',
        '  }',
        '}',
      ].join('\n');
      const failurePreparation = await firstWorker.send<ExecuteResult>('prepare-program', {
        mode: 'code',
        code: failureSource,
        functionName: 'Fail',
        executionStyle: 'solution-method',
        assetBaseUrl,
        timeoutMs: 10_000,
      });
      const preparedFailure = await firstWorker.send('execute-prepared-code', {
        prepared: {
          mode: 'code',
          code: failureSource,
          functionName: 'Fail',
          executionStyle: 'solution-method',
          compiledArtifactKey: failurePreparation.compiledArtifactKey,
          compiledArtifactBase64: failurePreparation.compiledArtifactBase64,
          compiledArtifactSha256: failurePreparation.compiledArtifactSha256,
        },
        inputs: { value: 23 },
        assetBaseUrl,
        timeoutMs: 10_000,
      });

      const tracePreparation = await firstWorker.send<ExecuteResult>('prepare-program', {
        mode: 'trace',
        code: source,
        functionName: 'Touch',
        executionStyle: 'solution-method',
        traceOptions: { maxTraceSteps: 1_000, maxLineEvents: 1_000 },
        assetBaseUrl,
        timeoutMs: 10_000,
      });
      const preparedTrace = await firstWorker.send('execute-prepared-trace', {
        prepared: {
          mode: 'trace',
          code: source,
          functionName: 'Touch',
          executionStyle: 'solution-method',
          traceOptions: { maxTraceSteps: 1_000, maxLineEvents: 1_000 },
          compiledArtifactKey: tracePreparation.compiledArtifactKey,
          compiledArtifactBase64: tracePreparation.compiledArtifactBase64,
          compiledArtifactSha256: tracePreparation.compiledArtifactSha256,
        },
        inputs: { value: 19 },
        assetBaseUrl,
        timeoutMs: 10_000,
      });

      const disposed = await firstWorker.send<{ success: boolean; disposed: boolean }>(
        'dispose-prepared-program',
        { compiledArtifactKey: prepared.compiledArtifactKey }
      );

      const cancellableSource = [
        'public class Solution {',
        '  public int MaybeHang(bool hang, int value) {',
        '    if (hang) { while (true) { } }',
        '    return value;',
        '  }',
        '}',
      ].join('\n');
      const cancellablePreparation = await firstWorker.send<ExecuteResult>('prepare-program', {
        mode: 'code',
        code: cancellableSource,
        functionName: 'MaybeHang',
        executionStyle: 'solution-method',
        assetBaseUrl,
        timeoutMs: 10_000,
      });
      const cancellableProgram = {
        mode: 'code',
        code: cancellableSource,
        functionName: 'MaybeHang',
        executionStyle: 'solution-method',
        compiledArtifactKey: cancellablePreparation.compiledArtifactKey,
        compiledArtifactBase64: cancellablePreparation.compiledArtifactBase64,
        compiledArtifactSha256: cancellablePreparation.compiledArtifactSha256,
      };
      const hang = firstWorker.send('execute-prepared-code', {
        prepared: cancellableProgram,
        inputs: { hang: true, value: 29 },
        assetBaseUrl,
        timeoutMs: 60_000,
      });
      await new Promise<void>((resolve) => {
        setTimeout(() => {
          firstWorker.terminate(new Error('simulated client timeout'));
          resolve();
        }, 750);
      });
      await hang.catch(() => undefined);

      const replacementWorker = await createWorkerHarness();
      const preparedAfterTimeout = await replacementWorker.send('execute-prepared-code', {
        prepared: cancellableProgram,
        inputs: { hang: false, value: 31 },
        assetBaseUrl,
        timeoutMs: 10_000,
      });
      const afterTimeout = await replacementWorker.send('execute-code', request(source, 11));
      replacementWorker.terminate();
      const projectWorker = await createWorkerHarness();
      const procDirectory = await projectWorker.send<ProjectExecuteResult>('execute-project-csharp', {
        source: 'run',
        scriptPath: '<project>',
        args: [],
        cwd: '/workspace/src',
        env: {},
        assetBaseUrl,
        projectUserAuthorityMode: 'permanent',
        project: {
          kernelFiles: [
            { path: '/proc/kernel/info', contents: 'info-body\n' },
            { path: '/proc/kernel/version', contents: 'version-body\n' },
          ],
          files: [{
            path: 'src/Program.cs',
            contents: [
              'var paths = Directory.GetFiles("/proc/kernel");',
              'Array.Sort(paths, StringComparer.Ordinal);',
              'Console.WriteLine(string.Join(",", Array.ConvertAll(paths, Path.GetFileName)));',
              'foreach (var path in paths) {',
              '  Console.WriteLine(Path.GetFileName(path) + "=" + File.ReadAllText(path).Trim());',
              '}',
              '',
            ].join('\n'),
          }],
        },
      });
      projectWorker.terminate();
      return {
        cold,
        warm,
        edited,
        cacheIntegritySeed,
        cacheIntegrityRestored,
        prepared,
        preparedFirst,
        preparedSecond,
        tamperedPrepared,
        scriptPreparation,
        preparedScriptFirst,
        preparedScriptSecond,
        opsPreparation,
        preparedOpsFirst,
        preparedOpsSecond,
        processStatePreparation,
        processStateBaseline,
        processStateMutation,
        processStateAfterMutation,
        unavailableArtifact,
        failurePreparation,
        preparedFailure,
        tracePreparation,
        preparedTrace,
        disposed,
        cancellablePreparation,
        preparedAfterTimeout,
        procDirectory,
        afterTimeout,
      };
    }, { origin }) as {
      cold: ExecuteResult;
      warm: ExecuteResult;
      edited: ExecuteResult;
      cacheIntegritySeed: ExecuteResult;
      cacheIntegrityRestored: ExecuteResult;
      prepared: ExecuteResult;
      preparedFirst: ExecuteResult;
      preparedSecond: ExecuteResult;
      tamperedPrepared: ExecuteResult;
      scriptPreparation: ExecuteResult;
      preparedScriptFirst: ExecuteResult;
      preparedScriptSecond: ExecuteResult;
      opsPreparation: ExecuteResult;
      preparedOpsFirst: ExecuteResult;
      preparedOpsSecond: ExecuteResult;
      processStatePreparation: ExecuteResult;
      processStateBaseline: ExecuteResult;
      processStateMutation: ExecuteResult;
      processStateAfterMutation: ExecuteResult;
      unavailableArtifact: ExecuteResult;
      failurePreparation: ExecuteResult;
      preparedFailure: ExecuteResult;
      tracePreparation: ExecuteResult;
      preparedTrace: ExecuteResult;
      disposed: { success: boolean; disposed: boolean };
      cancellablePreparation: ExecuteResult;
      preparedAfterTimeout: ExecuteResult;
      procDirectory: ProjectExecuteResult;
      afterTimeout: ExecuteResult;
    };

    assertCondition(metrics.cold.success && metrics.cold.output === 107, `Cold C# run failed: ${JSON.stringify(metrics.cold)}`);
    assertCondition(metrics.cold.timings?.compileCacheHit === false, 'Cold C# run should miss the compiled artifact cache.');
    assertCondition(metrics.warm.success && metrics.warm.output === 109, `Warm C# run leaked static state: ${JSON.stringify(metrics.warm)}`);
    assertCondition(metrics.warm.timings?.compileCacheHit === true, 'Same-shape C# run should reuse the compiled PE.');
    assertCondition(
      metrics.warm.timings?.executionRealm === 'collectible-assembly-load-context',
      `Warm C# run should report a disposable execution realm: ${JSON.stringify(metrics.warm.timings)}`
    );
    assertCondition(metrics.edited.success && metrics.edited.output === 1003, `Edited C# run failed: ${JSON.stringify(metrics.edited)}`);
    assertCondition(metrics.edited.timings?.compileCacheHit === false, 'Edited C# source must miss the compiled artifact cache.');
    assertCondition(
      metrics.cacheIntegritySeed.success &&
        metrics.cacheIntegritySeed.output === 15 &&
        metrics.cacheIntegrityRestored.success &&
        metrics.cacheIntegrityRestored.output === 16 &&
        metrics.cacheIntegrityRestored.timings?.compileCacheHit === false &&
        metrics.cacheIntegrityRestored.timings?.hostArtifactCacheHit === false,
      `C# replacement workers must reject a host-cache PE whose digest envelope was corrupted: ${JSON.stringify({
        seed: metrics.cacheIntegritySeed,
        restored: metrics.cacheIntegrityRestored,
      })}`
    );
    assertCondition(
      metrics.prepared.success &&
        Boolean(metrics.prepared.compiledArtifactKey) &&
        Boolean(metrics.prepared.compiledArtifactBase64),
      `C# preparation did not return an opaque reusable artifact: ${JSON.stringify(metrics.prepared)}`
    );
    assertCondition(
      metrics.prepared.timings?.compileCacheHit === false,
      'C# program preparation should perform its only compilation before case execution.'
    );
    assertCondition(
      metrics.preparedFirst.success &&
        metrics.preparedFirst.output === 113 &&
        metrics.preparedFirst.timings?.compileCacheHit === true &&
        metrics.preparedFirst.timings?.artifactCacheHit === true,
      `First prepared C# case did not reuse the prepared artifact: ${JSON.stringify(metrics.preparedFirst)}`
    );
    assertCondition(
      metrics.preparedSecond.success &&
        metrics.preparedSecond.output === 117 &&
        metrics.preparedSecond.timings?.compileCacheHit === true &&
        metrics.preparedSecond.timings?.artifactCacheHit === true &&
        metrics.preparedSecond.timings?.executionRealm === 'collectible-assembly-load-context',
      `Second prepared C# case leaked static state or recompiled: ${JSON.stringify(metrics.preparedSecond)}`
    );
    assertCondition(
      metrics.tamperedPrepared.success === false &&
        metrics.tamperedPrepared.error ===
          'Prepared C# artifact is unavailable or invalid.',
      `General C# prepared execution must reject PE bytes that do not match the SHA-bound artifact: ${JSON.stringify(metrics.tamperedPrepared)}`
    );
    assertCondition(
      metrics.scriptPreparation.success &&
        metrics.preparedScriptFirst.success &&
        metrics.preparedScriptFirst.output === 37 &&
        metrics.preparedScriptFirst.timings?.compileCacheHit === true &&
        metrics.preparedScriptFirst.timings?.artifactCacheHit === true &&
        metrics.preparedScriptSecond.success &&
        metrics.preparedScriptSecond.output === 41 &&
        metrics.preparedScriptSecond.timings?.compileCacheHit === true &&
        metrics.preparedScriptSecond.timings?.artifactCacheHit === true,
      `Prepared C# script did not read distinct inputs from one compiled artifact: ${JSON.stringify({
        preparation: metrics.scriptPreparation,
        first: metrics.preparedScriptFirst,
        second: metrics.preparedScriptSecond,
      })}`
    );
    assertCondition(
      metrics.opsPreparation.success &&
        metrics.preparedOpsFirst.success &&
        JSON.stringify(metrics.preparedOpsFirst.output) === JSON.stringify([null, 5, 10]) &&
        metrics.preparedOpsFirst.timings?.compileCacheHit === true &&
        metrics.preparedOpsFirst.timings?.artifactCacheHit === true &&
        metrics.preparedOpsSecond.success &&
        JSON.stringify(metrics.preparedOpsSecond.output) === JSON.stringify([null, 17]) &&
        metrics.preparedOpsSecond.timings?.compileCacheHit === true &&
        metrics.preparedOpsSecond.timings?.artifactCacheHit === true,
      `Prepared C# ops-class did not read distinct operation streams from one compiled artifact: ${JSON.stringify({
        preparation: metrics.opsPreparation,
        first: metrics.preparedOpsFirst,
        second: metrics.preparedOpsSecond,
      })}`
    );
    assertCondition(
      metrics.processStatePreparation.success &&
        metrics.processStateBaseline.success &&
        metrics.processStateBaseline.timings?.compileCacheHit === true &&
        metrics.processStateBaseline.timings?.artifactCacheHit === true &&
        metrics.processStateMutation.success &&
        metrics.processStateMutation.timings?.compileCacheHit === true &&
        metrics.processStateMutation.timings?.artifactCacheHit === true &&
      metrics.processStateAfterMutation.success &&
        metrics.processStateAfterMutation.timings?.compileCacheHit === true &&
        metrics.processStateAfterMutation.timings?.artifactCacheHit === true,
      `Prepared C# process-state probe did not reuse one artifact in fresh workers: ${JSON.stringify({
        preparation: {
          success: metrics.processStatePreparation.success,
          error: metrics.processStatePreparation.error,
          timings: metrics.processStatePreparation.timings,
        },
        baseline: {
          success: metrics.processStateBaseline.success,
          output: metrics.processStateBaseline.output,
          error: metrics.processStateBaseline.error,
          timings: metrics.processStateBaseline.timings,
        },
        mutation: {
          success: metrics.processStateMutation.success,
          output: metrics.processStateMutation.output,
          error: metrics.processStateMutation.error,
          timings: metrics.processStateMutation.timings,
        },
        afterMutation: {
          success: metrics.processStateAfterMutation.success,
          output: metrics.processStateAfterMutation.output,
          error: metrics.processStateAfterMutation.error,
          timings: metrics.processStateAfterMutation.timings,
        },
      })}`
    );
    assertCondition(
      metrics.processStateBaseline.output === metrics.processStateAfterMutation.output,
      `Fresh prepared C# cases leaked process state across workers: ${JSON.stringify({
        baseline: metrics.processStateBaseline.output,
        mutation: metrics.processStateMutation.output,
        afterMutation: metrics.processStateAfterMutation.output,
      })}`
    );
    assertCondition(
      typeof metrics.processStateMutation.output === 'string' &&
        metrics.processStateMutation.output.startsWith(
          'True|leak|/tmp|current-leak|ui-leak|default-leak|default-ui-leak|True'
        ) &&
        metrics.processStateMutation.output !== metrics.processStateBaseline.output,
      `Prepared C# process-state mutation did not exercise every isolation surface: ${JSON.stringify(
        metrics.processStateMutation.output
      )}`
    );
    assertCondition(
      metrics.unavailableArtifact.success === false &&
        metrics.unavailableArtifact.error === 'Prepared C# artifact is unavailable or invalid.' &&
        metrics.unavailableArtifact.timings?.compileCacheHit === false &&
        metrics.unavailableArtifact.timings?.artifactCacheHit === false,
      `Missing prepared C# artifact must fail closed without compilation: ${JSON.stringify(metrics.unavailableArtifact)}`
    );
    assertCondition(
      metrics.failurePreparation.success &&
        metrics.preparedFailure.success === false &&
        metrics.preparedFailure.error?.includes('prepared failure 23') === true &&
        metrics.preparedFailure.timings?.compileCacheHit === true &&
        metrics.preparedFailure.timings?.artifactCacheHit === true,
      `Prepared C# learner failure did not preserve prepared-artifact timing: ${JSON.stringify({
        preparation: metrics.failurePreparation,
        execution: metrics.preparedFailure,
      })}`
    );
    assertCondition(
      metrics.tracePreparation.success &&
        metrics.preparedTrace.success &&
        metrics.preparedTrace.output === 119 &&
        metrics.preparedTrace.events?.some((event) => event.kind === 'line') === true &&
        metrics.preparedTrace.timings?.compileCacheHit === true &&
        metrics.preparedTrace.timings?.artifactCacheHit === true,
      `Prepared C# trace did not reuse its instrumented assembly: ${JSON.stringify(metrics.preparedTrace)}`
    );
    assertCondition(
      metrics.disposed.success && metrics.disposed.disposed,
      `Prepared C# artifact disposal did not remove the owned host cache entry: ${JSON.stringify(metrics.disposed)}`
    );
    assertCondition(
      metrics.cancellablePreparation.success &&
        metrics.preparedAfterTimeout.success &&
        metrics.preparedAfterTimeout.output === 31 &&
        metrics.preparedAfterTimeout.timings?.compileCacheHit === true &&
        metrics.preparedAfterTimeout.timings?.hostArtifactCacheHit === true &&
        metrics.preparedAfterTimeout.timings?.artifactCacheHit === true,
      `Prepared C# artifact did not survive cancellation through a replacement worker: ${JSON.stringify({
        preparation: metrics.cancellablePreparation,
        execution: metrics.preparedAfterTimeout,
      })}`
    );
    assertCondition(
      metrics.procDirectory.exitCode === 0 &&
        metrics.procDirectory.stdout === 'info,version\ninfo=info-body\nversion=version-body\n',
      `C# project Directory.GetFiles(/proc/kernel) should enumerate readable virtual files: ${JSON.stringify(metrics.procDirectory)}`
    );
    assertCondition(
      metrics.afterTimeout.success && metrics.afterTimeout.output === 111,
      `Replacement C# worker should execute in a clean realm: ${JSON.stringify(metrics.afterTimeout)}`
    );
    assertCondition(
      metrics.afterTimeout.timings?.compileCacheHit === true &&
        metrics.afterTimeout.timings?.hostArtifactCacheHit === true,
      'Replacement C# worker should restore immutable compiler output from the host cache.'
    );

    console.log(JSON.stringify({
      coldCompileMs: metrics.cold.timings?.compileMs,
      coldTotalMs: metrics.cold.timings?.totalMs,
      warmCompileMs: metrics.warm.timings?.compileMs,
      warmTotalMs: metrics.warm.timings?.totalMs,
      editedCompileMs: metrics.edited.timings?.compileMs,
      editedTotalMs: metrics.edited.timings?.totalMs,
      replacementCompileMs: metrics.afterTimeout.timings?.compileMs,
      replacementTotalMs: metrics.afterTimeout.timings?.totalMs,
      cacheEntries: metrics.edited.timings?.compileCacheEntries,
      cacheBytes: metrics.edited.timings?.compileCacheBytes,
      artifactBytes: metrics.warm.timings?.compileArtifactBytes,
      preparedCompileMs: metrics.prepared.timings?.compileMs,
      preparedFirstTotalMs: metrics.preparedFirst.timings?.totalMs,
      preparedSecondTotalMs: metrics.preparedSecond.timings?.totalMs,
      preparedReplacementTotalMs: metrics.preparedAfterTimeout.timings?.totalMs,
    }));
    console.log('PASS: C# browser compiler lifecycle prepares once, isolates every case, survives cancellation, traces, fails, and disposes exactly');
  } finally {
    await browser.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

test('csharp worker lifecycle browser', main);
