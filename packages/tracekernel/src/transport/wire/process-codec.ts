import type {
  TraceKernelProcessPhase,
  TraceKernelSignal,
  TraceKernelTerminatingSignal,
} from '../../model';
import type {
  TraceKernelSyscallRequest,
  TraceKernelSyscallValue,
  TraceKernelProcessInfo,
} from '../../syscalls';
import {
  BinaryFrameReader,
  BinaryFrameWriter,
  TraceKernelSyscallOperation,
  TraceKernelTransportError,
} from './protocol';

/** Binary payload codec for process, job-control, terminal, and watch syscalls. */
function traceKernelSignalCode(signal: TraceKernelSignal): number {
  switch (signal) {
    case 'SIGINT':
      return 1;
    case 'SIGTERM':
      return 2;
    case 'SIGKILL':
      return 3;
    case 'SIGHUP':
      return 4;
    case 'SIGQUIT':
      return 5;
    case 'SIGWINCH':
      return 6;
  }
}

function readTraceKernelSignal(
  reader: BinaryFrameReader,
  context: string
): TraceKernelSignal {
  const code = reader.u8();
  switch (code) {
    case 1:
      return 'SIGINT';
    case 2:
      return 'SIGTERM';
    case 3:
      return 'SIGKILL';
    case 4:
      return 'SIGHUP';
    case 5:
      return 'SIGQUIT';
    case 6:
      return 'SIGWINCH';
    default:
      throw new TraceKernelTransportError(
        'EPROTO',
        `invalid ${context} signal code ${code}`
      );
  }
}

function readTraceKernelTerminatingSignal(
  reader: BinaryFrameReader,
  context: string
): TraceKernelTerminatingSignal {
  const signal = readTraceKernelSignal(reader, context);
  if (signal === 'SIGWINCH') {
    throw new TraceKernelTransportError(
      'EPROTO',
      `${context} cannot use non-terminating signal SIGWINCH.`
    );
  }
  return signal;
}

function processPhaseCode(phase: TraceKernelProcessPhase): number {
  return phase === 'created'
    ? 1
    : phase === 'starting'
      ? 2
      : phase === 'running'
        ? 3
        : phase === 'exiting'
          ? 4
          : 5;
}

function readProcessPhase(
  reader: BinaryFrameReader
): TraceKernelProcessPhase {
  const code = reader.u8();
  if (code < 1 || code > 5) {
    throw new TraceKernelTransportError(
      'EPROTO',
      `invalid process phase code ${code}`
    );
  }
  return code === 1
    ? 'created'
    : code === 2
      ? 'starting'
      : code === 3
        ? 'running'
        : code === 4
          ? 'exiting'
          : 'exited';
}

function writeProcessInfo(
  writer: BinaryFrameWriter,
  process: TraceKernelProcessInfo
): void {
  writer.i32(process.pid);
  writer.i32(process.ppid);
  writer.i32(process.pgid);
  writer.i32(process.sid);
  writer.u8(processPhaseCode(process.phase));
  writer.string(process.runtime);
  writer.string(process.command);
  writer.u32(process.args.length);
  for (const argument of process.args) writer.string(argument);
  writer.u8(process.startedAt === undefined ? 0 : 1);
  if (process.startedAt !== undefined) writer.f64(process.startedAt);
}

function readProcessInfo(
  reader: BinaryFrameReader
): TraceKernelProcessInfo {
  const pid = reader.i32();
  const ppid = reader.i32();
  const pgid = reader.i32();
  const sid = reader.i32();
  const phase = readProcessPhase(reader);
  const runtime = reader.string();
  const command = reader.string();
  const argumentCount = reader.u32();
  const args: string[] = [];
  for (let index = 0; index < argumentCount; index += 1) {
    args.push(reader.string());
  }
  const hasStartedAt = reader.u8();
  if (hasStartedAt > 1) {
    throw new TraceKernelTransportError(
      'EPROTO',
      `invalid process start-time flag ${hasStartedAt}`
    );
  }
  return Object.freeze({
    pid,
    ppid,
    pgid,
    sid,
    phase,
    runtime,
    command,
    args: Object.freeze(args),
    ...(hasStartedAt ? { startedAt: reader.f64() } : {}),
  });
}

function writeSpawnStdioMode(
  writer: BinaryFrameWriter,
  mode: 'pipe' | 'inherit' | 'ignore' | undefined
): void {
  writer.u8(
    mode === undefined
      ? 0
      : mode === 'pipe'
        ? 1
        : mode === 'inherit'
          ? 2
          : 3
  );
}

function readSpawnStdioMode(
  reader: BinaryFrameReader
): 'pipe' | 'inherit' | 'ignore' | undefined {
  const encoded = reader.u8();
  if (encoded > 3) {
    throw new TraceKernelTransportError(
      'EPROTO',
      `invalid spawn stdio mode ${encoded}`
    );
  }
  return encoded === 0
    ? undefined
    : encoded === 1
      ? 'pipe'
      : encoded === 2
        ? 'inherit'
        : 'ignore';
}

export function encodeProcessRequest(
  writer: BinaryFrameWriter,
  request: TraceKernelSyscallRequest
): boolean {
  switch (request.op) {
    case 'pipe':
      writer.u32(request.options?.capacityChunks ?? 0);
      writer.u8(request.options?.closeOnExec === true ? 1 : 0);
      writer.u8(request.options?.nonblocking === true ? 1 : 0);
      break;
    case 'watch':
      writer.string(request.path);
      writer.u8(request.options?.recursive === true ? 1 : 0);
      writer.u32(request.options?.capacityEvents ?? 0);
      break;
    case 'watchdog':
      writer.u8(
        request.action === 'arm'
          ? 1
          : request.action === 'pet'
            ? 2
            : request.action === 'disarm'
              ? 3
              : 4
      );
      writer.u8(request.timeoutMs === undefined ? 0 : 1);
      if (request.timeoutMs !== undefined) writer.u32(request.timeoutMs);
      writer.u8(
        request.signal === undefined
          ? 0
          : request.signal === 'SIGTERM'
            ? 1
            : 2
      );
      break;
    case 'spawn':
      {
      writer.string(request.runtime);
      writer.string(request.command);
      writer.u32(request.args?.length ?? 0);
      for (const arg of request.args ?? []) writer.string(arg);
      writer.u8(request.cwd === undefined ? 0 : 1);
      if (request.cwd !== undefined) writer.string(request.cwd);
      const environment = Object.entries(request.env ?? {});
      writer.u32(environment.length);
      for (const [name, value] of environment) {
        writer.string(name);
        writer.string(value);
      }
      writer.u8(
        request.inheritDescriptors === 'all'
          ? 1
          : request.inheritDescriptors === undefined
            ? 0
            : 2
      );
      if (
        request.inheritDescriptors !== undefined &&
        request.inheritDescriptors !== 'all'
      ) {
        writer.u32(request.inheritDescriptors.length);
        for (const fd of request.inheritDescriptors) writer.i32(fd);
      }
      writer.u8(request.processGroupId === undefined ? 0 : 1);
      if (request.processGroupId !== undefined) writer.i32(request.processGroupId);
      writer.u8(request.sessionId === undefined ? 0 : 1);
      if (request.sessionId !== undefined) writer.i32(request.sessionId);
      writeSpawnStdioMode(writer, request.stdio?.stdin);
      writeSpawnStdioMode(writer, request.stdio?.stdout);
      writeSpawnStdioMode(writer, request.stdio?.stderr);
      writer.u32(request.descriptorActions?.length ?? 0);
      for (const action of request.descriptorActions ?? []) {
        writer.u8(action.op === 'dup2' ? 1 : 2);
        writer.i32(action.fd);
        if (action.op === 'dup2') writer.i32(action.targetFd);
      }
      writer.u32(request.descriptorMappings?.length ?? 0);
      for (const mapping of request.descriptorMappings ?? []) {
        writer.i32(mapping.parentFd);
        writer.i32(mapping.childFd);
      }
      break;
          }
    case 'wait':
      writer.i32(request.pid);
      writer.u8(request.noHang ? 1 : 0);
      break;
    case 'identity':
    case 'processInfo':
      writer.u8(request.pid === undefined ? 0 : 1);
      if (request.pid !== undefined) writer.i32(request.pid);
      break;
    case 'processList':
    case 'environment':
      break;
    case 'kill':
      writer.i32(request.pid);
      writer.u8(traceKernelSignalCode(request.signal));
      break;
    case 'setsid':
      break;
    case 'setpgid':
      writer.i32(request.pid);
      writer.i32(request.pgid);
      break;
    case 'isatty':
    case 'tcgetpgrp':
    case 'tcgetwinsize':
      writer.i32(request.fd);
      break;
    case 'tcsetpgrp':
      writer.i32(request.fd);
      writer.i32(request.pgid);
      break;
    case 'tcsetwinsize':
      writer.i32(request.fd);
      writer.u32(request.rows);
      writer.u32(request.columns);
      break;
    case 'poll':
      writer.u32(request.entries.length);
      for (const entry of request.entries) {
        writer.i32(entry.fd);
        writer.u8((entry.read ? 1 : 0) | (entry.write ? 2 : 0));
      }
      writer.u8(request.timeoutMs === undefined ? 0 : 1);
      if (request.timeoutMs !== undefined) writer.f64(request.timeoutMs);
      break;
    default:
      return false;
  }
  return true;
}

export function decodeProcessRequest(
  reader: BinaryFrameReader,
  operation: TraceKernelSyscallOperation
): TraceKernelSyscallRequest | undefined {
  let request: TraceKernelSyscallRequest;
  switch (operation) {
    case 'pipe':
      {
      const capacityChunks = reader.u32();
      const closeOnExec = reader.u8();
      const nonblocking = reader.u8();
      if (closeOnExec > 1) {
        throw new TraceKernelTransportError(
          'EPROTO',
          'Invalid pipe close-on-exec flag'
        );
      }
      if (nonblocking > 1) {
        throw new TraceKernelTransportError(
          'EPROTO',
          'Invalid pipe nonblocking flag'
        );
      }
      request = {
        op: 'pipe',
        ...(capacityChunks === 0 && closeOnExec === 0 && nonblocking === 0
          ? {}
          : {
              options: {
                ...(capacityChunks === 0 ? {} : { capacityChunks }),
                ...(closeOnExec === 1 ? { closeOnExec: true } : {}),
                ...(nonblocking === 1 ? { nonblocking: true } : {}),
              },
            }),
      };
      break;
          }
    case 'watch':
      {
      const path = reader.string();
      const recursive = reader.u8();
      if (recursive > 1) {
        throw new TraceKernelTransportError(
          'EPROTO',
          `invalid watch recursive flag ${recursive}`
        );
      }
      const capacityEvents = reader.u32();
      request = {
        op: 'watch',
        path,
        ...(!recursive && capacityEvents === 0
          ? {}
          : {
              options: {
                ...(recursive ? { recursive: true } : {}),
                ...(capacityEvents === 0 ? {} : { capacityEvents }),
              },
            }),
      };
      break;
          }
    case 'watchdog':
      {
      const actionCode = reader.u8();
      if (actionCode < 1 || actionCode > 4) {
        throw new TraceKernelTransportError(
          'EPROTO',
          `invalid watchdog action ${actionCode}`
        );
      }
      const hasTimeout = reader.u8();
      if (hasTimeout > 1) {
        throw new TraceKernelTransportError(
          'EPROTO',
          `invalid watchdog timeout flag ${hasTimeout}`
        );
      }
      const timeoutMs = hasTimeout ? reader.u32() : undefined;
      const signalCode = reader.u8();
      if (signalCode > 2) {
        throw new TraceKernelTransportError(
          'EPROTO',
          `invalid watchdog signal ${signalCode}`
        );
      }
      request = {
        op: 'watchdog',
        action: actionCode === 1
          ? 'arm'
          : actionCode === 2
            ? 'pet'
            : actionCode === 3
              ? 'disarm'
              : 'status',
        ...(timeoutMs === undefined ? {} : { timeoutMs }),
        ...(signalCode === 0
          ? {}
          : { signal: signalCode === 1 ? 'SIGTERM' : 'SIGKILL' }),
      };
      break;
          }
    case 'spawn':
      {
      const runtime = reader.string();
      const command = reader.string();
      const argsLength = reader.u32();
      const args: string[] = [];
      for (let index = 0; index < argsLength; index += 1) {
        args.push(reader.string());
      }
      const hasCwd = reader.u8();
      if (hasCwd > 1) {
        throw new TraceKernelTransportError('EPROTO', `invalid spawn cwd flag ${hasCwd}`);
      }
      const cwd = hasCwd ? reader.string() : undefined;
      const environmentLength = reader.u32();
      const env: Record<string, string> = {};
      for (let index = 0; index < environmentLength; index += 1) {
        env[reader.string()] = reader.string();
      }
      const inheritance = reader.u8();
      if (inheritance > 2) {
        throw new TraceKernelTransportError(
          'EPROTO',
          `invalid descriptor inheritance mode ${inheritance}`
        );
      }
      let inheritDescriptors: 'all' | readonly number[] | undefined;
      if (inheritance === 1) {
        inheritDescriptors = 'all';
      } else if (inheritance === 2) {
        const descriptorCount = reader.u32();
        const descriptors: number[] = [];
        for (let index = 0; index < descriptorCount; index += 1) {
          descriptors.push(reader.i32());
        }
        inheritDescriptors = Object.freeze(descriptors);
      }
      const hasProcessGroupId = reader.u8();
      if (hasProcessGroupId > 1) {
        throw new TraceKernelTransportError(
          'EPROTO',
          `invalid spawn process-group flag ${hasProcessGroupId}`
        );
      }
      const processGroupId = hasProcessGroupId ? reader.i32() : undefined;
      const hasSessionId = reader.u8();
      if (hasSessionId > 1) {
        throw new TraceKernelTransportError(
          'EPROTO',
          `invalid spawn session flag ${hasSessionId}`
        );
      }
      const sessionId = hasSessionId ? reader.i32() : undefined;
      const stdin = readSpawnStdioMode(reader);
      const stdout = readSpawnStdioMode(reader);
      const stderr = readSpawnStdioMode(reader);
      const stdio = stdin === undefined && stdout === undefined && stderr === undefined
        ? undefined
        : Object.freeze({
            ...(stdin === undefined ? {} : { stdin }),
            ...(stdout === undefined ? {} : { stdout }),
            ...(stderr === undefined ? {} : { stderr }),
          });
      const descriptorActionCount = reader.u32();
      const descriptorActions: Array<
        NonNullable<Extract<TraceKernelSyscallRequest, { op: 'spawn' }>['descriptorActions']>[number]
      > = [];
      for (let index = 0; index < descriptorActionCount; index += 1) {
        const action = reader.u8();
        const fd = reader.i32();
        if (action === 1) {
          descriptorActions.push({ op: 'dup2', fd, targetFd: reader.i32() });
        } else if (action === 2) {
          descriptorActions.push({ op: 'close', fd });
        } else {
          throw new TraceKernelTransportError(
            'EPROTO',
            `invalid spawn descriptor action ${action}`
          );
        }
      }
      const descriptorMappingCount = reader.u32();
      const descriptorMappings: Array<
        NonNullable<Extract<TraceKernelSyscallRequest, { op: 'spawn' }>['descriptorMappings']>[number]
      > = [];
      for (let index = 0; index < descriptorMappingCount; index += 1) {
        descriptorMappings.push({
          parentFd: reader.i32(),
          childFd: reader.i32(),
        });
      }
      request = {
        op: 'spawn',
        runtime,
        command,
        ...(args.length === 0 ? {} : { args: Object.freeze(args) }),
        ...(cwd === undefined ? {} : { cwd }),
        ...(environmentLength === 0 ? {} : { env: Object.freeze(env) }),
        ...(inheritDescriptors === undefined ? {} : { inheritDescriptors }),
        ...(processGroupId === undefined ? {} : { processGroupId }),
        ...(sessionId === undefined ? {} : { sessionId }),
        ...(stdio === undefined ? {} : { stdio }),
        ...(descriptorActions.length === 0
          ? {}
          : { descriptorActions: Object.freeze(descriptorActions) }),
        ...(descriptorMappings.length === 0
          ? {}
          : { descriptorMappings: Object.freeze(descriptorMappings) }),
      };
      break;
          }
    case 'wait':
      {
      const pid = reader.i32();
      const noHang = reader.u8();
      if (noHang > 1) {
        throw new TraceKernelTransportError('EPROTO', `invalid wait no-hang flag ${noHang}`);
      }
      request = { op: 'wait', pid, ...(noHang ? { noHang: true } : {}) };
      break;
          }
    case 'kill':
      {
      const pid = reader.i32();
      request = {
        op: 'kill',
        pid,
        signal: readTraceKernelSignal(reader, 'kill'),
      };
      break;
          }
    case 'setsid':
      request = { op: 'setsid' };
      break;
    case 'setpgid':
      request = { op: 'setpgid', pid: reader.i32(), pgid: reader.i32() };
      break;
    case 'isatty':
    case 'tcgetpgrp':
    case 'tcgetwinsize':
      request = { op: operation, fd: reader.i32() };
      break;
    case 'tcsetpgrp':
      request = { op: 'tcsetpgrp', fd: reader.i32(), pgid: reader.i32() };
      break;
    case 'tcsetwinsize':
      request = {
        op: 'tcsetwinsize',
        fd: reader.i32(),
        rows: reader.u32(),
        columns: reader.u32(),
      };
      break;
    case 'identity':
      {
      const hasPid = reader.u8();
      if (hasPid > 1) {
        throw new TraceKernelTransportError(
          'EPROTO',
          `invalid identity pid presence flag ${hasPid}`
        );
      }
      request = {
        op: 'identity',
        ...(hasPid === 1 ? { pid: reader.i32() } : {}),
      };
      break;
          }
    case 'processInfo':
      {
      const hasPid = reader.u8();
      if (hasPid > 1) {
        throw new TraceKernelTransportError(
          'EPROTO',
          `invalid process info pid presence flag ${hasPid}`
        );
      }
      request = {
        op: 'processInfo',
        ...(hasPid === 1 ? { pid: reader.i32() } : {}),
      };
      break;
          }
    case 'processList':
      request = { op: 'processList' };
      break;
    case 'environment':
      request = { op: 'environment' };
      break;
    case 'poll':
      {
      const length = reader.u32();
      const entries = [];
      for (let index = 0; index < length; index += 1) {
        const fd = reader.i32();
        const events = reader.u8();
        if ((events & ~3) !== 0) {
          throw new TraceKernelTransportError(
            'EPROTO',
            `invalid poll event mask ${events}`
          );
        }
        entries.push({
          fd,
          read: (events & 1) !== 0,
          write: (events & 2) !== 0,
        });
      }
      const hasTimeout = reader.u8();
      if (hasTimeout > 1) {
        throw new TraceKernelTransportError(
          'EPROTO',
          `invalid poll timeout flag ${hasTimeout}`
        );
      }
      request = {
        op: 'poll',
        entries,
        ...(hasTimeout ? { timeoutMs: reader.f64() } : {}),
      };
      break;
          }
    default:
      return undefined;
  }
  return request;
}

export function encodeProcessResult(
  writer: BinaryFrameWriter,
  value: TraceKernelSyscallValue
): boolean {
  switch (value.op) {
    case 'pipe':
      writer.i32(value.readFd);
      writer.i32(value.writeFd);
      break;
    case 'watch':
      writer.i32(value.fd);
      break;
    case 'watchdog':
      writer.u8(value.armed ? 1 : 0);
      if (value.armed) {
        writer.u32(value.timeoutMs!);
        writer.f64(value.deadlineAt!);
        writer.u8(value.signal === 'SIGKILL' ? 2 : 1);
      }
      break;
    case 'spawn':
      writer.i32(value.pid);
      writer.u8(value.stdio?.stdinFd === undefined ? 0 : 1);
      if (value.stdio?.stdinFd !== undefined) writer.i32(value.stdio.stdinFd);
      writer.u8(value.stdio?.stdoutFd === undefined ? 0 : 1);
      if (value.stdio?.stdoutFd !== undefined) writer.i32(value.stdio.stdoutFd);
      writer.u8(value.stdio?.stderrFd === undefined ? 0 : 1);
      if (value.stdio?.stderrFd !== undefined) writer.i32(value.stdio.stderrFd);
      break;
    case 'wait':
      writer.i32(value.pid);
      writer.u8(value.termination === undefined ? 0 : 1);
      if (value.termination === undefined) break;
      writer.u8(
        value.termination.kind === 'exit'
          ? 1
          : value.termination.kind === 'signal'
            ? 2
            : 3
      );
      writer.i32(value.termination.exitCode);
      if (value.termination.kind === 'signal') {
        writer.u8(traceKernelSignalCode(value.termination.signal));
      } else if (value.termination.kind === 'failure') {
        writer.string(value.termination.message);
      }
      break;
    case 'identity':
      writer.i32(value.pid);
      writer.i32(value.ppid);
      writer.i32(value.pgid);
      writer.i32(value.sid);
      break;
    case 'processInfo':
      writeProcessInfo(writer, value.process);
      break;
    case 'processList':
      writer.u32(value.processes.length);
      for (const process of value.processes) {
        writeProcessInfo(writer, process);
      }
      break;
    case 'environment':
      {
      const entries = Object.entries(value.env);
      writer.u32(entries.length);
      for (const [name, entryValue] of entries) {
        writer.string(name);
        writer.string(entryValue);
      }
      break;
          }
    case 'poll':
      writer.u32(value.entries.length);
      for (const entry of value.entries) {
        writer.i32(entry.fd);
        writer.u8(
          (entry.read ? 1 : 0) |
          (entry.write ? 2 : 0) |
          (entry.hangup ? 4 : 0) |
          (entry.error ? 8 : 0) |
          (entry.invalid ? 16 : 0)
        );
      }
      break;
    case 'setsid':
      writer.i32(value.sid);
      writer.i32(value.pgid);
      break;
    case 'setpgid':
      writer.i32(value.pgid);
      break;
    case 'isatty':
      writer.u8(value.isTerminal ? 1 : 0);
      break;
    case 'tcgetpgrp':
    case 'tcsetpgrp':
      writer.i32(value.pgid);
      break;
    case 'tcgetwinsize':
    case 'tcsetwinsize':
      writer.u32(value.rows);
      writer.u32(value.columns);
      break;
    case 'kill':
      break;
    default:
      return false;
  }
  return true;
}

export function decodeProcessResult(
  reader: BinaryFrameReader,
  operation: TraceKernelSyscallOperation
): TraceKernelSyscallValue | undefined {
  let value: TraceKernelSyscallValue;
  switch (operation) {
    case 'pipe':
      value = {
        op: 'pipe',
        readFd: reader.i32(),
        writeFd: reader.i32(),
      };
      break;
    case 'watch':
      value = { op: 'watch', fd: reader.i32() };
      break;
    case 'watchdog':
      {
      const armed = reader.u8();
      if (armed > 1) {
        throw new TraceKernelTransportError(
          'EPROTO',
          `invalid watchdog armed flag ${armed}`
        );
      }
      if (!armed) {
        value = { op: 'watchdog', armed: false };
        break;
      }
      const timeoutMs = reader.u32();
      const deadlineAt = reader.f64();
      const signalCode = reader.u8();
      if (signalCode !== 1 && signalCode !== 2) {
        throw new TraceKernelTransportError(
          'EPROTO',
          `invalid watchdog response signal ${signalCode}`
        );
      }
      value = {
        op: 'watchdog',
        armed: true,
        timeoutMs,
        deadlineAt,
        signal: signalCode === 2 ? 'SIGKILL' : 'SIGTERM',
      };
      break;
          }
    case 'spawn':
      {
      const pid = reader.i32();
      const hasStdin = reader.u8();
      if (hasStdin > 1) {
        throw new TraceKernelTransportError('EPROTO', `invalid spawn stdin fd flag ${hasStdin}`);
      }
      const stdinFd = hasStdin ? reader.i32() : undefined;
      const hasStdout = reader.u8();
      if (hasStdout > 1) {
        throw new TraceKernelTransportError('EPROTO', `invalid spawn stdout fd flag ${hasStdout}`);
      }
      const stdoutFd = hasStdout ? reader.i32() : undefined;
      const hasStderr = reader.u8();
      if (hasStderr > 1) {
        throw new TraceKernelTransportError('EPROTO', `invalid spawn stderr fd flag ${hasStderr}`);
      }
      const stderrFd = hasStderr ? reader.i32() : undefined;
      const stdio = stdinFd === undefined && stdoutFd === undefined && stderrFd === undefined
        ? undefined
        : Object.freeze({
            ...(stdinFd === undefined ? {} : { stdinFd }),
            ...(stdoutFd === undefined ? {} : { stdoutFd }),
            ...(stderrFd === undefined ? {} : { stderrFd }),
          });
      value = {
        op: 'spawn',
        pid,
        ...(stdio === undefined ? {} : { stdio }),
      };
      break;
          }
    case 'wait':
      {
      const pid = reader.i32();
      const completed = reader.u8();
      if (completed > 1) {
        throw new TraceKernelTransportError(
          'EPROTO',
          `invalid wait completion flag ${completed}`
        );
      }
      if (!completed) {
        value = { op: 'wait', pid };
        break;
      }
      const terminationCode = reader.u8();
      if (terminationCode < 1 || terminationCode > 3) {
        throw new TraceKernelTransportError(
          'EPROTO',
          `invalid process termination code ${terminationCode}`
        );
      }
      const exitCode = reader.i32();
      if (terminationCode === 1) {
        value = {
          op: 'wait',
          pid,
          termination: { kind: 'exit', exitCode },
        };
      } else if (terminationCode === 2) {
        value = {
          op: 'wait',
          pid,
          termination: {
            kind: 'signal',
            signal: readTraceKernelTerminatingSignal(reader, 'termination'),
            exitCode,
          },
        };
      } else {
        value = {
          op: 'wait',
          pid,
          termination: {
            kind: 'failure',
            exitCode,
            message: reader.string(),
          },
        };
      }
      break;
          }
    case 'poll':
      {
      const length = reader.u32();
      const entries = [];
      for (let index = 0; index < length; index += 1) {
        const fd = reader.i32();
        const events = reader.u8();
        if ((events & ~31) !== 0) {
          throw new TraceKernelTransportError(
            'EPROTO',
            `invalid poll result mask ${events}`
          );
        }
        entries.push({
          fd,
          read: (events & 1) !== 0,
          write: (events & 2) !== 0,
          hangup: (events & 4) !== 0,
          error: (events & 8) !== 0,
          invalid: (events & 16) !== 0,
        });
      }
      value = { op: 'poll', entries };
      break;
          }
    case 'setsid':
      value = { op: 'setsid', sid: reader.i32(), pgid: reader.i32() };
      break;
    case 'setpgid':
      value = { op: 'setpgid', pgid: reader.i32() };
      break;
    case 'isatty':
      {
      const isTerminal = reader.u8();
      if (isTerminal > 1) {
        throw new TraceKernelTransportError(
          'EPROTO',
          `invalid isatty result ${isTerminal}`
        );
      }
      value = { op: 'isatty', isTerminal: isTerminal === 1 };
      break;
          }
    case 'tcgetpgrp':
    case 'tcsetpgrp':
      value = { op: operation, pgid: reader.i32() };
      break;
    case 'tcgetwinsize':
    case 'tcsetwinsize':
      value = {
        op: operation,
        rows: reader.u32(),
        columns: reader.u32(),
      };
      break;
    case 'identity':
      value = {
        op: 'identity',
        pid: reader.i32(),
        ppid: reader.i32(),
        pgid: reader.i32(),
        sid: reader.i32(),
      };
      break;
    case 'processInfo':
      value = {
        op: 'processInfo',
        process: readProcessInfo(reader),
      };
      break;
    case 'processList':
      {
      const processCount = reader.u32();
      const processes: TraceKernelProcessInfo[] = [];
      for (let index = 0; index < processCount; index += 1) {
        processes.push(readProcessInfo(reader));
      }
      value = {
        op: 'processList',
        processes: Object.freeze(processes),
      };
      break;
          }
    case 'environment':
      {
      const entryCount = reader.u32();
      const env: Record<string, string> = {};
      for (let index = 0; index < entryCount; index += 1) {
        env[reader.string()] = reader.string();
      }
      value = {
        op: 'environment',
        env: Object.freeze(env),
      };
      break;
          }
    case 'kill':
      value = { op: operation };
      break;
    default:
      return undefined;
  }
  return value;
}
