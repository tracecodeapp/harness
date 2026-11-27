import { createAlgorithmJudgeBundle, createBrowserJudgeHost } from '@tracecode/harness/judge';
import { createTraceCCRuntimeManifest, TRACECC_RUNTIME_ASSET_RELATIVE_PATH } from '@tracecode/harness/tracekernel';

export const programs = {
  python: 'def solve(n):\n    result = n + 1\n    return result\n',
  javascript: 'function solve(n) {\n  const result = n + 1;\n  return result;\n}',
  typescript: 'function solve(n: number): number {\n  const result = n + 1;\n  return result;\n}',
  csharp: 'public class Solution {\n  public int Solve(int n) {\n    int result = n + 1;\n    return result;\n  }\n}',
  java: 'class Solution {\n  public int solve(int n) {\n    int result = n + 1;\n    return result;\n  }\n}',
  cpp: 'class Solution {\npublic:\n  int solve(int n) {\n    int result = n + 1;\n    return result;\n  }\n};',
};

const caseId = 'add-one';
const expected = 8;

function passingRow(evaluation) {
  const row = evaluation.cases?.[0];
  if (evaluation.status !== 'completed' || evaluation.cases.length !== 1 ||
    row?.caseId !== caseId || row.verdict.kind !== 'passed' || row.value !== expected) {
    throw new Error(`Expected ${caseId} to pass with ${expected}. Received ${JSON.stringify(evaluation).slice(0, 1400)}`);
  }
  return row;
}

export async function runCanary(language) {
  const assetBaseUrl = '/workers';
  const assets = language === 'cpp' ? {
    runtimeManifests: {
      cpp: createTraceCCRuntimeManifest(
        `${assetBaseUrl}/${TRACECC_RUNTIME_ASSET_RELATIVE_PATH}`,
        { workerUrl: `${assetBaseUrl}/cpp-worker.js` }
      ),
    },
  } : undefined;
  const host = createBrowserJudgeHost({ providers: [language], assetBaseUrl, assets });
  const program = {
    language, code: programs[language], functionName: language === 'csharp' ? 'Solve' : 'solve',
    executionStyle: ['csharp', 'java', 'cpp'].includes(language) ? 'solution-method' : 'function',
    cases: [{ id: caseId, input: { n: 7 }, expected }],
    limits: { wallClockMs: 20_000 },
    comparison: { schema: 'tracecode.judge.comparator.v1', mode: 'exact' },
  };
  const results = { language };
  let executionId;
  let stage = 'run';
  try {
    const runBundle = await createAlgorithmJudgeBundle({ ...program, id: `canary-${language}-run`, trace: true });
    const run = await host.execute({ bundle: runBundle, interactive: true, signal: AbortSignal.timeout(30_000) });
    executionId = run.executionId;
    const row = passingRow(run.evaluation);
    if (!executionId || row.attachment) throw new Error('Run must retain an execution before any drawing is requested.');
    results.run = row.value;

    stage = 'submit';
    const submitBundle = await createAlgorithmJudgeBundle({ ...program, id: `canary-${language}-submit` });
    const submit = await host.evaluateAlgorithm({ bundle: submitBundle, signal: AbortSignal.timeout(30_000) });
    const submitted = passingRow(submit.evaluation);
    if (submit.verdict !== 'passed' || submitted.attachment) throw new Error('Submit must return an ordinary passing verdict.');
    results.submit = submitted.value;

    stage = 'drawing';
    const drawn = await host.execute({
      executionId, tracing: { caseIds: [caseId] }, signal: AbortSignal.timeout(30_000),
    });
    const attachment = passingRow(drawn.evaluation).attachment;
    if (drawn.executionId !== executionId || attachment?.caseId !== caseId ||
      attachment.status !== 'drawn' || !attachment.trace.events.length) {
      throw new Error(`Expected a nonempty drawing for the retained case. Received ${JSON.stringify(attachment).slice(0, 1200)}`);
    }
    results.drawingEvents = attachment.trace.events.length;
  } catch (error) {
    results.failure = { stage, message: error.message };
  } finally {
    try {
      if (executionId) await host.disposeExecution(executionId);
    } finally {
      host.dispose();
    }
  }
  return results;
}
