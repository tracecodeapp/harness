import {
  allCasesPassPolicy,
  createAlgorithmJudgeBundle,
  createBrowserJudgeHost,
} from 'probe-judge';

export async function openJudge() {
  if (crossOriginIsolated) throw new Error('The 0.21 rig uses a non-isolated document');
  const host = createBrowserJudgeHost({ assetBaseUrl: '/workers', providers: ['python'] });
  const ready = await host.warmLanguage('python');
  if (!ready.success) throw new Error('Python did not warm');
  let sequence = 0;

  return {
    async run(fixture, sample) {
      const bundle = await createAlgorithmJudgeBundle({
        ...fixture,
        id: 'phase0-m2-' + sequence++,
        language: 'python',
        trace: false,
        policy: allCasesPassPolicy(),
      });
      const started = sample ? performance.now() : undefined;
      const result = await host.evaluateAlgorithm({ bundle });
      const totalMs = sample ? performance.now() - started : undefined;
      const { evaluation } = result;
      const compile = evaluation.compile?.timings;
      const cases = evaluation.cases ?? [];
      const compileMs = compile?.compileMs ?? compile?.totalMs;
      const caseMs = cases[0]?.timings?.runMs ?? cases[0]?.timings?.totalMs;
      const phasesAvailable = [compileMs, caseMs].every(
        (value) => Number.isFinite(value) && value >= 0,
      );
      const caseVerdicts = cases.map((entry) => ({
        id: entry.caseId,
        status: entry.status,
        verdict: entry.verdict?.kind,
        failure: entry.failure?.kind ?? null,
        drawing: Boolean(entry.trace || entry.traceUnavailable),
      }));
      const pass = result.verdict === 'passed' && caseVerdicts.length === 1 &&
        caseVerdicts[0].id === fixture.cases[0].id &&
        caseVerdicts[0].verdict === 'passed' && !caseVerdicts[0].drawing;
      return {
        verdict: result.verdict,
        caseVerdicts,
        pass,
        compileReceipt: Number.isFinite(compileMs),
        caseReceipt: Number.isFinite(caseMs),
        ...(sample && phasesAvailable && {
          totalMs, compileMs, caseMs, outsideMs: totalMs - compileMs - caseMs,
        }),
      };
    },
  };
}
