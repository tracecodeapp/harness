import { createAlgorithmJudgeBundle, createBrowserJudgeHost } from '../../src/judge';
import { createTraceCCRuntimeManifest } from '../../packages/runtime-cpp/src/tracecc-runtime-assets';

/** The five Judge paths a learner reaches: Run with no, the first or every case traced, and Submit untraced and traced. */
export const JUDGE_PATHS = ['run-untraced', 'run-first-traced', 'run-all-traced', 'submit', 'submit-traced'] as const;
export type JudgePath = (typeof JUDGE_PATHS)[number];

export interface NaturalShapeCase {
  readonly id: string;
  readonly input: Record<string, unknown>;
  readonly expected: unknown;
}

export interface NaturalShapeFixture {
  readonly name: string;
  readonly code: string;
  readonly functionName: string;
  readonly executionStyle: 'solution-method' | 'ops-class';
  readonly cases: readonly NaturalShapeCase[];
}

export interface PathObservation {
  readonly path: JudgePath;
  readonly status?: string;
  readonly compileStatus?: string;
  readonly compileMessage?: string;
  readonly cases: ReadonlyArray<{ caseId: string; status?: string; verdict?: string; value?: unknown; message?: string }>;
  readonly threw?: string;
}

function createHost(assetBaseUrl: string) {
  return createBrowserJudgeHost({
    assetBaseUrl,
    providers: ['cpp'],
    assets: { runtimeManifests: { cpp: createTraceCCRuntimeManifest('/tracecc') } },
    cpp: { executionTimeoutMs: 20_000, tracingTimeoutMs: 20_000 },
  });
}

function observe(path: JudgePath, reported: unknown): PathObservation {
  const evaluation = ((reported as { evaluation?: unknown }).evaluation ?? reported) as {
    status?: string;
    compile?: { status?: string; diagnostics?: Array<{ message?: string }> };
    cases?: Array<{
      caseId: string;
      status?: string;
      verdict?: { kind?: string };
      value?: unknown;
      failure?: { message?: string };
      diagnostics?: Array<{ message?: string }>;
    }>;
  };
  return {
    path,
    status: evaluation.status,
    compileStatus: evaluation.compile?.status,
    compileMessage: evaluation.compile?.diagnostics?.map((diagnostic) => diagnostic.message ?? '').join('\n').slice(0, 2000),
    cases: (evaluation.cases ?? []).map((row) => ({
      caseId: row.caseId,
      status: row.status,
      verdict: row.verdict?.kind,
      value: row.value,
      message: row.failure?.message ?? row.diagnostics?.[0]?.message,
    })),
  };
}

export async function runNaturalShapes(
  fixtures: readonly NaturalShapeFixture[],
  assetBaseUrl: string
): Promise<Record<string, PathObservation[]>> {
  const out: Record<string, PathObservation[]> = {};
  for (const fixture of fixtures) {
    const bundle = (trace: boolean) => createAlgorithmJudgeBundle({
      id: `natural-shape-${fixture.name}`,
      language: 'cpp',
      code: fixture.code,
      functionName: fixture.functionName,
      executionStyle: fixture.executionStyle,
      trace,
      cases: fixture.cases.map(({ id, input, expected }) => ({ id, input: structuredClone(input), expected: structuredClone(expected) })),
      limits: { wallClockMs: 20_000 },
      comparison: { schema: 'tracecode.judge.comparator.v1', mode: 'exact' },
    });
    const ids = fixture.cases.map(({ id }) => id);
    const observations: PathObservation[] = [];
    for (const path of JUDGE_PATHS) {
      const host = createHost(assetBaseUrl);
      try {
        let reported: unknown;
        if (path === 'submit' || path === 'submit-traced') {
          reported = await host.evaluateAlgorithm({ bundle: await bundle(path === 'submit-traced') });
        } else {
          const caseIds = path === 'run-untraced' ? [] : path === 'run-first-traced' ? ids.slice(0, 1) : ids;
          const result = await host.execute({ bundle: await bundle(true), interactive: true, tracing: { caseIds } });
          reported = result;
          if (result.executionId) await host.disposeExecution(result.executionId);
        }
        observations.push(observe(path, reported));
      } catch (error) {
        observations.push({ path, cases: [], threw: String((error as Error)?.message ?? error).slice(0, 2000) });
      } finally {
        host.dispose();
      }
    }
    out[fixture.name] = JSON.parse(JSON.stringify(observations));
  }
  return out;
}
