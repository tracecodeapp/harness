/**
 * Declared request message types for each browser worker protocol.
 *
 * This is the contract between a worker client (sender) and its worker script
 * (handler). The runtime-contract suite enforces both directions against the
 * sources: every message a client sends must be declared here, and every
 * declared message must have a handler in the corresponding worker script —
 * so renaming or removing a handler without updating the client (or vice
 * versa) fails CI instead of failing at runtime.
 *
 * Sub-protocols are intentionally out of scope: kernel-HTTP messages
 * (`kernel-http-*`) are owned by the kernel-HTTP bridge modules, and
 * compiler-relay replies (`java-compile-response`, `compile-response`) are
 * responses, not requests.
 */

export type BrowserWorkerProtocolLanguage = 'python' | 'javascript' | 'java' | 'csharp' | 'cpp';

export const WORKER_REQUEST_MESSAGES: Readonly<Record<BrowserWorkerProtocolLanguage, readonly string[]>> = {
  python: [
    'init',
    'warmup',
    'status',
    'analyze-code',
    'execute-code',
    'execute-code-batch',
    'execute-with-tracing',
    'execute-project-python',
  ],
  javascript: [
    'init',
    'warmup',
    'prepare-execution',
    'prewarm-executor',
    'execute-code',
    'execute-code-batch',
    'execute-with-tracing',
  ],
  java: [
    'init',
    'warmup',
    'reset-persistent-storage',
    'execute-code',
    'execute-code-batch',
    'execute-with-tracing',
    'execute-project-java',
  ],
  csharp: [
    'init',
    'warmup',
    'execute-code',
    'execute-code-batch',
    'execute-with-tracing',
    'prepare-program',
    'execute-prepared-code',
    'execute-prepared-trace',
    'dispose-prepared-program',
    'execute-project-csharp',
  ],
  cpp: [
    'init',
    'warmup',
    'compile-run',
    'compile-run-batch',
    'execute-with-tracing',
    'execute-trace-batch',
    'execute-project-cpp',
  ],
};
