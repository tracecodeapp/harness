import type {
  TraceKernelSyscallRequest,
  TraceKernelSyscallValue,
} from "@tracecode/tracekernel";

import {
  BrowserJavaScriptProjectExecutionState,
  JavaScriptProjectCommandRequest,
} from "../browser/contracts";

import {
  normalizeProjectPath,
  workspaceCwdPath,
} from "./path-normalization";

export function processArgvForRequest(request: JavaScriptProjectCommandRequest): string[] {
  const executable = '/usr/local/bin/node';
  if (request.source === 'argument') {
    return [executable, ...request.args];
  }

  if (request.source === 'stdin') {
    return [executable, '-', ...request.args];
  }

  const requestedScriptPath = request.scriptPath || '<anonymous>';
  const scriptPath = requestedScriptPath.startsWith('/')
    ? requestedScriptPath
    : `${request.project.workspaceRoot ?? request.project.cwd ?? '/workspace'}/${normalizeProjectPath([
        workspaceCwdPath(request),
        requestedScriptPath,
      ].filter(Boolean).join('/'))}`;
  return [executable, scriptPath, ...request.args];
}

export function createTraceKernelApi(
  executionState: BrowserJavaScriptProjectExecutionState
) {
  type WatchdogSignal = 'SIGTERM' | 'SIGKILL';
  type WatchdogStatus = Readonly<{
    armed: boolean;
    timeoutMs?: number;
    signal?: WatchdogSignal;
    deadlineAt?: number;
  }>;

  const dispatchWatchdog = (
    request: Extract<TraceKernelSyscallRequest, { op: 'watchdog' }>
  ): WatchdogStatus => {
    if (!executionState.kernelSyscalls) {
      throw Object.assign(
        new Error('ENOSYS: TraceKernel process controls are unavailable'),
        { code: 'ENOSYS' }
      );
    }
    const result = executionState.kernelSyscalls.dispatchSync(request);
    if (result.ok === false) {
      throw Object.assign(new Error(result.error.message), {
        code: result.error.code,
      });
    }
    if (result.value.op !== 'watchdog') {
      throw Object.assign(
        new Error(`EPROTO: expected watchdog response, received ${result.value.op}`),
        { code: 'EPROTO' }
      );
    }
    return Object.freeze({
      armed: result.value.armed,
      ...(result.value.timeoutMs === undefined
        ? {}
        : { timeoutMs: result.value.timeoutMs }),
      ...(result.value.signal === undefined
        ? {}
        : { signal: result.value.signal }),
      ...(result.value.deadlineAt === undefined
        ? {}
        : { deadlineAt: result.value.deadlineAt }),
    });
  };

  const dispatchTerminal = <
    Operation extends
      | 'isatty'
      | 'tcgetpgrp'
      | 'tcsetpgrp'
      | 'tcgetwinsize'
      | 'tcsetwinsize'
  >(
    request: Extract<TraceKernelSyscallRequest, { op: Operation }>
  ): Extract<TraceKernelSyscallValue, { op: Operation }> => {
    const operation = (request as { readonly op: Operation }).op;
    if (!executionState.kernelSyscalls) {
      throw Object.assign(
        new Error('ENOSYS: TraceKernel terminal controls are unavailable'),
        { code: 'ENOSYS' }
      );
    }
    const result = executionState.kernelSyscalls.dispatchSync(request);
    if (result.ok === false) {
      throw Object.assign(new Error(result.error.message), {
        code: result.error.code,
      });
    }
    if (result.value.op !== operation) {
      throw Object.assign(
        new Error(
          `EPROTO: expected ${operation} response, received ${result.value.op}`
        ),
        { code: 'EPROTO' }
      );
    }
    return result.value as Extract<
      TraceKernelSyscallValue,
      { op: Operation }
    >;
  };

  return Object.freeze({
    watchdog: Object.freeze({
      arm: (
        timeoutMs: number,
        options: { signal?: WatchdogSignal } = {}
      ): WatchdogStatus => dispatchWatchdog({
        op: 'watchdog',
        action: 'arm',
        timeoutMs,
        ...(options.signal ? { signal: options.signal } : {}),
      }),
      pet: (): WatchdogStatus => dispatchWatchdog({
        op: 'watchdog',
        action: 'pet',
      }),
      disarm: (): WatchdogStatus => dispatchWatchdog({
        op: 'watchdog',
        action: 'disarm',
      }),
      status: (): WatchdogStatus => dispatchWatchdog({
        op: 'watchdog',
        action: 'status',
      }),
    }),
    terminal: Object.freeze({
      isatty: (fd: number): boolean =>
        dispatchTerminal({ op: 'isatty', fd }).isTerminal,
      foregroundProcessGroup: (fd = 0): number =>
        dispatchTerminal({ op: 'tcgetpgrp', fd }).pgid,
      setForegroundProcessGroup: (pgid: number, fd = 0): number =>
        dispatchTerminal({ op: 'tcsetpgrp', fd, pgid }).pgid,
      windowSize: (fd = 0): Readonly<{ rows: number; columns: number }> => {
        const size = dispatchTerminal({ op: 'tcgetwinsize', fd });
        return Object.freeze({ rows: size.rows, columns: size.columns });
      },
      setWindowSize: (
        rows: number,
        columns: number,
        fd = 0
      ): Readonly<{ rows: number; columns: number }> => {
        const size = dispatchTerminal({
          op: 'tcsetwinsize',
          fd,
          rows,
          columns,
        });
        return Object.freeze({ rows: size.rows, columns: size.columns });
      },
    }),
  });
}
