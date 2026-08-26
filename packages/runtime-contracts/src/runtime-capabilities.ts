export type Language = 'python' | 'javascript' | 'typescript' | 'java' | 'csharp' | 'cpp';

export type RuntimeExecutionStyle = 'function' | 'solution-method' | 'ops-class';

export type RuntimeMaturity = 'experimental' | 'beta' | 'stable';

export type RuntimeExecutionPipeline = 'interpreted' | 'transpiled' | 'compiled';

export type RuntimeCompileCost = 'none' | 'low' | 'high';

export type RuntimeExecutionIsolationPolicy = 'safe' | 'unsafe-reuse';

export type RuntimeExecutionIsolationBoundary =
  | 'fresh-worker'
  | 'fresh-program-instance'
  | 'guarded-fresh-namespace'
  | 'interpreter-cleanup'
  | 'fresh-class-loader'
  | 'fresh-assembly-load-context';

export interface RuntimeExecutionIsolationSupport {
  /**
   * Whether separate untrusted executions may safely share the initialized
   * browser runtime. False means the consumer must replace the containing
   * runtime (for example, its Worker or browser context) between principals.
   */
  safeForUntrustedReuse: boolean;
  /** The strongest isolation boundary created between executions. */
  boundary: RuntimeExecutionIsolationBoundary;
  /** The weaker boundary exposed only through an explicit unsafe-reuse policy. */
  unsafeReuseBoundary?: RuntimeExecutionIsolationBoundary;
  /** The safe boundary used between cases inside an admitted algorithm batch. */
  algorithmBatchBoundary?: RuntimeExecutionIsolationBoundary;
}

export type RuntimeProjectIoTier = 'unsupported' | 'final-diff' | 'bridged-live' | 'native-live';

export type RuntimeProjectIoEnvironment = 'browser' | 'node';

export interface RuntimeProjectIoSupport {
  tier: RuntimeProjectIoTier;
  supported: boolean;
  kernelFs: boolean;
  liveMutationEvents: boolean;
  finalDiff: boolean;
  providerLiveInterception: boolean;
  streamingStdio: boolean;
  liveStdin: boolean;
  deviceFiles: boolean;
}

export interface RuntimeProjectIoCapabilityRow {
  language: Language;
  browser: RuntimeProjectIoSupport;
  node: RuntimeProjectIoSupport;
  notes: readonly string[];
  limitations: readonly string[];
}

export interface RuntimeCapabilities {
  execution: {
    compilation: {
      required: boolean;
      pipeline: RuntimeExecutionPipeline;
      cost: RuntimeCompileCost;
    };
    styles: {
      function: boolean;
      solutionMethod: boolean;
      opsClass: boolean;
      script: boolean;
    };
    /** Which `RuntimeExecutionLimits` knobs this runtime honors. */
    limits: RuntimeExecutionLimitSupport;
    timeouts: {
      clientTimeouts: boolean;
      runtimeTimeouts: boolean;
    };
    isolation: RuntimeExecutionIsolationSupport;
  };
  project: {
    workspace: {
      supported: boolean;
      kernelFs: boolean;
      virtualDevices: boolean;
      virtualProc: boolean;
    };
    filesystem: {
      finalDiff: boolean;
      liveMutationEvents: boolean;
      providerLiveInterception: boolean;
      binaryFiles: boolean;
      directories: boolean;
    };
    stdio: {
      liveStdin: boolean;
      outputEvents: boolean;
      deviceFiles: boolean;
    };
  };
  tracing: {
    supported: boolean;
    /**
     * The runtime can trace multiple isolated cases through one prepared
     * program without recompiling or reloading its engine per case.
     */
    batching?: boolean;
    events: {
      line: boolean;
      call: boolean;
      return: boolean;
      exception: boolean;
      stdout: boolean;
      timeout: boolean;
    };
    controls: {
      maxTraceSteps: boolean;
      maxLineEvents: boolean;
      maxSingleLineHits: boolean;
      maxStoredEvents: boolean;
      maxTraceBytes: boolean;
      minimalTrace: boolean;
    };
    fidelity: {
      preciseLineMapping: boolean;
      stableFunctionNames: boolean;
      callStack: boolean;
    };
  };
  diagnostics: {
    compileErrors: boolean;
    runtimeErrors: boolean;
    mappedErrorLines: boolean;
    stackTraces: boolean;
  };
  structures: {
    treeNodeRefs: boolean;
    listNodeRefs: boolean;
    mapSerialization: boolean;
    setSerialization: boolean;
    graphSerialization: boolean;
    cycleReferences: boolean;
  };
}

/**
 * Caller-tunable execution limits. The runtime enforces what it can and
 * reports limit trips structurally as a `limit` outcome with a `reason`;
 * interpreting a trip as a judge verdict is the caller's responsibility.
 *
 * Guest-enforced limits may be clamped to runtime-specific safety floors.
 * Languages declare which limits they honor via `capabilities.execution.limits`.
 */
export interface RuntimeExecutionLimits {
  /** Client-side wall-clock deadline per case, in milliseconds. */
  wallClockMs?: number;
  /** Guest-enforced ceiling on executed line events (`line-limit`). */
  maxLineEvents?: number;
  /** Guest-enforced ceiling on hits of a single line (`single-line-limit`). */
  maxSingleLineHits?: number;
  /** Guest-enforced call-depth ceiling (`recursion-limit`). */
  maxCallDepth?: number;
  /** Guest-enforced memory ceiling in bytes (`memory-limit`). */
  maxMemoryBytes?: number;
}

export interface RuntimeExecutionLimitSupport {
  wallClock: boolean;
  lineEvents: boolean;
  singleLineHits: boolean;
  callDepth: boolean;
  memory: boolean;
}

export interface TraceBudget {
  maxTraceSteps?: number;
  maxLineEvents?: number;
  maxSingleLineHits?: number;
  maxStoredEvents?: number;
  /**
   * Maximum UTF-8 bytes retained for normalized trace events. Runtimes may
   * clamp caller values to a lower hard safety ceiling.
   */
  maxTraceBytes?: number;
  maxPathDepth?: number;
}

export interface TraceExecutionOptions extends TraceBudget {
  minimalTrace?: boolean;
}

export interface LanguageRuntimeProfile {
  language: Language;
  maturity: RuntimeMaturity;
  capabilities: RuntimeCapabilities;
  notes?: string[];
}
