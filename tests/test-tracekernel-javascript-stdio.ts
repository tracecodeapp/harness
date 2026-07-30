#!/usr/bin/env npx tsx

import {
  createRuntimeCommandStdinPipeFromText,
  runtimeCommandStdinPipeRemainingBytes,
} from '../packages/runtime-core/src/index';
import {
  runBrowserJavaScriptProjectRequest,
  type BrowserJavaScriptProjectExecutionState,
  type JavaScriptProjectCommandRequest,
} from '../packages/runtime-javascript/src/project-browser';
import type {
  TraceKernelSyscallRequest,
  TraceKernelSyscallResult,
} from '../packages/tracekernel/src/index';

function assertCondition(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

async function main(): Promise<void> {
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  const kernelInput = encoder.encode('kernel-fd-zero\n');
  const legacyInput = createRuntimeCommandStdinPipeFromText('legacy-pipe\n');
  const writes = new Map<number, Uint8Array[]>();
  let readCount = 0;

  const dispatchSync = (
    request: TraceKernelSyscallRequest
  ): TraceKernelSyscallResult => {
    if (request.op === 'isatty') {
      return {
        ok: true,
        value: { op: 'isatty', isTerminal: false },
      };
    }
    if (request.op === 'read') {
      assertCondition(request.fd === 0, `unexpected read fd ${request.fd}`);
      const bytes = readCount++ === 0 ? kernelInput : new Uint8Array();
      return {
        ok: true,
        value: { op: 'read', bytes },
      };
    }
    if (request.op === 'write') {
      const chunks = writes.get(request.fd) ?? [];
      chunks.push(request.bytes.slice());
      writes.set(request.fd, chunks);
      return {
        ok: true,
        value: { op: 'write', bytesWritten: request.bytes.byteLength },
      };
    }
    return {
      ok: false,
      error: {
        code: 'ENOSYS',
        message: `ENOSYS: unexpected ${request.op} syscall`,
      },
    };
  };

  const request: JavaScriptProjectCommandRequest = {
    code: [
      'const fs = require("node:fs");',
      'const input = fs.readFileSync(0, "utf8");',
      'fs.writeFileSync(1, "stdout:" + input);',
      'fs.writeFileSync(2, "stderr:" + input);',
    ].join('\n'),
    source: 'argument',
    scriptPath: '',
    args: [],
    cwd: '/workspace',
    env: {},
    stdinPipe: legacyInput,
    project: {
      cwd: '/workspace',
      files: [],
      kernelDevices: [
        {
          path: '/dev/stdin',
          readable: true,
          writable: false,
          inputDevice: '/dev/stdin',
        },
        {
          path: '/dev/stdout',
          readable: false,
          writable: true,
          outputDevice: '/dev/stdout',
        },
        {
          path: '/dev/stderr',
          readable: false,
          writable: true,
          outputDevice: '/dev/stderr',
        },
      ],
    },
  };
  const executionState: BrowserJavaScriptProjectExecutionState = {
    cancelled: false,
    abortController: new AbortController(),
    kernelSyscalls: { dispatchSync },
  };

  const result = await runBrowserJavaScriptProjectRequest(
    request,
    { allowDynamicEval: true },
    executionState
  );
  const output = (fd: number): string =>
    decoder.decode(
      Uint8Array.from((writes.get(fd) ?? []).flatMap((chunk) => [...chunk]))
    );

  assertCondition(
    result.exitCode === 0,
    `JavaScript descriptor stdio execution failed: ${JSON.stringify(result)}`
  );
  assertCondition(
    output(1) === 'stdout:kernel-fd-zero\n' &&
      output(2) === 'stderr:kernel-fd-zero\n',
    `JavaScript stdio did not use TraceKernel descriptors: ${JSON.stringify({
      stdout: output(1),
      stderr: output(2),
    })}`
  );
  assertCondition(
    readCount === 1,
    `JavaScript fd 0 issued an unexpected number of kernel reads: ${readCount}`
  );
  assertCondition(
    runtimeCommandStdinPipeRemainingBytes(legacyInput) ===
      encoder.encode('legacy-pipe\n').byteLength,
    'JavaScript consumed the legacy stdin compatibility pipe while kernel fd 0 was available'
  );

  console.log('TraceKernel JavaScript descriptor stdio tests passed');
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});
