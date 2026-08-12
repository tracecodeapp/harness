import {
  TraceCCCompilerService,
  type TraceCCCompilerServiceOptions,
} from '../packages/runtime-cpp/src/tracecc-compiler-service';

const MINIMAL_WASM = new Uint8Array([
  0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00,
]);

function assertCondition(
  condition: unknown,
  message: string
): asserts condition {
  if (!condition) throw new Error(message);
}

interface WorkerRequest {
  id?: string;
  type?: string;
  protocolToken?: string;
  payload?: Record<string, unknown>;
}

class TraceCCCompilerWorkerDouble {
  static instances: TraceCCCompilerWorkerDouble[] = [];

  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  readonly requests: WorkerRequest[] = [];
  terminated = false;

  constructor(readonly url: string) {
    TraceCCCompilerWorkerDouble.instances.push(this);
    queueMicrotask(() => {
      this.onmessage?.({
        data: { type: 'worker-ready' },
      } as MessageEvent);
    });
  }

  postMessage(message: WorkerRequest): void {
    this.requests.push(message);
    const respond = (payload: Record<string, unknown>) => {
      queueMicrotask(() => {
        this.onmessage?.({
          data: {
            id: message.id,
            type: 'result',
            protocolToken: message.protocolToken,
            payload,
          },
        } as MessageEvent);
      });
    };
    if (message.type === 'init') {
      respond({ success: true });
      return;
    }
    if (message.type === 'prewarm-trusted-tracecc-assets') {
      respond({ success: true });
      return;
    }
    if (message.type === 'compile-trusted-tracecc') {
      respond({
        success: true,
        outputBytes: MINIMAL_WASM.slice(),
        stdout: '',
        stderr: '',
        timings: { totalMs: 1 },
      });
    }
  }

  terminate(): void {
    this.terminated = true;
  }

  emitIdleTimeout(): void {
    this.onmessage?.({
      data: { type: 'idle-timeout' },
    } as MessageEvent);
  }
}

function options(
  overrides: Partial<TraceCCCompilerServiceOptions> = {}
): TraceCCCompilerServiceOptions {
  const shard = {
    pchUrl: '/tracecc/narrow.pch',
    pchSourceUrl: '/tracecc/narrow.hpp',
    runtimeObjectUrl: '/tracecc/narrow.o',
  };
  return {
    workerUrl: '/workers/cpp-worker.js',
    compilerUrl: '/tracecc/tracecc-reactor.wasm',
    resourcesUrl: '/tracecc/llvm-resources.tar',
    runtimeHeaderUrl: '/workers/cpp/tracecode_runtime.hpp',
    compilerIntegrity: { assets: [] },
    shards: {
      narrow: shard,
      broad: { ...shard, pchUrl: '/tracecc/broad.pch' },
      map: { ...shard, pchUrl: '/tracecc/map.pch' },
    },
    workerFactory: (url) =>
      new TraceCCCompilerWorkerDouble(String(url)) as never,
    ...overrides,
  };
}

async function testFixedReactorContract(): Promise<void> {
  TraceCCCompilerWorkerDouble.instances = [];
  const coordinator = new TraceCCCompilerService(
    options({
      workerUrl:
        '/workers/cpp-worker.js?traceccRole=runner&cache=immutable#worker',
    })
  );
  try {
    await coordinator.warmup();
    const result = await coordinator.compileTrusted({
      driverSource:
        '#include "tracecode_runtime.hpp"\nint main() { return 0; }',
    });
    const cachedResult = await coordinator.compileTrusted({
      driverSource:
        '#include "tracecode_runtime.hpp"\nint main() { return 0; }',
    });
    assertCondition(result.success === true, 'TraceCC compile should succeed.');
    assertCondition(
      result.programBuffer instanceof ArrayBuffer &&
        WebAssembly.validate(result.programBuffer),
      'TraceCC must transfer a valid WebAssembly artifact.'
    );
    const worker = TraceCCCompilerWorkerDouble.instances[0];
    assertCondition(
      worker.url ===
        '/workers/cpp-worker.js?traceccRole=compiler&cache=immutable#worker',
      `The trusted compiler must use the compiler-only worker role: ${worker.url}`
    );
    assertCondition(
      cachedResult.success === true &&
        (cachedResult.timings as Record<string, unknown>)
          ?.artifactCacheHit === true &&
        worker.requests.filter((request) =>
          request.type === 'compile-trusted-tracecc' &&
          request.payload?.loadOnly !== true
        ).length === 1,
      'An exact repeat should reuse the coordinator-owned artifact across runners.'
    );
    const compile = worker.requests.find((request) =>
      request.type === 'compile-trusted-tracecc' &&
      request.payload?.loadOnly !== true
    );
    assertCondition(compile, 'TraceCC compile request was not sent.');
    assertCondition(
      compile.payload?.directCommand === true,
      `TraceCC must send a normalized fixed compiler plan: ${JSON.stringify(compile)}`
    );
    const args = compile.payload?.args as unknown[];
    assertCondition(
      Array.isArray(args) &&
        args[0] === 'tracecc-cxx' &&
        args.length === 5 &&
        args[1] === '/workspace/TraceCodeDriver.cpp' &&
        args[3] === '/usr',
      `TraceCC must use the fixed positional frontend ABI: ${JSON.stringify(args)}`
    );
    const source = (
      compile.payload?.project as {
        files?: Array<{ contents?: string }>;
      }
    )?.files?.[0]?.contents;
    assertCondition(
      source === 'int main() { return 0; }',
      'The generated runtime include should be supplied by the pinned PCH.'
    );
    const prewarm = worker.requests.find((request) =>
      request.type === 'prewarm-trusted-tracecc-assets'
    );
    assertCondition(
      prewarm?.payload?.traceccPchUrl === '/tracecc/narrow.pch',
      `Worker-owned prewarm must select only the narrow shard: ${JSON.stringify(prewarm)}`
    );
    await coordinator.compileTrusted({
      driverSource:
        'std::vector<std::string> values; int main() { return values.size(); }',
    });
    const broadCompile = worker.requests.find((request) =>
      request.type === 'compile-trusted-tracecc' &&
      request.payload?.traceccPchUrl === '/tracecc/broad.pch'
    );
    assertCondition(
      broadCompile &&
        !worker.requests.some((request) =>
          request.payload?.traceccPchUrl === '/tracecc/map.pch'
        ),
      'A broad compile must select the broad shard without loading the unused map shard.'
    );
    const runtimeInclude = '#include "tracecode_runtime.hpp"\n';
    await coordinator.compileTrusted({
      driverSource:
        runtimeInclude +
        ' '.repeat(50_000 - new TextEncoder().encode(runtimeInclude).byteLength),
    });
    const lastCompile = worker.requests.filter((request) =>
      request.type === 'compile-trusted-tracecc' &&
      request.payload?.loadOnly !== true
    ).at(-1);
    assertCondition(
      lastCompile?.payload?.traceccPchUrl === '/tracecc/narrow.pch',
      'Shard sizing must use the stripped source sent to Clang.'
    );
  } finally {
    coordinator.terminate();
  }
}

async function testAssetPrewarmRunsInsideCompilerWorker(): Promise<void> {
  TraceCCCompilerWorkerDouble.instances = [];
  const coordinator = new TraceCCCompilerService(options());
  try {
    await coordinator.prewarmAssets();
    const worker = TraceCCCompilerWorkerDouble.instances[0];
    assertCondition(
      worker &&
        worker.requests.some((request) =>
          request.type === 'prewarm-trusted-tracecc-assets' &&
          request.payload?.traceccPchUrl === '/tracecc/narrow.pch'
        ),
      'asset prewarm must run inside the trusted compiler Worker with the narrow shard'
    );
    assertCondition(
      !worker.requests.some((request) =>
        request.type === 'compile-trusted-tracecc'
      ),
      'asset prewarm must not compile or instantiate TraceCC'
    );
  } finally {
    coordinator.terminate();
  }
}

async function testCompilerRetirementIsIndependent(): Promise<void> {
  TraceCCCompilerWorkerDouble.instances = [];
  const coordinator = new TraceCCCompilerService(
    options({ maxCompilesPerWorker: 1 })
  );
  const first = await coordinator.compileTrusted({
    driverSource: 'int main() { return 0; }',
  });
  assertCondition(first.success === true, 'First TraceCC compile should succeed.');
  assertCondition(
    TraceCCCompilerWorkerDouble.instances[0]?.terminated,
    'The bounded compiler generation should retire after its compile.'
  );
  const second = await coordinator.compileTrusted({
    driverSource: 'int main() { return 1; }',
  });
  assertCondition(second.success === true, 'Replacement compiler should recover.');
  assertCondition(
    TraceCCCompilerWorkerDouble.instances.length === 2,
    'Compiler retirement must create one fresh trusted compiler Worker.'
  );
  coordinator.terminate();
}

async function testIdleCompilerRetirementRecoversBeforeNextCompile(): Promise<void> {
  TraceCCCompilerWorkerDouble.instances = [];
  const coordinator = new TraceCCCompilerService(options());
  try {
    await coordinator.warmup();
    const retiredWorker = TraceCCCompilerWorkerDouble.instances[0];
    assertCondition(retiredWorker, 'Warmup should create one compiler Worker.');

    retiredWorker.emitIdleTimeout();
    assertCondition(
      retiredWorker.terminated,
      'The compiler service must retire a Worker that reports idle timeout.'
    );

    const result = await coordinator.compileTrusted({
      driverSource: 'int main() { return 0; }',
    });
    assertCondition(
      result.success === true,
      'The first compile after idle retirement should recover without timing out.'
    );
    assertCondition(
      TraceCCCompilerWorkerDouble.instances.length === 2,
      'The first compile after idle retirement must create one fresh compiler Worker.'
    );
  } finally {
    coordinator.terminate();
  }
}

async function main(): Promise<void> {
  await testAssetPrewarmRunsInsideCompilerWorker();
  await testFixedReactorContract();
  await testCompilerRetirementIsIndependent();
  await testIdleCompilerRetirementRecoversBeforeNextCompile();
  console.log('TraceCC compiler service tests passed');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
