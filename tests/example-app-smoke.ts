import { spawn } from 'node:child_process';
import { request } from 'node:http';
import type { ChildProcess } from 'node:child_process';
import { chromium } from 'playwright';

export function assertCondition(condition: boolean, message: string): void {
  if (!condition) {
    throw new Error(message);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function runCommand(
  command: string,
  args: string[],
  cwd: string
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      stdio: 'inherit',
    });

    child.on('exit', (code, signal) => {
      if (code === 0) {
        resolve();
        return;
      }

      reject(
        new Error(
          `${command} ${args.join(' ')} failed with ${signal ? `signal ${signal}` : `exit code ${code ?? 'unknown'}`}`
        )
      );
    });

    child.on('error', reject);
  });
}

export async function waitForHttp(url: string, timeoutMs: number): Promise<void> {
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    const isReady = await new Promise<boolean>((resolve) => {
      const req = request(url, (response) => {
        response.resume();
        resolve(Boolean(response.statusCode && response.statusCode < 500));
      });

      req.on('error', () => resolve(false));
      req.end();
    });

    if (isReady) {
      return;
    }

    await sleep(500);
  }

  throw new Error(`Timed out waiting for ${url}`);
}

export function startPreviewServer(
  command: string,
  args: string[],
  cwd: string
): { process: ChildProcess; waitForExit: Promise<void>; waitForUrl: Promise<string> } {
  const child = spawn(command, args, {
    cwd,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let resolvedUrl = false;
  let resolveUrl!: (url: string) => void;
  let rejectUrl!: (error: Error) => void;
  const waitForUrl = new Promise<string>((resolve, reject) => {
    resolveUrl = resolve;
    rejectUrl = reject;
  });

  const handleChunk = (chunk: Buffer | string): void => {
    const text = String(chunk);
    process.stdout.write(text);

    const match = text.match(/Local:\s+(http:\/\/[^\s/]+:\d+\/?)/);
    if (match && !resolvedUrl) {
      resolvedUrl = true;
      resolveUrl(match[1].replace(/\/$/, ''));
    }
  };

  child.stdout?.on('data', handleChunk);
  child.stderr?.on('data', (chunk) => {
    process.stderr.write(String(chunk));
  });

  const waitForExit = new Promise<void>((resolve, reject) => {
    child.on('exit', (code, signal) => {
      if (!resolvedUrl) {
        rejectUrl(
          new Error(
            `${command} ${args.join(' ')} exited before reporting a preview URL`
          )
        );
      }

      if (code === 0 || signal === 'SIGTERM') {
        resolve();
        return;
      }

      reject(
        new Error(
          `${command} ${args.join(' ')} exited unexpectedly with ${signal ? `signal ${signal}` : `exit code ${code ?? 'unknown'}`}`
        )
      );
    });

    child.on('error', reject);
  });

  child.on('error', (error) => {
    if (!resolvedUrl) {
      rejectUrl(error instanceof Error ? error : new Error(String(error)));
    }
  });

  return { process: child, waitForExit, waitForUrl };
}

async function runLanguageExampleSmoke(
  page: import('playwright').Page,
  language: 'python' | 'javascript' | 'typescript' | 'java' | 'cpp',
  options: {
    executionTimeoutMs: number;
    traceTimeoutMs: number;
    assertTrace?: (traceResult: { success?: boolean; trace?: unknown }) => void;
  }
): Promise<void> {
  await page.selectOption('#language', language);

  await page.click('#run');
  try {
    await page.waitForFunction(
      () => {
        const output = document.querySelector('#execution-output');
        const text = output?.textContent;
        if (!text) return false;

        try {
          const parsed = JSON.parse(text) as { success?: boolean; output?: unknown };
          return (
            parsed.success === true &&
            Array.isArray(parsed.output) &&
            parsed.output.length === 2 &&
            parsed.output[0] === 0 &&
            parsed.output[1] === 1
          );
        } catch {
          return false;
        }
      },
      undefined,
      { timeout: options.executionTimeoutMs }
    );
  } catch (error) {
    throw new Error(`Example ${language} execution did not finish: ${await readExampleSmokeDiagnostics(page)}`, {
      cause: error,
    });
  }

  await page.click('#trace');
  try {
    await page.waitForFunction(
      () => {
        const output = document.querySelector('#trace-output');
        const text = output?.textContent;
        if (!text) return false;

        try {
          const parsed = JSON.parse(text) as { success?: boolean; trace?: unknown };
          const trace = parsed.trace;
          const events = Array.isArray(trace)
            ? trace
            : trace && typeof trace === 'object' && Array.isArray((trace as { events?: unknown }).events)
              ? (trace as { events: unknown[] }).events
              : [];
          return parsed.success === true && events.length > 0;
        } catch {
          return false;
        }
      },
      undefined,
      { timeout: options.traceTimeoutMs }
    );
  } catch (error) {
    throw new Error(`Example ${language} trace did not finish: ${await readExampleSmokeDiagnostics(page)}`, {
      cause: error,
    });
  }

  const traceText = await page.textContent('#trace-output');
  assertCondition(typeof traceText === 'string', `Expected trace output for ${language}`);
  const traceResult = JSON.parse(traceText) as { success?: boolean; trace?: unknown };
  const traceEvents = runtimeTraceEvents(traceResult.trace);
  assertCondition(traceResult.success === true, `Expected successful trace result for ${language}`);
  assertCondition(
    traceEvents.length > 0,
    `Expected non-empty runtime trace events for ${language}`
  );
  options.assertTrace?.(traceResult);
}

async function runCSharpExampleSmoke(page: import('playwright').Page): Promise<void> {
  await page.selectOption('#language', 'csharp');
  await page.click('#run');
  try {
    await page.waitForFunction(
      () => {
        const output = document.querySelector('#execution-output');
        const text = output?.textContent;
        if (!text) return false;

        try {
          const parsed = JSON.parse(text) as { success?: boolean; output?: unknown };
          return parsed.success === true && parsed.output === 5;
        } catch {
          return false;
        }
      },
      undefined,
      { timeout: 240_000 }
    );
  } catch (error) {
    throw new Error(`Example csharp execution did not finish: ${await readExampleSmokeDiagnostics(page)}`, {
      cause: error,
    });
  }
}

function runtimeTraceEvents(trace: unknown): unknown[] {
  if (Array.isArray(trace)) return trace;
  if (trace && typeof trace === 'object' && Array.isArray((trace as { events?: unknown }).events)) {
    return (trace as { events: unknown[] }).events;
  }
  return [];
}

async function readExampleSmokeDiagnostics(page: import('playwright').Page): Promise<string> {
  const state = await page.evaluate(() => ({
    status: document.querySelector('#status')?.textContent ?? '',
    executionOutput: document.querySelector('#execution-output')?.textContent ?? '',
    traceOutput: document.querySelector('#trace-output')?.textContent ?? '',
  }));
  return JSON.stringify(state);
}

export async function runExampleBrowserSmoke(previewUrl: string): Promise<void> {
  const browser = await chromium.launch({ headless: true });

  try {
    const page = await browser.newPage();
    page.setDefaultTimeout(180_000);
    await page.goto(previewUrl, { waitUntil: 'networkidle' });

    for (const language of ['python', 'javascript', 'typescript', 'java', 'cpp'] as const) {
      await runLanguageExampleSmoke(page, language, {
        executionTimeoutMs: language === 'python' || language === 'java' || language === 'cpp' ? 240_000 : 60_000,
        traceTimeoutMs: language === 'python' || language === 'java' || language === 'cpp' ? 240_000 : 60_000,
      });
    }
    await runCSharpExampleSmoke(page);
  } finally {
    await browser.close();
  }
}

export async function runJavaExampleBrowserSmoke(previewUrl: string): Promise<void> {
  const browser = await chromium.launch({ headless: true });

  try {
    const page = await browser.newPage();
    page.setDefaultTimeout(240_000);
    await page.goto(previewUrl, { waitUntil: 'networkidle' });

    await runLanguageExampleSmoke(page, 'java', {
      executionTimeoutMs: 240_000,
      traceTimeoutMs: 240_000,
      assertTrace(traceResult) {
        const trace = runtimeTraceEvents(traceResult.trace);
        const callSteps = trace.filter((event) => (event as { kind?: unknown }).kind === 'call');
        const accessKinds = new Set(
          trace
            .map((event) => (event as { kind?: unknown }).kind)
            .filter((kind): kind is string => typeof kind === 'string')
        );
        assertCondition(callSteps.length > 0, 'Expected Java trace to include call events');
        assertCondition(accessKinds.has('read'), 'Expected Java trace to include read access events');
      },
    });
  } finally {
    await browser.close();
  }
}
