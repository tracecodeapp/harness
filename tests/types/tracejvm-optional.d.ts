declare module '@tracecode/tracejvm' {
  export type TraceJVMBinaryFile =
    import('../../packages/harness-java/src/tracejvm-project').TraceJVMProjectBinaryFile;
  export type TraceJVMCompileResult =
    import('../../packages/harness-java/src/tracejvm-project').TraceJVMProjectCompileResult;

  export interface TraceJVMExecutionDiagnostics {
    bytecodeProfile?: unknown;
    diagnosticError?: string;
  }

  export type TraceJVMExecuteResult =
    import('../../packages/harness-java/src/tracejvm-project').TraceJVMProjectExecuteResult & {
      diagnostics?: TraceJVMExecutionDiagnostics;
    };

  export interface TraceJVMWorkerLike {
    postMessage(message: unknown): void;
    addEventListener(
      type: 'message' | 'error',
      listener: (event: MessageEvent | ErrorEvent) => void
    ): void;
    removeEventListener(
      type: 'message' | 'error',
      listener: (event: MessageEvent | ErrorEvent) => void
    ): void;
    terminate(): void;
  }

  export class TraceJVMWorkerClient {
    constructor(options: {
      engine: {
        assets: {
          runtimeProfileBaseUrls: Readonly<Record<string, string>>;
          wasmUrl: string;
        };
        workingDirectory?: string;
        hostStandardDescriptors?: boolean;
        runtimeProfile?: string;
        retirementAfterExecutions?: number;
        experiments?: {
          hotAot?: boolean;
        };
      };
      createWorker: () => TraceJVMWorkerLike;
      host?: import('../../packages/harness-java/src/tracejvm-project').TraceJVMProjectHost;
    });

    initialize(signal?: AbortSignal): Promise<{ initializeMs: number }>;
    compile(
      request: import('../../packages/harness-java/src/tracejvm-project').TraceJVMProjectCompileRequest
    ): Promise<
      import('../../packages/harness-java/src/tracejvm-project').TraceJVMProjectCompileResult
    >;
    run(
      request: import('../../packages/harness-java/src/tracejvm-project').TraceJVMProjectRunRequest & {
        diagnostics?: {
          bytecodeProfile?: boolean;
        };
      }
    ): Promise<TraceJVMExecuteResult>;
    terminate(): void;
  }
}
