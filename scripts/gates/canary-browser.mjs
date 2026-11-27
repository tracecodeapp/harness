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
  const bridgeKey = Symbol.for('@tracecode/harness/internal/judge-test-bridge/v1');
  const previous = Object.getOwnPropertyDescriptor(globalThis, bridgeKey);
  const events = [];
  const stalled = Promise.withResolvers();
  const held = Promise.withResolvers();
  Object.defineProperty(globalThis, bridgeKey, {
    configurable: true,
    value: {
      onEvent(event) {
        events.push(event);
        if (event.phase === 'injection-ack' && event.fault === 'stall' && event.caseId === caseId) stalled.resolve();
      },
      faultAt: ({ point }) => point === 'observe' ? 'stall' : undefined,
      releaseStall: () => held.promise,
    },
  });
  const program = {
    language, code: programs[language], functionName: language === 'csharp' ? 'Solve' : 'solve',
    executionStyle: ['csharp', 'java', 'cpp'].includes(language) ? 'solution-method' : 'function',
    cases: [{ id: caseId, input: { n: 7 }, expected }],
    limits: { wallClockMs: 20_000 },
    comparison: { schema: 'tracecode.judge.comparator.v1', mode: 'exact' },
  };
  const results = { language };
  let host;
  let executionId;
  let stage = 'run';
  try {
    host = createBrowserJudgeHost({ providers: [language], assetBaseUrl, assets });
    const runBundle = await createAlgorithmJudgeBundle({ ...program, id: `canary-${language}-run`, trace: true });
    const run = await host.execute({
      bundle: runBundle, interactive: true, drawingDelivery: 'after-verdict',
      tracing: { caseIds: [caseId] }, signal: AbortSignal.timeout(30_000),
    });
    executionId = run.executionId;
    const row = passingRow(run.evaluation);
    if (!executionId || run.deferredDrawings?.length !== 1 || run.deferredDrawings[0] !== caseId ||
        Object.hasOwn(row, 'attachment') || Object.hasOwn(row, 'trace')) {
      throw new Error('Run must return an attachment-free verdict and retain the selected drawing.');
    }
    results.run = row.value;

    stage = 'drawing';
    const { length: split } = events;
    const pending = host.execute({
      executionId, tracing: { caseIds: [caseId] }, signal: AbortSignal.timeout(30_000),
    });
    try {
      await Promise.race([stalled.promise, pending.then(() => {
        throw new Error('Drawing returned before the observer stall was released.');
      })]);
    } finally {
      held.resolve();
    }
    const drawn = await pending;
    const attachment = passingRow(drawn.evaluation).attachment;
    if (drawn.executionId !== executionId || attachment?.caseId !== caseId ||
      attachment.status !== 'drawn' || !attachment.trace.events.length) {
      throw new Error(`Expected a nonempty drawing for the retained case. Received ${JSON.stringify(attachment).slice(0, 1200)}`);
    }
    results.drawingEvents = attachment.trace.events.length;
    const phase = (name) => events.filter(({ phase }) => phase === name);
    const [commit] = phase('ordinary-commit');
    const [initial, continuation] = phase('public-resolve');
    const [end] = phase('observer-end');
    const [bind] = phase('attachment-bind');
    if (phase('public-resolve').length !== 2 || phase('ordinary-commit').length !== 1 ||
        phase('observer-start').length !== 1 || phase('attachment-bind').length !== 1 ||
        initial?.request !== 'initial' || continuation?.request !== 'continuation' ||
        ![initial, continuation, end, bind, attachment].every((event) => event &&
          ['evaluationId', 'workspaceDigest', 'generation'].every((key) => event[key] === commit[key])) ||
        !(events.indexOf(commit) < events.indexOf(initial) && events.indexOf(initial) < events.indexOf(end) &&
          events.indexOf(end) < events.indexOf(bind) && events.indexOf(bind) < events.indexOf(continuation)) ||
        events.slice(split).some(({ phase }) => phase === 'ordinary-write-attempt')) {
      throw new Error('Run and drawing did not produce the deferred Judge event order.');
    }

    stage = 'submit';
    const submitBundle = await createAlgorithmJudgeBundle({ ...program, id: `canary-${language}-submit` });
    const submit = await host.evaluateAlgorithm({ bundle: submitBundle, signal: AbortSignal.timeout(30_000) });
    const submitted = passingRow(submit.evaluation);
    if (submit.verdict !== 'passed' || submitted.attachment) throw new Error('Submit must return an ordinary passing verdict.');
    results.submit = submitted.value;
  } catch (error) {
    results.failure = { stage, message: error.message };
  } finally {
    held.resolve();
    try {
      if (executionId) await host.disposeExecution(executionId);
    } finally {
      host?.dispose();
      if (previous) Object.defineProperty(globalThis, bridgeKey, previous);
      else delete globalThis[bridgeKey];
    }
  }
  return results;
}
