declare module '@tracecode/tracejvm' {
  export type TraceJVMBinaryFile =
    import('../../packages/runtime-java/src/java-project').JavaProjectBinaryFile;
  export type TraceJVMCompileResult =
    import('../../packages/runtime-java/src/java-project').JavaProjectCompileResult;

  export interface TraceJVMExecutionDiagnostics {
    bytecodeProfile?: unknown;
    diagnosticError?: string;
  }

  export type TraceJVMExecuteResult =
    import('../../packages/runtime-java/src/java-project').JavaProjectExecuteResult & {
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
      host?: import('../../packages/runtime-java/src/java-project').JavaProjectHost;
    });

    initialize(signal?: AbortSignal): Promise<{ initializeMs: number }>;
    compile(
      request: import('../../packages/runtime-java/src/java-project').JavaProjectCompileRequest
    ): Promise<
      import('../../packages/runtime-java/src/java-project').JavaProjectCompileResult
    >;
    run(
      request: import('../../packages/runtime-java/src/java-project').JavaProjectRunRequest & {
        diagnostics?: {
          bytecodeProfile?: boolean;
        };
      }
    ): Promise<TraceJVMExecuteResult>;
    terminate(): void;
  }
}
