import {
  createAlgorithmJudgeBundle,
  createBrowserJudgeHost,
} from '../../src/judge';

/**
 * Traced C# builds decline conditional compilation (#if, #elif, #else,
 * #endif, #define, #undef); ordinary builds, Run verdicts and Submit do not
 * change. Directives that cannot select code stay traceable.
 */
export const TRACE_REFUSAL_CODE = 'csharp-trace-conditional-compilation-unsupported';

/** Every program returns its argument, so each case passes when it runs. */
export const DECLINED_PROGRAMS: Readonly<Record<string, string>> = {
  'if-endif': `using System;

public class Solution
{
    public int solve(int n)
    {
#if DEBUG
        Console.WriteLine("debug build");
#endif
        return n;
    }
}`,
  'if-elif-else': `public class Solution
{
    public int solve(int n)
    {
#if FAST
        return n + 0;
#elif SLOW
        return n * 1;
#else
        return n;
#endif
    }
}`,
  'define-only': `#define VERBOSE
public class Solution
{
    public int solve(int n) => n;
}`,
  'undef-only': `#undef VERBOSE
public class Solution
{
    public int solve(int n) => n;
}`,
  'define-and-if': `#define VERBOSE
using System;

public class Solution
{
    public int solve(int n)
    {
#if VERBOSE
        Console.WriteLine(n);
#endif
        return n;
    }
}`,
  'if-true-in-method': `public class Solution
{
    public int solve(int n)
    {
#if true
        return n;
#endif
    }
}`,
};

/** Programs that must keep drawing: no directives, or directives that cannot select code. */
export const DRAWN_PROGRAMS: Readonly<Record<string, string>> = {
  'no-directives': `public class Solution
{
    public int solve(int n)
    {
        int total = 0;
        for (int i = 0; i < n; i++) total++;
        return total;
    }
}`,
  'region': `public class Solution
{
    #region Entry point
    public int solve(int n)
    {
        #region Body
        return Identity(n);
        #endregion
    }
    #endregion

    #region Helpers
    private static int Identity(int value) => value;
    #endregion
}`,
  'pragma': `public class Solution
{
    public int solve(int n)
    {
#pragma warning disable CS0219
        int unused = 0;
#pragma warning restore CS0219
        return n;
    }
}`,
  'directive-text-in-comments': `// #if DEBUG
// #define VERBOSE
public class Solution
{
    /// <summary>Uses no #if or #define at all.</summary>
    public int solve(int n)
    {
        /*
#if DEBUG
#define VERBOSE
#endif
        */
        return n; // #endif
    }
}`,
  'directive-text-in-strings': `public class Solution
{
    public int solve(int n)
    {
        string inline = "#if DEBUG";
        string verbatim = @"
#if DEBUG
#define VERBOSE
#endif
";
        string raw = """
#undef VERBOSE
#elif
""";
        char hash = '#';
        return inline.Length > 0 && verbatim.Length > 0 && raw.Length > 0 && hash == '#' ? n : -1;
    }
}`,
};

/** Directives that cannot select code: they must not be declined, and Run and Submit are unchanged. */
export const UNDECLINED_PROGRAMS: Readonly<Record<string, string>> = {
  'nullable': `#nullable enable
public class Solution
{
    public int solve(int n)
    {
        string? note = null;
        return note is null ? n : -1;
    }
}
#nullable restore`,
  'warning': `public class Solution
{
#warning kept as a reminder
    public int solve(int n) => n;
}`,
  'line': `public class Solution
{
    public int solve(int n)
    {
#line 200
        int value = n;
#line default
        return value;
    }
}`,
};

type Reply = Record<string, unknown> & {
  readonly success?: boolean;
  readonly error?: string;
  readonly refusalCode?: string;
  readonly output?: unknown;
  readonly compiledArtifactKey?: string;
};

interface RoleWorker {
  send(type: string, payload: Record<string, unknown>): Promise<Reply>;
  terminate(): void;
}

function roleWorker(workerUrl: string): RoleWorker {
  const worker = new Worker(workerUrl, { type: 'module' });
  const pending = new Map<string, {
    resolve(value: Reply): void;
    reject(error: Error): void;
    protocolToken: string;
  }>();
  let nextId = 0;
  worker.addEventListener('message', (event: MessageEvent) => {
    const data = event.data;
    if (data?.type === 'compiler-artifact-cache-request') {
      worker.postMessage({
        type: 'compiler-artifact-cache-response',
        requestId: data.requestId,
        protocolToken: data.protocolToken,
        payload: { hit: false, stored: false },
      });
      return;
    }
    const request = pending.get(data?.id);
    if (!request || data?.protocolToken !== request.protocolToken) return;
    pending.delete(data.id);
    if (data.type === 'error') request.reject(new Error(String(data?.payload?.error ?? 'C# worker error')));
    else request.resolve(data?.payload ?? {});
  });
  return {
    send(type, payload) {
      const id = String(++nextId);
      const protocolToken = `trace-directives-${id}-${crypto.randomUUID()}`;
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject, protocolToken });
        worker.postMessage({ id, type, payload, protocolToken });
      });
    },
    terminate() {
      worker.terminate();
    },
  };
}

function bundle(source: string, trace: boolean) {
  return createAlgorithmJudgeBundle({
    id: 'csharp-trace-directives',
    language: 'csharp',
    code: source,
    functionName: 'solve',
    executionStyle: 'solution-method',
    trace,
    limits: { wallClockMs: 10_000 },
    cases: [
      { id: 'A', input: { n: 7 }, expected: 7 },
      { id: 'B', input: { n: 11 }, expected: 11 },
    ],
    comparison: { schema: 'tracecode.judge.comparator.v1', mode: 'exact' },
  });
}

export interface ProgramReport {
  readonly name: string;
  readonly expectation: 'declined' | 'drawn' | 'undeclined';
  readonly codeCompile: { success: boolean; refusalCode?: string; error?: string };
  readonly traceCompile: { success: boolean; refusalCode?: string; error?: string };
  readonly singleCallTrace: { success: boolean; refusalCode?: string; error?: string };
  readonly singleCallCode: { success: boolean; output?: unknown; error?: string };
  readonly submit: { verdict: string; passed: number; total: number };
  /** A trace-mode evaluate returns the ordinary result; its rows carry no drawing. */
  readonly tracedSubmit: { verdict: string; passed: number };
  readonly run: { status: string; verdicts: string[]; attachment: unknown };
}

function compileSummary(reply: Reply) {
  return {
    success: reply.success === true,
    ...(typeof reply.refusalCode === 'string' ? { refusalCode: reply.refusalCode } : {}),
    ...(reply.success === true ? {} : { error: String(reply.error ?? '') }),
  };
}

function attachmentSummary(attachment: unknown): unknown {
  if (!attachment || typeof attachment !== 'object') return attachment ?? null;
  const { status, reason } = attachment as { status?: unknown; reason?: unknown };
  return reason === undefined ? { status } : { status, reason };
}

/**
 * Runs every program through the compiler role (prepare, code and trace), the
 * general role (single-call traced and untraced execution) and the public Judge
 * host (Submit, a trace-mode evaluate, and Run with a drawing). Returns one report per
 * program plus the list of expectation failures.
 */
export async function runCSharpTraceDirectives(
  workerUrl: string,
  compilerAssetBaseUrl: string,
  runnerAssetBaseUrl: string
): Promise<{ reports: ProgramReport[]; failures: string[] }> {
  const failures: string[] = [];
  const reports: ProgramReport[] = [];
  const compiler = roleWorker(workerUrl);
  const general = roleWorker(workerUrl);
  const host = createBrowserJudgeHost({
    providers: ['csharp'],
    assetBaseUrl: '/workers',
    assets: { csharpWorker: workerUrl, csharpRunnerAssetBaseUrl: runnerAssetBaseUrl },
    safeExecution: { workerLifecycle: 'warm-and-retire' },
  });
  try {
    await compiler.send('warmup', { assetBaseUrl: compilerAssetBaseUrl, runtimeRole: 'compiler' });
    await general.send('warmup', { assetBaseUrl: compilerAssetBaseUrl });
    await host.warmLanguage('csharp');

    const programs = [
      ...Object.entries(DECLINED_PROGRAMS).map(([name, source]) => ({ name, source, expectation: 'declined' as const })),
      ...Object.entries(DRAWN_PROGRAMS).map(([name, source]) => ({ name, source, expectation: 'drawn' as const })),
      ...Object.entries(UNDECLINED_PROGRAMS).map(([name, source]) => ({ name, source, expectation: 'undeclined' as const })),
    ];
    for (const { name, source, expectation } of programs) {
      const fail = (message: string) => failures.push(`${name}: ${message}`);
      const prepare = (mode: 'code' | 'trace') => compiler.send('prepare-program', {
        mode,
        code: source,
        functionName: 'solve',
        executionStyle: 'solution-method',
        assetBaseUrl: compilerAssetBaseUrl,
        runtimeRole: 'compiler',
        timeoutMs: 20_000,
        ...(mode === 'trace' ? { traceOptions: { maxTraceSteps: 10_000, maxStoredEvents: 10_000 } } : {}),
      });
      const codeReply = await prepare('code');
      const traceReply = await prepare('trace');
      for (const reply of [codeReply, traceReply]) {
        if (reply.success === true && typeof reply.compiledArtifactKey === 'string') {
          await compiler.send('dispose-prepared-program', { compiledArtifactKey: reply.compiledArtifactKey });
        }
      }
      const single = (type: 'execute-code' | 'execute-with-tracing') => general.send(type, {
        code: source,
        functionName: 'solve',
        inputs: { n: 7 },
        executionStyle: 'solution-method',
        assetBaseUrl: compilerAssetBaseUrl,
        timeoutMs: 10_000,
        maxTraceSteps: 10_000,
      });
      const singleTrace = await single('execute-with-tracing');
      const singleCode = await single('execute-code');

      const submit = await host.evaluateAlgorithm({ bundle: await bundle(source, false) });
      const tracedSubmit = await host.evaluateAlgorithm({ bundle: await bundle(source, true) });
      const run = await host.execute({
        bundle: await bundle(source, true),
        interactive: true,
        tracing: { caseIds: ['A'] },
      });
      const runCases = run.evaluation.status === 'completed' ? run.evaluation.cases : [];
      const report: ProgramReport = {
        name,
        expectation,
        codeCompile: compileSummary(codeReply),
        traceCompile: compileSummary(traceReply),
        singleCallTrace: compileSummary(singleTrace),
        singleCallCode: {
          success: singleCode.success === true,
          output: singleCode.output,
          ...(singleCode.success === true ? {} : { error: String(singleCode.error ?? '') }),
        },
        submit: { verdict: submit.verdict, passed: submit.passedCount, total: submit.totalCount },
        tracedSubmit: { verdict: tracedSubmit.verdict, passed: tracedSubmit.passedCount },
        run: {
          status: run.evaluation.status,
          verdicts: runCases.map((row) => row.verdict.kind),
          attachment: attachmentSummary(runCases[0]?.attachment),
        },
      };
      reports.push(report);
      if (run.executionId) await host.disposeExecution(run.executionId);

      // Ordinary paths never change.
      if (!report.codeCompile.success) fail(`ordinary build failed: ${report.codeCompile.error}`);
      if (!report.singleCallCode.success || report.singleCallCode.output !== 7) {
        fail(`single-call ordinary execution changed: ${JSON.stringify(report.singleCallCode)}`);
      }
      if (report.submit.verdict !== 'passed' || report.submit.passed !== 2) {
        fail(`Submit changed: ${JSON.stringify(report.submit)}`);
      }
      if (report.run.status !== 'completed' || report.run.verdicts.join() !== 'passed,passed') {
        fail(`Run verdict changed: ${JSON.stringify(report.run)}`);
      }
      if (tracedSubmit.verdict !== 'passed' || tracedSubmit.passedCount !== 2) {
        fail(`traced Submit verdict changed: ${JSON.stringify(report.tracedSubmit)}`);
      }

      const declined = { status: 'refused', reason: TRACE_REFUSAL_CODE };
      if (expectation === 'declined') {
        for (const [label, reply] of [['traced build', report.traceCompile], ['single-call traced execution', report.singleCallTrace]] as const) {
          if (reply.success || reply.refusalCode !== TRACE_REFUSAL_CODE || reply.error !== TRACE_REFUSAL_CODE) {
            fail(`${label} was not declined with the typed refusal: ${JSON.stringify(reply)}`);
          }
        }
        if (report.codeCompile.refusalCode !== undefined) fail('the ordinary build carried a refusal code');
        if (JSON.stringify(report.run.attachment) !== JSON.stringify(declined)) {
          fail(`Run drawing is not the typed refusal: ${JSON.stringify(report.run.attachment)}`);
        }
        continue;
      }
      if (!report.traceCompile.success || report.traceCompile.refusalCode !== undefined) {
        fail(`traced build was declined: ${JSON.stringify(report.traceCompile)}`);
      }
      if (!report.singleCallTrace.success || report.singleCallTrace.refusalCode !== undefined) {
        fail(`single-call traced execution was declined: ${JSON.stringify(report.singleCallTrace)}`);
      }
      const status = (report.run.attachment as { status?: unknown } | null)?.status;
      if (expectation === 'drawn' && status !== 'drawn' && status !== 'truncated') {
        fail(`Run did not draw: ${JSON.stringify(report.run.attachment)}`);
      }
      if (JSON.stringify(report.run.attachment) === JSON.stringify(declined)) {
        fail('Run drawing was declined for a directive that cannot select code');
      }
    }
    return { reports, failures };
  } finally {
    compiler.terminate();
    general.terminate();
    await host.dispose();
  }
}
