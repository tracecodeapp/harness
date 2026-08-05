import type {
  BrowserWorkerFactory,
  BrowserWorkerLike,
} from '@tracecode/runtime-browser/internal';
import { createWorkerProtocolToken } from '@tracecode/runtime-browser/internal';
import type {
  CppCompilerIntegrityManifest,
  CppTrustedCompilerService,
} from './cpp-worker-client';

export type TraceCCCompilerShard = 'narrow' | 'broad' | 'map';

export interface TraceCCCompilerShardAssets {
  readonly pchUrl: string;
  readonly pchSourceUrl: string;
  readonly runtimeObjectUrl: string;
}

export interface TraceCCCompilerServiceOptions {
  readonly workerUrl: string;
  readonly compilerUrl: string;
  readonly resourcesUrl: string;
  readonly runtimeHeaderUrl: string;
  readonly compilerIntegrity: CppCompilerIntegrityManifest;
  readonly shards: Readonly<Record<TraceCCCompilerShard, TraceCCCompilerShardAssets>>;
  readonly workerFactory?: BrowserWorkerFactory;
  /** Preflights the reactor, sysroot, and runtime header without a PCH shard. */
  readonly commonAssetPreflight?: () => Promise<void>;
  /** Preflights common assets plus only the selected immutable PCH shard. */
  readonly assetPreflight?: (shard: TraceCCCompilerShard) => Promise<void>;
  readonly requestTimeoutMs?: number;
  /** Number of completed immutable learner modules retained by the service. */
  readonly artifactCacheEntries?: number;
  /** Total completed module bytes retained by the service. */
  readonly artifactCacheBytes?: number;
  /**
   * Bounds engines that defer collection of exited command-style Wasm
   * instances. The trusted compiler Worker is replaced after this many
   * compilation requests; learner runners remain independently disposable.
   */
  readonly maxCompilesPerWorker?: number;
  /** Allows a process-backed Worker host to finish teardown before restart. */
  readonly workerRestartDelayMs?: number;
}

interface PendingRequest {
  readonly protocolToken: string;
  readonly resolve: (value: Record<string, unknown>) => void;
  readonly reject: (reason: Error) => void;
  readonly timeoutId: ReturnType<typeof setTimeout>;
}

const DEFAULT_REQUEST_TIMEOUT_MS = 120_000;
const DEFAULT_ARTIFACT_CACHE_ENTRIES = 32;
const DEFAULT_ARTIFACT_CACHE_BYTES = 64 * 1024 * 1024;
const MAX_ARTIFACT_BYTES = 16 * 1024 * 1024;
const TRACECC_STACK_SIZE = 8 * 1024 * 1024;

function compilerWorkerUrl(workerUrl: string): string {
  const fragmentIndex = workerUrl.indexOf('#');
  const base =
    fragmentIndex === -1 ? workerUrl : workerUrl.slice(0, fragmentIndex);
  const fragment =
    fragmentIndex === -1 ? '' : workerUrl.slice(fragmentIndex);
  return `${base}${base.includes('?') ? '&' : '?'}traceccRole=compiler${fragment}`;
}

function traceccShardForDriver(driverSource: string): TraceCCCompilerShard {
  if (new TextEncoder().encode(driverSource).byteLength >= 50_000) {
    return 'map';
  }
  const normalized = driverSource
    .replaceAll('std::', '')
    .replace(/\s+/g, '');
  return /(?:vector<(?:string|char|double|variant<)|vector<vector<(?:int|char|string|double|variant<))/.test(
    normalized
  )
    ? 'broad'
    : 'narrow';
}

function traceccFrontendArgs(
  pchPath: string,
  outputPath: string
): readonly string[] {
  return [
    'tracecc-cxx',
    '/workspace/TraceCodeDriver.cpp',
    outputPath,
    '/usr',
    pchPath,
  ];
}

function traceccLinkerArgs(
  objectPath: string,
  runtimeObjectPath: string,
  outputPath: string
): readonly string[] {
  return [
    'wasm-ld',
    '-m',
    'wasm32',
    '-L/usr/lib/wasm32-unknown-wasip1',
    '-L/usr/lib/wasm32-wasip1',
    '/usr/lib/wasm32-wasip1/crt1-command.o',
    objectPath,
    runtimeObjectPath,
    '-z',
    `stack-size=${TRACECC_STACK_SIZE}`,
    '-lc++',
    '-lc++abi',
    '-lc',
    '/usr/lib/wasm32-unknown-wasip1/libclang_rt.builtins.a',
    '-o',
    outputPath,
  ];
}

function transferableProgramBuffer(value: unknown): ArrayBuffer | null {
  if (value instanceof ArrayBuffer) return value;
  if (!(value instanceof Uint8Array)) return null;
  return value.buffer.slice(
    value.byteOffset,
    value.byteOffset + value.byteLength
  ) as ArrayBuffer;
}

/**
 * TraceCC compiler authority.
 *
 * It owns one warm trusted compiler Worker and never instantiates learner
 * output. Every compile uses a fresh Wasm compiler instance and a fresh
 * mutable filesystem fork; only immutable toolchain/PCH backing and immutable
 * path caches remain warm. CppWorkerClient owns the bounded artifact cache and
 * disposable learner-runner lifecycle around this service.
 */
export class TraceCCCompilerService
implements CppTrustedCompilerService {
  private worker: BrowserWorkerLike | null = null;
  private readyPromise: Promise<void> | null = null;
  private operation: Promise<void> = Promise.resolve();
  private requestId = 0;
  private generation = 0;
  private compilesInGeneration = 0;
  private restartAfter = 0;
  private readonly pending = new Map<string, PendingRequest>();
  private readonly requestTimeoutMs: number;
  private readonly artifactCache = new Map<
    string,
    { bytes: Uint8Array; result: Record<string, unknown> }
  >();
  private artifactCacheBytes = 0;

  constructor(
    private readonly options: TraceCCCompilerServiceOptions
  ) {
    this.requestTimeoutMs =
      options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  }

  async warmup(shard: TraceCCCompilerShard = 'narrow'): Promise<void> {
    await this.options.assetPreflight?.(shard);
    await this.ensureWorker();
    const selected = this.options.shards[shard];
    const pchPath = `/tracecc-assets/${shard}.pch`;
    const runtimeObjectPath = `/tracecc-assets/${shard}.o`;
    const result = await this.send('compile-trusted-tracecc', {
      ...this.traceccAssets(selected, pchPath, runtimeObjectPath),
      source: 'tracecc-compile-v1',
      loadOnly: true,
    });
    if (result.success !== true) {
      throw new Error(
        typeof result.error === 'string'
          ? result.error
          : 'TraceCC compiler warmup failed.'
      );
    }
  }

  async compileTrusted(
    payload: unknown,
    signal?: AbortSignal
  ): Promise<Record<string, unknown>> {
    const projectRequest =
      payload &&
      typeof payload === 'object' &&
      (payload as { projectRequest?: unknown }).projectRequest &&
      typeof (payload as { projectRequest?: unknown }).projectRequest ===
        'object'
        ? (payload as { projectRequest: Record<string, unknown> })
            .projectRequest
        : null;
    const driverSource =
      payload &&
      typeof payload === 'object' &&
      typeof (payload as { driverSource?: unknown }).driverSource === 'string'
        ? (payload as { driverSource: string }).driverSource
        : null;
    if (driverSource === null && projectRequest === null) {
      return {
        success: false,
        error:
          'TraceCC requires a normalized driver or Project compile payload.',
      };
    }

    const prior = this.operation;
    let release!: () => void;
    this.operation = new Promise<void>((resolve) => {
      release = resolve;
    });
    await prior;
    try {
      if (signal?.aborted) {
        throw Object.assign(new Error('TraceCC compilation was cancelled.'), {
          name: 'AbortError',
        });
      }
      const generation = this.generation;
      const abort = () => {
        if (generation === this.generation) {
          this.reset(
            Object.assign(new Error('TraceCC compilation was cancelled.'), {
              name: 'AbortError',
            })
          );
        }
      };
      signal?.addEventListener('abort', abort, { once: true });
      try {
        if (projectRequest) {
          return await this.compileProject(
            projectRequest,
            signal,
            generation
          );
        }
        if (driverSource === null) {
          throw new Error('TraceCC driver source is missing.');
        }
        const artifactKey = await this.artifactKey(driverSource);
        const cached = this.cachedArtifact(artifactKey);
        if (cached) return cached;
        const shard = traceccShardForDriver(driverSource);
        await this.options.assetPreflight?.(shard);
        if (signal?.aborted || generation !== this.generation) {
          throw Object.assign(
            new Error('TraceCC compilation was cancelled.'),
            { name: 'AbortError' }
          );
        }
        const selected = this.options.shards[shard];
        const pchPath = `/tracecc-assets/${shard}.pch`;
        const runtimeObjectPath = `/tracecc-assets/${shard}.o`;
        const objectPath = '/workspace/program.o';
        const outputPath = '/workspace/program.wasm';
        const compileStartedAt = performance.now();
        const result = await this.send('compile-trusted-tracecc', {
          ...this.traceccAssets(selected, pchPath, runtimeObjectPath),
          source: 'tracecc-compile-v1',
          args: traceccFrontendArgs(pchPath, objectPath),
          linkerArgs: traceccLinkerArgs(
            objectPath,
            runtimeObjectPath,
            outputPath
          ),
          directCommand: true,
          outputPath,
          bufferedFileWrites: true,
          compileStreaming: true,
          nonSeekableOutputPaths: ['/workspace'],
          returnOutputBytes: true,
          project: {
            files: [
              {
                path: '/workspace/TraceCodeDriver.cpp',
                contents: driverSource.replace(
                  /^#include\s+["<]\/?tracecode_runtime\.hpp[">]\s*\r?\n/,
                  ''
                ),
              },
            ],
          },
        });
        if (signal?.aborted || generation !== this.generation) {
          throw Object.assign(
            new Error('TraceCC compilation was cancelled.'),
            { name: 'AbortError' }
          );
        }
        const programBuffer = transferableProgramBuffer(result.outputBytes);
        this.compilesInGeneration += 1;
        if (
          this.options.maxCompilesPerWorker !== undefined &&
          this.compilesInGeneration >=
            this.options.maxCompilesPerWorker
        ) {
          this.reset(
            new Error(
              'TraceCC compiler Worker reached its bounded generation.'
            )
          );
        }
        const timings =
          result.timings && typeof result.timings === 'object'
            ? result.timings as Record<string, unknown>
            : {};
        if (result.success !== true || !programBuffer) {
          return {
            success: false,
            error:
              typeof result.error === 'string'
                ? result.error
                : 'TraceCC compilation failed.',
            stdout: typeof result.stdout === 'string' ? result.stdout : '',
            stderr: typeof result.stderr === 'string' ? result.stderr : '',
            compileMs: performance.now() - compileStartedAt,
            timings: { ...timings, traceccShard: shard },
          };
        }
        return this.storeArtifact(artifactKey, {
          success: true,
          programBuffer,
          stdout: typeof result.stdout === 'string' ? result.stdout : '',
          stderr: typeof result.stderr === 'string' ? result.stderr : '',
          compileMs: performance.now() - compileStartedAt,
          timings: { ...timings, traceccShard: shard },
        });
      } finally {
        signal?.removeEventListener('abort', abort);
      }
    } finally {
      release();
    }
  }

  terminate(): void {
    this.artifactCache.clear();
    this.artifactCacheBytes = 0;
    this.reset(new Error('TraceCC compiler service was terminated.'));
  }

  private async artifactKey(driverSource: string): Promise<string> {
    const digest = await crypto.subtle.digest(
      'SHA-256',
      new TextEncoder().encode(
        `tracecode.tracecc.compiler-artifact.v1\0${driverSource}`
      )
    );
    return Array.from(
      new Uint8Array(digest),
      (byte) => byte.toString(16).padStart(2, '0')
    ).join('');
  }

  private cachedArtifact(
    key: string
  ): Record<string, unknown> | null {
    const cached = this.artifactCache.get(key);
    if (!cached) return null;
    this.artifactCache.delete(key);
    this.artifactCache.set(key, cached);
    const timings =
      cached.result.timings &&
      typeof cached.result.timings === 'object'
        ? cached.result.timings as Record<string, unknown>
        : {};
    return {
      ...cached.result,
      success: true,
      programBuffer: cached.bytes.slice().buffer,
      compileMs: 0,
      artifactDigest: key,
      timings: {
        ...timings,
        compileCacheHit: true,
        artifactCacheHit: true,
      },
    };
  }

  private storeArtifact(
    key: string,
    result: Record<string, unknown>
  ): Record<string, unknown> {
    if (!(result.programBuffer instanceof ArrayBuffer)) return result;
    const bytes = new Uint8Array(result.programBuffer);
    const entryLimit =
      this.options.artifactCacheEntries ??
      DEFAULT_ARTIFACT_CACHE_ENTRIES;
    const byteLimit =
      this.options.artifactCacheBytes ??
      DEFAULT_ARTIFACT_CACHE_BYTES;
    if (
      entryLimit <= 0 ||
      byteLimit <= 0 ||
      bytes.byteLength > MAX_ARTIFACT_BYTES ||
      bytes.byteLength > byteLimit
    ) {
      return result;
    }
    const storedResult = { ...result };
    delete storedResult.programBuffer;
    const previous = this.artifactCache.get(key);
    if (previous) {
      this.artifactCacheBytes -= previous.bytes.byteLength;
      this.artifactCache.delete(key);
    }
    const storedBytes = bytes.slice();
    this.artifactCache.set(key, {
      bytes: storedBytes,
      result: storedResult,
    });
    this.artifactCacheBytes += storedBytes.byteLength;
    while (
      this.artifactCache.size > Math.floor(entryLimit) ||
      this.artifactCacheBytes > byteLimit
    ) {
      const oldestKey = this.artifactCache.keys().next().value as
        | string
        | undefined;
      if (!oldestKey) break;
      const oldest = this.artifactCache.get(oldestKey);
      this.artifactCache.delete(oldestKey);
      if (oldest) this.artifactCacheBytes -= oldest.bytes.byteLength;
    }
    return {
      ...result,
      artifactDigest: key,
      timings: {
        ...(result.timings &&
        typeof result.timings === 'object'
          ? result.timings as Record<string, unknown>
          : {}),
        compileCacheHit: false,
        artifactCacheHit: false,
      },
    };
  }

  private traceccAssets(
    selected: TraceCCCompilerShardAssets,
    pchPath: string,
    runtimeObjectPath: string
  ): Record<string, unknown> {
    return {
      ...this.traceccBaseAssets(),
      traceccPchUrl: selected.pchUrl,
      traceccPchPath: pchPath,
      traceccPchSourceUrl: selected.pchSourceUrl,
      traceccPchSourcePath: '/tracecode_pch.hpp',
      traceccRuntimeObjectUrl: selected.runtimeObjectUrl,
      traceccRuntimeObjectPath: runtimeObjectPath,
    };
  }

  private traceccBaseAssets(): Record<string, unknown> {
    return {
      traceccCompilerUrl: this.options.compilerUrl,
      traceccResourcesUrl: this.options.resourcesUrl,
      traceccRuntimeHeaderUrl: this.options.runtimeHeaderUrl,
      traceccRuntimeHeaderPath: '/tracecode_runtime.hpp',
    };
  }

  private async compileProject(
    projectRequest: Record<string, unknown>,
    signal: AbortSignal | undefined,
    generation: number
  ): Promise<Record<string, unknown>> {
    if (projectRequest.source !== 'compile') {
      return {
        success: false,
        error: 'TraceCC trusted Project compilation only accepts compile requests.',
      };
    }
    await this.options.commonAssetPreflight?.();
    if (signal?.aborted || generation !== this.generation) {
      throw Object.assign(
        new Error('TraceCC Project compilation was cancelled.'),
        { name: 'AbortError' }
      );
    }
    const compileStartedAt = performance.now();
    const result = await this.send('compile-trusted-tracecc', {
      ...this.traceccBaseAssets(),
      source: 'tracecc-project-compile-v1',
      projectRequest,
      bufferedFileWrites: true,
      compileStreaming: true,
      returnOutputBytes: true,
    });
    if (signal?.aborted || generation !== this.generation) {
      throw Object.assign(
        new Error('TraceCC Project compilation was cancelled.'),
        { name: 'AbortError' }
      );
    }
    const programBuffer = transferableProgramBuffer(result.outputBytes);
    this.compilesInGeneration += 1;
    if (
      this.options.maxCompilesPerWorker !== undefined &&
      this.compilesInGeneration >= this.options.maxCompilesPerWorker
    ) {
      this.reset(
        new Error('TraceCC compiler Worker reached its bounded generation.')
      );
    }
    const timings =
      result.timings && typeof result.timings === 'object'
        ? result.timings as Record<string, unknown>
        : {};
    if (result.success !== true || !programBuffer) {
      return {
        success: false,
        error:
          typeof result.error === 'string'
            ? result.error
            : 'TraceCC Project compilation failed.',
        stdout: typeof result.stdout === 'string' ? result.stdout : '',
        stderr: typeof result.stderr === 'string' ? result.stderr : '',
        compileMs: performance.now() - compileStartedAt,
        timings,
      };
    }
    return {
      success: true,
      programBuffer,
      outputPath:
        typeof result.outputPath === 'string'
          ? result.outputPath
          : 'a.out',
      stdout: typeof result.stdout === 'string' ? result.stdout : '',
      stderr: typeof result.stderr === 'string' ? result.stderr : '',
      compileMs: performance.now() - compileStartedAt,
      timings,
    };
  }

  private async ensureWorker(): Promise<void> {
    if (this.worker && this.readyPromise) return this.readyPromise;
    const restartDelayMs = this.restartAfter - performance.now();
    if (restartDelayMs > 0) {
      await new Promise<void>((resolve) => {
        globalThis.setTimeout(resolve, restartDelayMs);
      });
    }
    const workerUrl = compilerWorkerUrl(this.options.workerUrl);
    const worker = this.options.workerFactory
      ? this.options.workerFactory(workerUrl, { type: 'module' })
      : new Worker(workerUrl, { type: 'module' });
    this.worker = worker;
    const generation = this.generation;
    this.readyPromise = new Promise<void>((resolve, reject) => {
      const readyTimeout = globalThis.setTimeout(() => {
        reject(new Error('TraceCC compiler Worker did not become ready.'));
        this.reset(
          new Error('TraceCC compiler Worker did not become ready.')
        );
      }, this.requestTimeoutMs);
      worker.onmessage = (event: MessageEvent) => {
        const message = event.data as {
          id?: string;
          type?: string;
          protocolToken?: string;
          payload?: Record<string, unknown>;
        };
        if (message.type === 'worker-ready') {
          globalThis.clearTimeout(readyTimeout);
          resolve();
          return;
        }
        if (
          message.type === 'runtime-progress' ||
          message.type === 'project-event'
        ) {
          return;
        }
        if (!message.id) return;
        const pending = this.pending.get(message.id);
        if (
          !pending ||
          message.protocolToken !== pending.protocolToken
        ) {
          return;
        }
        this.pending.delete(message.id);
        globalThis.clearTimeout(pending.timeoutId);
        if (message.type === 'error') {
          pending.reject(
            new Error(
              typeof message.payload?.error === 'string'
                ? message.payload.error
                : 'TraceCC compiler Worker failed.'
            )
          );
          return;
        }
        pending.resolve(message.payload ?? {});
      };
      worker.onerror = (event: ErrorEvent) => {
        globalThis.clearTimeout(readyTimeout);
        const error = new Error(
          event.message || 'TraceCC compiler Worker crashed.'
        );
        reject(error);
        if (generation === this.generation) this.reset(error);
      };
    });
    await this.readyPromise;
    const init = await this.send('init', {
      assets: {
        toolchainIntegrity: this.options.compilerIntegrity,
      },
    });
    if (init.success !== true) {
      const error = new Error(
        typeof init.error === 'string'
          ? init.error
          : 'TraceCC compiler Worker initialization failed.'
      );
      this.reset(error);
      throw error;
    }
  }

  private async send(
    type: string,
    payload: unknown
  ): Promise<Record<string, unknown>> {
    await this.ensureWorkerReadyOnly();
    const worker = this.worker;
    if (!worker) {
      throw new Error('TraceCC compiler Worker is unavailable.');
    }
    const id = `tracecc-${++this.requestId}`;
    const protocolToken = createWorkerProtocolToken();
    return new Promise<Record<string, unknown>>((resolve, reject) => {
      const timeoutId = globalThis.setTimeout(() => {
        this.pending.delete(id);
        const error = new Error(
          `TraceCC compiler request "${type}" timed out.`
        );
        reject(error);
        this.reset(error);
      }, this.requestTimeoutMs);
      this.pending.set(id, {
        protocolToken,
        resolve,
        reject,
        timeoutId,
      });
      worker.postMessage({ id, type, protocolToken, payload });
    });
  }

  private async ensureWorkerReadyOnly(): Promise<void> {
    if (!this.worker || !this.readyPromise) {
      await this.ensureWorker();
      return;
    }
    await this.readyPromise;
  }

  private reset(reason: Error): void {
    this.generation += 1;
    const worker = this.worker;
    this.worker = null;
    this.readyPromise = null;
    this.compilesInGeneration = 0;
    this.restartAfter =
      performance.now() + (this.options.workerRestartDelayMs ?? 0);
    worker?.terminate();
    for (const pending of this.pending.values()) {
      globalThis.clearTimeout(pending.timeoutId);
      pending.reject(reason);
    }
    this.pending.clear();
  }
}
