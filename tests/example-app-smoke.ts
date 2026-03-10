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

export async function runExampleBrowserSmoke(previewUrl: string): Promise<void> {
  const browser = await chromium.launch({ headless: true });

  try {
    const page = await browser.newPage();
    page.setDefaultTimeout(180_000);
    await page.goto(previewUrl, { waitUntil: 'networkidle' });

    for (const language of ['python', 'javascript', 'typescript'] as const) {
      await page.selectOption('#language', language);

      await page.click('#run');
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
        { timeout: language === 'python' ? 180_000 : 60_000 }
      );

      await page.click('#trace');
      await page.waitForFunction(
        () => {
          const output = document.querySelector('#trace-output');
          const text = output?.textContent;
          if (!text) return false;

          try {
            const parsed = JSON.parse(text) as { success?: boolean; trace?: unknown };
            return parsed.success === true && Array.isArray(parsed.trace) && parsed.trace.length > 0;
          } catch {
            return false;
          }
        },
        undefined,
        { timeout: language === 'python' ? 180_000 : 60_000 }
      );

      const traceText = await page.textContent('#trace-output');
      assertCondition(typeof traceText === 'string', `Expected trace output for ${language}`);
      const traceResult = JSON.parse(traceText) as { success?: boolean; trace?: unknown };
      assertCondition(traceResult.success === true, `Expected successful trace result for ${language}`);
      assertCondition(Array.isArray(traceResult.trace) && traceResult.trace.length > 0, `Expected non-empty trace array for ${language}`);
    }
  } finally {
    await browser.close();
  }
}
