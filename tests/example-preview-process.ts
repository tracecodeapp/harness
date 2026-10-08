import { spawn, type ChildProcess } from 'node:child_process';
import { request } from 'node:http';
import { stripVTControlCharacters } from 'node:util';

interface ProcessOptions {
  shutdownGraceMs?: number;
}

interface ExitResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  error?: Error;
}

function startOwnedProcess(
  command: string,
  args: string[],
  cwd: string,
  pipes: boolean,
  { shutdownGraceMs = 5_000 }: ProcessOptions,
): { child: ChildProcess; closed: Promise<ExitResult>; stop: () => Promise<void> } {
  const child = spawn(command, args, {
    cwd,
    detached: process.platform !== 'win32',
    stdio: pipes ? ['ignore', 'pipe', 'pipe'] : 'inherit',
  });
  let spawnError: Error | undefined;
  child.once('error', (error) => { spawnError = error; });
  const closed = new Promise<ExitResult>((resolve) => {
    // An exit event only describes the wrapper. Close also waits for output
    // pipes inherited by its children, which must be terminated before reuse.
    child.once('close', (code, signal) => resolve({ code, signal, error: spawnError }));
  });
  const signalTree = (signal: NodeJS.Signals): void => {
    if (!child.pid) return;
    try {
      if (process.platform === 'win32') child.kill(signal);
      else process.kill(-child.pid, signal);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
    }
  };
  let stopping: Promise<void> | undefined;
  const stop = (): Promise<void> => {
    stopping ??= (async () => {
      signalTree('SIGTERM');
      const escalation = setTimeout(() => signalTree('SIGKILL'), shutdownGraceMs);
      let deadline: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          closed,
          new Promise<never>((_, reject) => {
            deadline = setTimeout(() => {
              child.stdout?.destroy();
              child.stderr?.destroy();
              reject(new Error(`${command} shutdown did not close after SIGKILL`));
            }, shutdownGraceMs + 2_000);
          }),
        ]);
        // A descendant may close inherited pipes without exiting. The group
        // belongs solely to this spawn, so finish removing its remaining jobs.
        signalTree('SIGKILL');
      } finally {
        clearTimeout(escalation);
        clearTimeout(deadline);
      }
    })();
    return stopping;
  };
  // A wrapper can exit before its descendants. Reap the owned group even if
  // the caller observes an early command failure or never reaches cleanup.
  child.once('exit', () => { void stop().catch(() => {}); });
  return { child, closed, stop };
}

export async function runCommand(
  command: string,
  args: string[],
  cwd: string,
  options: ProcessOptions & { timeoutMs?: number } = {},
): Promise<void> {
  const owned = startOwnedProcess(command, args, cwd, false, options);
  const timeoutMs = options.timeoutMs ?? 180_000;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let failure: unknown;
  try {
    const result = await Promise.race([
      owned.closed,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${command} ${args.join(' ')} timed out after ${timeoutMs}ms`)), timeoutMs);
      }),
    ]);
    if (result.error) throw result.error;
    if (result.code !== 0) {
      throw new Error(`${command} ${args.join(' ')} failed with ${result.signal ? `signal ${result.signal}` : `exit code ${result.code ?? 'unknown'}`}`);
    }
  } catch (error) {
    failure = error;
    throw error;
  } finally {
    clearTimeout(timer);
    try {
      await owned.stop();
    } catch (cleanupError) {
      if (failure !== undefined) throw new AggregateError([failure, cleanupError], 'Command and cleanup failed');
      throw cleanupError;
    }
  }
}

export async function waitForHttp(url: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const remaining = deadline - Date.now();
    const ready = await new Promise<boolean>((resolve) => {
      const req = request(url, (response) => {
        const ready = Boolean(response.statusCode && response.statusCode < 500);
        response.destroy();
        resolve(ready);
      });
      // A server can accept TCP and never send headers. Bound each request
      // by the same overall deadline instead of waiting forever inside it.
      const timer = setTimeout(() => req.destroy(new Error('HTTP readiness deadline exceeded')), remaining);
      req.once('close', () => clearTimeout(timer));
      req.once('error', () => resolve(false));
      req.end();
    });
    if (ready) return;
    await new Promise((resolve) => setTimeout(resolve, Math.min(100, Math.max(0, deadline - Date.now()))));
  }
  throw new Error(`Timed out waiting for HTTP readiness at ${url}`);
}

export function startPreviewServer(
  command: string,
  args: string[],
  cwd: string,
  options: ProcessOptions & { startupTimeoutMs?: number } = {},
): { process: ChildProcess; waitForExit: Promise<void>; waitForUrl: Promise<string>; stop: (failure?: unknown) => Promise<void> } {
  const owned = startOwnedProcess(command, args, cwd, true, options);
  let output = '';
  let startupTimer: ReturnType<typeof setTimeout> | undefined;
  let settledUrl = false;
  let requestedStop = false;
  let resolveUrl!: (url: string) => void;
  let rejectUrl!: (error: Error) => void;
  const waitForUrl = new Promise<string>((resolve, reject) => {
    resolveUrl = resolve;
    rejectUrl = reject;
  });
  // Callers await these at different phases. Observe rejection immediately
  // while preserving the original promise/error for the eventual await.
  void waitForUrl.catch(() => {});
  const settleUrl = (value: string | Error): void => {
    if (settledUrl) return;
    settledUrl = true;
    clearTimeout(startupTimer);
    if (value instanceof Error) rejectUrl(value);
    else resolveUrl(value);
  };
  owned.child.stdout?.on('data', (chunk: Buffer | string) => {
    process.stdout.write(chunk);
    output = (output + String(chunk)).slice(-16_384);
    // Vite's label and URL may arrive in separate writes, including ANSI
    // sequences. Require trailing whitespace so a split port is not accepted.
    const match = stripVTControlCharacters(output).match(/Local:\s+(http:\/\/[^\s/]+:\d+\/?)(?=\s)/);
    if (match) settleUrl(match[1].replace(/\/$/, ''));
  });
  owned.child.stderr?.on('data', (chunk: Buffer | string) => process.stderr.write(chunk));
  const waitForExit = owned.closed.then((result) => {
    settleUrl(result.error ?? new Error(`${command} ${args.join(' ')} exited before reporting a preview URL`));
    if (result.error) throw result.error;
    const expectedSignal = requestedStop && (result.signal === 'SIGTERM' || result.signal === 'SIGKILL');
    if (result.code !== 0 && !expectedSignal) {
      throw new Error(`${command} ${args.join(' ')} exited unexpectedly with ${result.signal ? `signal ${result.signal}` : `exit code ${result.code ?? 'unknown'}`}`);
    }
  });
  void waitForExit.catch(() => {});
  startupTimer = setTimeout(() => {
    settleUrl(new Error(`${command} preview startup timed out after ${options.startupTimeoutMs ?? 30_000}ms`));
    void owned.stop().catch(() => {});
  }, options.startupTimeoutMs ?? 30_000);
  return {
    process: owned.child,
    waitForExit,
    waitForUrl,
    stop: async (failure?: unknown) => {
      requestedStop = true;
      try {
        await owned.stop();
        await waitForExit;
      } catch (cleanupError) {
        if (failure !== undefined) throw new AggregateError([failure, cleanupError], 'Example and preview cleanup failed');
        throw cleanupError;
      }
    },
  };
}
