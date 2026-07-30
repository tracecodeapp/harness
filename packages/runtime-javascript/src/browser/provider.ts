import type {
  RuntimeCommandResult,
} from "@tracecode/runtime-core";

import {
  createRuntimeProjectIoBridge,
  runtimeAbortSignalName,
  runtimeProjectInfrastructureFailure,
  runRuntimeProjectWorkerBridge,
} from "@tracecode/runtime-core";

import {
  DEFAULT_SIGNAL_GRACE_MS,
  DEFAULT_TIMEOUT_MS,
} from "./constants";

import {
  BrowserJavaScriptProjectCommandRunner,
  BrowserJavaScriptProjectExecutionState,
  BrowserJavaScriptProjectRunnerOptions,
  JavaScriptProjectCommandRunner,
} from "./contracts";

import {
  runBrowserJavaScriptProjectRequest,
} from "./request-execution";

import {
  BrowserJavaScriptProjectWorkerClient,
  createBrowserJavaScriptProjectPolicyFailureRunner,
  withDescriptorStdioCapability,
} from "./worker-client";

import {
  processArgvForRequest,
} from "../kernel/process-control";

function createWorkerBackedBrowserJavaScriptProjectRunner(
  options: BrowserJavaScriptProjectRunnerOptions & { workerUrl: string }
): BrowserJavaScriptProjectCommandRunner {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const workerIsolation = options.workerIsolation ?? 'per-command';
  if (workerIsolation !== 'per-command' && workerIsolation !== 'shared') {
    return createBrowserJavaScriptProjectPolicyFailureRunner(
      `Invalid JavaScript worker isolation: ${String(workerIsolation)}`
    );
  }
  if (workerIsolation === 'shared' && options.trustedReusableWorker !== true) {
    return createBrowserJavaScriptProjectPolicyFailureRunner(
      'Shared JavaScript worker isolation requires trustedReusableWorker'
    );
  }
  if (workerIsolation === 'per-command') {
    type PreparedWorker = { client: BrowserJavaScriptProjectWorkerClient };
    let standby: Promise<PreparedWorker> | null = null;
    let disposed = false;
    const clients = new Set<BrowserJavaScriptProjectWorkerClient>();
    const prepareWorker = (): Promise<PreparedWorker> => {
      if (standby) return standby;
      const client = new BrowserJavaScriptProjectWorkerClient(options.workerUrl, {
        allowDynamicEval: options.allowDynamicEval,
        projectUserAuthorityMode: 'permanent',
      }, options.workerFactory);
      clients.add(client);
      const attempt = (async () => {
        await options.assetPreflight?.();
        await client.warmup();
        if (disposed) throw new Error('JavaScript project prewarm was retired.');
        return { client };
      })();
      const observed = attempt.catch((error) => {
        clients.delete(client);
        client.terminate();
        if (standby === observed) standby = null;
        throw error;
      });
      standby = observed;
      void observed.catch(() => undefined);
      return observed;
    };
    const refill = () => {
      if (!disposed && options.prewarm && !standby) prepareWorker();
    };
    const dispose = () => {
      disposed = true;
      standby = null;
      for (const client of clients) client.terminate();
      clients.clear();
    };
    options.registerPrewarmCleanup?.(dispose);
    refill();
    const runner: JavaScriptProjectCommandRunner = (request) =>
      runRuntimeProjectWorkerBridge({
        request,
        startPhase: 'process-start',
        startMessage: 'Starting browser Node',
        startDetail: {
          command: 'node',
          args: processArgvForRequest(request).slice(2),
          cwd: request.cwd,
        },
        finishPhase: 'process-exit',
        finishMessage: 'Browser Node exited',
        applyFileChange: options.applyFileChange,
        run: async (workerRequest, onEvent, engineLease) => {
          const prepared = options.prewarm ? prepareWorker() : null;
          if (prepared && standby === prepared) standby = null;
          refill();
          const client = prepared
            ? (await prepared).client
            : new BrowserJavaScriptProjectWorkerClient(options.workerUrl, {
                allowDynamicEval: options.allowDynamicEval,
                projectUserAuthorityMode: 'permanent',
              }, options.workerFactory);
          clients.add(client);
          let attachedToKernel = false;
          try {
            if (!prepared) await options.assetPreflight?.();
            if (engineLease) {
              engineLease.attach({
                release: () => {
                  clients.delete(client);
                  client.terminate();
                },
              });
              attachedToKernel = true;
            }
            return await client.executeProject(workerRequest, timeoutMs, onEvent);
          } finally {
            if (!attachedToKernel) {
              clients.delete(client);
              client.terminate();
            }
          }
        },
      });
    return withDescriptorStdioCapability(
      Object.assign(runner, { dispose }),
      true
    );
  }
  const client = new BrowserJavaScriptProjectWorkerClient(options.workerUrl, {
    allowDynamicEval: options.allowDynamicEval,
    projectUserAuthorityMode: 'temporary',
  }, options.workerFactory);
  return withDescriptorStdioCapability((request) =>
    runRuntimeProjectWorkerBridge({
      request,
      startPhase: 'process-start',
      startMessage: 'Starting browser Node',
      startDetail: {
        command: 'node',
        args: processArgvForRequest(request).slice(2),
        cwd: request.cwd,
      },
      finishPhase: 'process-exit',
      finishMessage: 'Browser Node exited',
      applyFileChange: options.applyFileChange,
      run: async (workerRequest, onEvent, engineLease) => {
        await options.assetPreflight?.();
        if (engineLease) await client.acquireReusableEngineLease(engineLease);
        return client.executeProject(workerRequest, timeoutMs, onEvent);
      },
    }), true);
}

export function createBrowserJavaScriptProjectRunner(
  options: BrowserJavaScriptProjectRunnerOptions = {}
): BrowserJavaScriptProjectCommandRunner {
  if (options.workerUrl && (options.workerFactory !== undefined || typeof Worker !== 'undefined')) {
    return createWorkerBackedBrowserJavaScriptProjectRunner({
      ...options,
      workerUrl: options.workerUrl,
    });
  }
  if (
    options.hardened === true ||
    options.allowMainThreadExecution !== true ||
    options.trustedMainThreadExecution !== true
  ) {
    return createBrowserJavaScriptProjectPolicyFailureRunner(
      'JavaScript Worker execution is unavailable and trusted main-thread execution was not enabled'
    );
  }
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  return withDescriptorStdioCapability(async (request) => {
    const hostSetTimeout = globalThis.setTimeout.bind(globalThis);
    const hostClearTimeout = globalThis.clearTimeout.bind(globalThis);
    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    let signalGraceTimeoutId: ReturnType<typeof setTimeout> | undefined;
    let abortListener: (() => void) | undefined;
    let kernelSignalCleanup: (() => void) | undefined;
    let forcedResult: RuntimeCommandResult | undefined;
    let resolveForcedResult!: (result: RuntimeCommandResult) => void;
    let resolveForcedCleanup!: () => void;
    const forcedResultPromise = new Promise<RuntimeCommandResult>((resolve) => {
      resolveForcedResult = resolve;
    });
    const forcedCleanupPromise = new Promise<void>((resolve) => {
      resolveForcedCleanup = resolve;
    });
    const forceResult = (result: RuntimeCommandResult): void => {
      if (forcedResult) return;
      executionState.cancelled = true;
      executionState.abortController.abort();
      forcedResult = result;
      // Let the runtime observe cancellation before clearing its tracked host
      // task. Clearing a timer that `drain()` is currently awaiting strands
      // teardown forever; one host turn preserves that checkpoint while still
      // preventing a subsequent command from seeing patched globals.
      hostSetTimeout(() => {
        executionState.cleanupHostGlobals?.();
        resolveForcedCleanup();
        resolveForcedResult(result);
      }, 0);
    };
    const cleanup = (): void => {
      if (timeoutId !== undefined) {
        hostClearTimeout(timeoutId);
        timeoutId = undefined;
      }
      if (signalGraceTimeoutId !== undefined) {
        hostClearTimeout(signalGraceTimeoutId);
        signalGraceTimeoutId = undefined;
      }
      if (abortListener) {
        request.signal?.removeEventListener('abort', abortListener);
        abortListener = undefined;
      }
      kernelSignalCleanup?.();
      kernelSignalCleanup = undefined;
    };
    const executionState: BrowserJavaScriptProjectExecutionState = {
      cancelled: false,
      abortController: new AbortController(),
    };
    const execution = runBrowserJavaScriptProjectRequest(request, options, executionState).finally(cleanup);
    void execution.catch(() => undefined);
    if (request.kernelSignals) {
      kernelSignalCleanup = request.kernelSignals.subscribe(({ signal }) => {
        const handled = executionState.dispatchSignal?.(signal) === true;
        if (handled || signal === 'SIGWINCH' || forcedResult) return;
        const signalController = new AbortController();
        signalController.abort({ signal });
        forceResult(
          runtimeProjectInfrastructureFailure(
            Object.assign(new Error('Execution interrupted'), { name: 'AbortError' }),
            signalController.signal
          )
        );
      });
    }
    timeoutId = hostSetTimeout(() => {
      if (forcedResult) return;
      const io = createRuntimeProjectIoBridge(request.onEvent);
      const timeoutStderr = `node: execution timed out after ${timeoutMs}ms\n`;
      io.output('stderr', timeoutStderr);
      io.status('process-exit', 'Browser Node timed out', { command: 'node', exitCode: 124, timeoutMs });
      forceResult({
        stdout: '',
        stderr: timeoutStderr,
        exitCode: 124,
      });
    }, timeoutMs);
    if (request.signal) {
      abortListener = () => {
        if (forcedResult) return;
        const signal = runtimeAbortSignalName(request.signal);
        const interrupt = (): void => {
          const failure = runtimeProjectInfrastructureFailure(
            Object.assign(new Error('Execution interrupted'), { name: 'AbortError' }),
            request.signal
          );
          const io = createRuntimeProjectIoBridge(request.onEvent);
          io.status('process-exit', 'Browser Node interrupted', {
            command: 'node',
            exitCode: failure.exitCode,
            signal,
            error: failure.error?.message,
          });
          forceResult(failure);
        };
        if (executionState.dispatchSignal?.(signal)) {
          signalGraceTimeoutId = hostSetTimeout(interrupt, DEFAULT_SIGNAL_GRACE_MS);
          return;
        }
        interrupt();
      };
      request.signal.addEventListener('abort', abortListener, { once: true });
      if (request.signal.aborted) abortListener();
    }
    try {
      const result = await Promise.race([execution, forcedResultPromise]);
      if (forcedResult) {
        await forcedCleanupPromise;
        return forcedResult;
      }
      return result;
    } catch (error) {
      if (forcedResult) return forcedResult;
      throw error;
    } finally {
      cleanup();
    }
  }, false);
}
