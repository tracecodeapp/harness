import {
  JavaWorkerClient,
  type JavaExecutionStyle,
  type JavaWorkerTraceResult,
} from '../../packages/harness-browser/src/java-worker-client';
import type {
  TraceExecutionOptions,
} from '../../packages/harness-core/src/runtime-types';

interface CheerpJSemanticTraceRequest {
  code: string;
  functionName: string;
  inputs: Record<string, unknown>;
  traceOptions?: TraceExecutionOptions;
  executionStyle: JavaExecutionStyle;
}

declare global {
  var runCheerpJSemanticTrace:
    | ((request: CheerpJSemanticTraceRequest) => Promise<JavaWorkerTraceResult>)
    | undefined;
  var closeCheerpJSemanticTrace: (() => void) | undefined;
}

const client = new JavaWorkerClient({
  workerUrl: '/workers/java/java-worker.js',
  debug: false,
  compileCacheLimit: 16,
  tracingTimeoutMs: 120_000,
  runtimeAssets: {
    loaderUrl: 'https://cjrtnc.leaningtech.com/4.2/loader.js',
    helperJarUrl: '/app/workers/vendor/java-browser-helper.jar',
    compilerJarUrl: '/app/workers/vendor/jdk.compiler-17.jar',
    rewriterJarUrl: '/app/workers/vendor/java-rewriter.jar',
    parserJarUrl: '/app/workers/vendor/javaparser-core-3.25.10.jar',
  },
});

globalThis.runCheerpJSemanticTrace = (request) =>
  client.executeWithTracing({
    code: request.code,
    functionName: request.functionName,
    inputs: request.inputs,
    traceOptions: request.traceOptions,
    executionStyle: request.executionStyle,
  });

globalThis.closeCheerpJSemanticTrace = () => {
  client.terminate();
};
