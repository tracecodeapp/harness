export interface TraceKernelCommandResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  handledSignal?: string;
}

export interface TraceKernelTraceJVMExecutionReport {
  source: string;
  status: string;
  isolation: string;
  retirementRecommended: boolean;
}

export interface TraceKernelTraceJVMResult {
  compile: TraceKernelCommandResult;
  firstRun: TraceKernelCommandResult;
  secondRun: TraceKernelCommandResult;
  filesystemRun: TraceKernelCommandResult;
  stdinRun: TraceKernelCommandResult;
  socketRun: TraceKernelCommandResult;
  selectorRun: TraceKernelCommandResult;
  watchRun: TraceKernelCommandResult;
  processRun: TraceKernelCommandResult;
  controlsRun: TraceKernelCommandResult;
  terminalControlsRun: TraceKernelCommandResult;
  watchdogExpiry: TraceKernelCommandResult;
  sharedFile: string;
  randomFile: string;
  childFile: string;
  interrupted: TraceKernelCommandResult;
  restarted: TraceKernelCommandResult;
  classFileBase64: string;
  compilerWorkerCount: number;
  runnerWorkerCount: number;
  processClientCount: number;
  reports: TraceKernelTraceJVMExecutionReport[];
}

export interface TraceKernelTraceJVMCheck {
  id: string;
  label: string;
  passed: boolean;
  detail?: string;
}

function check(
  id: string,
  label: string,
  passed: boolean,
  detail?: unknown
): TraceKernelTraceJVMCheck {
  return {
    id,
    label,
    passed,
    ...(passed || detail === undefined
      ? {}
      : {
          detail: typeof detail === 'string'
            ? detail
            : JSON.stringify(detail),
        }),
  };
}

export function inspectTraceKernelTraceJVMResult(
  result: TraceKernelTraceJVMResult
): TraceKernelTraceJVMCheck[] {
  const reportStatuses = result.reports.map(
    (report) => `${report.source}:${report.status}:${report.isolation}`
  );
  return [
    check(
      'compile',
      'TraceJVM compiles all process fixtures',
      result.compile.exitCode === 0 && result.classFileBase64.length > 0,
      result.compile
    ),
    check(
      'fresh-process-state',
      'Fresh Java processes do not leak static or system-property state',
      result.firstRun.exitCode === 0 &&
        result.firstRun.stdout === '1:first:missing:first\n' &&
        result.secondRun.exitCode === 0 &&
        result.secondRun.stdout === '1:missing:missing:second\n',
      { firstRun: result.firstRun, secondRun: result.secondRun }
    ),
    check(
      'shared-filesystem',
      'JavaScript and Java share the authoritative TraceKernel filesystem',
      result.filesystemRun.exitCode === 0 &&
        result.filesystemRun.stdout ===
          'fs:js-before-java:nested:true:abZd:3:random.bin:true:true\n' &&
        result.sharedFile === 'js-before-java|java' &&
        result.randomFile === 'abZd',
      {
        filesystemRun: result.filesystemRun,
        sharedFile: result.sharedFile,
        randomFile: result.randomFile,
      }
    ),
    check(
      'stdin',
      'Java reads process-owned stdin descriptors',
      result.stdinRun.exitCode === 0 &&
        result.stdinRun.stdout === 'stdin:hello\n',
      result.stdinRun
    ),
    check(
      'tcp',
      'Java TCP sockets route through TraceKernel',
      result.socketRun.exitCode === 0 &&
        result.socketRun.stdout === 'socket:pong\n',
      result.socketRun
    ),
    check(
      'selector',
      'Java selectors observe descriptor readiness and wakeups',
      result.selectorRun.exitCode === 0 &&
        result.selectorRun.stdout === 'selector:true:true\n',
      result.selectorRun
    ),
    check(
      'file-watch',
      'Java file watches observe JavaScript child mutations',
      result.watchRun.exitCode === 0 &&
        result.watchRun.stdout === 'watch:true:true:true:0\n',
      result.watchRun
    ),
    check(
      'child-process',
      'Java child processes preserve identity, environment, signals, and files',
      result.processRun.exitCode === 0 &&
        /^process:\d+:true:true:true:true:true:true:1:true:false:java-child\n$/u.test(
          result.processRun.stdout
        ) &&
        result.childFile === 'java-child',
      { processRun: result.processRun, childFile: result.childFile }
    ),
    check(
      'process-controls',
      'Process groups, sessions, identity, and watchdog controls are kernel-owned',
      result.controlsRun.exitCode === 0 &&
        result.controlsRun.stdout === 'controls:true:true:true:true\n',
      result.controlsRun
    ),
    check(
      'terminal-controls',
      'Terminal foreground groups and window-size signals are kernel-owned',
      result.terminalControlsRun.exitCode === 0 &&
        result.terminalControlsRun.stdout === 'terminal:true:true\n',
      result.terminalControlsRun
    ),
    check(
      'watchdog-expiry',
      'Watchdog expiry kills the process with SIGKILL semantics',
      result.watchdogExpiry.exitCode === 137,
      result.watchdogExpiry
    ),
    check(
      'interrupt',
      'SIGINT interruption retires the active runtime cleanly',
      result.interrupted.exitCode === 130 &&
        result.interrupted.stderr === '',
      result.interrupted
    ),
    check(
      'restart',
      'A process starts cleanly after interruption',
      result.restarted.exitCode === 0 &&
        result.restarted.stdout === '1:missing:missing:restarted\n',
      result.restarted
    ),
    check(
      'compiler-runner-lifecycle',
      'One warm compiler serves fresh process-scoped runner workers',
      result.compilerWorkerCount === 1 &&
        result.runnerWorkerCount === 17 &&
        result.processClientCount === 18,
      {
        compilerWorkerCount: result.compilerWorkerCount,
        runnerWorkerCount: result.runnerWorkerCount,
        processClientCount: result.processClientCount,
      }
    ),
    check(
      'execution-reports',
      'Execution reports preserve clean, tainted, and runtime-error isolation',
      reportStatuses.includes('compile:completed:not-applicable') &&
        reportStatuses.includes('run:runtime-error:clean') &&
        reportStatuses.includes('run:completed:tainted') &&
        reportStatuses.filter(
          (status) => status === 'run:completed:clean'
        ).length === 8,
      reportStatuses
    ),
  ];
}

export function assertTraceKernelTraceJVMResult(
  result: TraceKernelTraceJVMResult
): void {
  const failed = inspectTraceKernelTraceJVMResult(result)
    .filter((entry) => !entry.passed);
  if (failed.length === 0) return;
  throw new Error(
    `TraceKernel/TraceJVM adapter boundary failed: ${JSON.stringify(failed)}`
  );
}
