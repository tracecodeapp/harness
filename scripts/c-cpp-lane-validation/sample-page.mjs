import { createAlgorithmJudgeBundle, createBrowserJudgeHost } from '@tracecode/harness/judge';
export async function sample(fixture) {
  const make = (trace) => createAlgorithmJudgeBundle({
    id: 'cpp-macro-operation-unsupported', language: 'cpp', code: fixture.code, functionName: fixture.functionName,
    executionStyle: fixture.executionStyle, trace,
    cases: fixture.cases.slice(0, 1).map(({ id, input, expected }) => ({ id, input, expected })),
    limits: { wallClockMs: 10000 }, comparison: { schema: 'tracecode.judge.comparator.v1', mode: 'exact' },
  });
  const host = createBrowserJudgeHost({ providers: ['cpp'], assetBaseUrl: location.origin + '/workers' });
  try {
    const run = await host.execute({ bundle: await make(true), tracing: { caseIds: [fixture.cases[0].id] } });
    const submit = await host.evaluateAlgorithm({ bundle: await make(false) });
    return JSON.parse(JSON.stringify({ run, submit }));
  } finally { host.dispose(); }
}
