import { isDeepStrictEqual } from 'node:util';
import type { TraceParityRunner } from './browser-trace-parity-entry';
import type { SyntaxParityFixture } from './trace-parity-syntax-cases';
import syntaxPins from './trace-parity-syntax-pins.json' with { type: 'json' };

type Results = Awaited<ReturnType<TraceParityRunner['runSyntaxParity']>>;
type Side = NonNullable<Results[keyof Results]>;
type Mode = Exclude<keyof Results, 'untraced'>;

function outcome(side: Side, id: string) {
  if (side.exception) {
    return { status: 'exception', failure: side.exception, diagnostics: [] };
  }
  const { receipt } = side;
  if (receipt.status === 'compile-failed') {
    return {
      status: receipt.compile?.status ?? 'missing-compile-result',
      failure: receipt.compile?.failure,
      diagnostics: receipt.compile?.diagnostics ?? [],
    };
  }
  const result = receipt.cases[id];
  return result ? {
    status: result.status,
    verdict: result.verdict.kind,
    hasValue: result.hasValue,
    value: result.value,
    failure: result.failure,
    diagnostics: result.diagnostics,
  } : { status: 'missing-case', diagnostics: [] };
}

type Outcome = ReturnType<typeof outcome>;

function learnerCompileError({ status, failure, verdict }: Outcome) {
  return (status === 'compile-failed' || status === 'runtime-error') &&
    verdict !== 'passed' && failure?.origin === 'program' && 'stage' in failure &&
    (failure.stage === 'compile' || failure.stage === 'driver-compile') &&
    failure.message.length > 0;
}

function traceUnavailable({ status, failure, diagnostics }: Outcome) {
  return (status === 'runtime-error' || status === 'exception') &&
    failure?.origin === 'provider' && (
      ('reason' in failure && String(failure.reason) === 'trace-unavailable') ||
      diagnostics.some(({ severity, code }) => severity === 'error' && code === 'trace-unavailable')
    );
}

function compareOutcomes(plain: Outcome, traced: Outcome) {
  const { failure: plainFailure, diagnostics: plainDiagnostics, ...plainResult } = plain;
  const { failure: tracedFailure, diagnostics: tracedDiagnostics, ...tracedResult } = traced;
  const failureKind = (failure: Outcome['failure']) => failure && {
    origin: failure.origin,
    stage: 'stage' in failure ? failure.stage : undefined,
    reason: 'reason' in failure ? failure.reason : undefined,
  };
  const locations = (failure: Outcome['failure'], diagnostics: Outcome['diagnostics']) => ({
    line: failure && 'line' in failure ? failure.line : undefined,
    diagnostics: diagnostics.filter(({ severity, line, column }) =>
      severity === 'error' && (line !== undefined || column !== undefined)
    ).map(({ line, column }) => ({ line, column })),
  });

  const differences: string[] = [];
  if (!isDeepStrictEqual(plainResult, tracedResult) ||
      !isDeepStrictEqual(failureKind(plainFailure), failureKind(tracedFailure))) {
    differences.push('outcome');
  }
  if (plainFailure?.message !== tracedFailure?.message) differences.push('message');
  if (!isDeepStrictEqual(locations(plainFailure, plainDiagnostics), locations(tracedFailure, tracedDiagnostics))) {
    differences.push('location');
  }
  return differences;
}

function compareSyntaxParity(problem: SyntaxParityFixture, result: Results) {
  const issues: Array<{ mode: keyof Results; caseId?: string; differences: string[] }> = [];
  const refusals: Array<{ mode: Mode; caseId: string }> = [];
  const valid = problem.expectation === 'pass';
  const caseIds = problem.cases.map(({ id }) => id);
  const expectedVerdict = valid ? 'passed' : 'failed';
  const executableLine = problem.code.split('\n').findIndex((line) =>
    /^\s*(?:(?:const|let|int)\s+)?result\s*=|^\s*return\s/u.test(line)
  ) + 1;
  if (valid && !executableLine) throw new Error(`${fixtureKey(problem)}: executable anchor missing from fixture`);
  if (result.untraced.receipt?.verdict !== expectedVerdict) {
    issues.push({ mode: 'untraced', differences: ['unexpected-baseline-verdict'] });
  }
  for (const caseId of caseIds) {
    const plain = outcome(result.untraced, caseId);
    if (valid ? plain.status !== 'completed' || plain.verdict !== 'passed' : !learnerCompileError(plain)) {
      issues.push({ mode: 'untraced', caseId, differences: ['unexpected-baseline-outcome'] });
    }
  }

  function compare(mode: Mode, side: Side, ids: string[]) {
    const before = result.untraced.receipt;
    const after = side.receipt;
    const refused = new Set<string>();
    for (const caseId of ids) {
      const actual = outcome(side, caseId);
      const tracesCase = mode !== 'run' || caseId === 'selected';
      if (valid && (tracesCase || side.exception) && traceUnavailable(actual)) {
        refusals.push({ mode, caseId });
        refused.add(caseId);
        continue;
      }
      const differences = compareOutcomes(outcome(result.untraced, caseId), actual);
      if (valid && actual.verdict === 'passed' && Boolean(after?.cases[caseId]?.traceEvents) !== tracesCase) {
        differences.push('trace-selection');
      }
      if (valid && tracesCase &&
          !after?.cases[caseId]?.executableLines?.includes(executableLine)) {
        differences.push('missing-executable-anchor');
      }
      if (differences.length) issues.push({ mode, caseId, differences });
    }
    if (after?.status === 'completed' && !isDeepStrictEqual(Object.keys(after.cases).sort(), [...ids].sort())) {
      issues.push({ mode, differences: ['case-selection'] });
    }
    if (!refused.size && (before?.status !== after?.status || before?.compile?.status !== after?.compile?.status)) {
      issues.push({ mode, differences: ['evaluation-status'] });
    }
    if (mode === 'traced' && after && 'verdict' in after &&
        (refused.size ? after.verdict === 'passed' : after.verdict !== expectedVerdict)) {
      issues.push({ mode, differences: ['submit-verdict'] });
    }
  }

  compare('traced', result.traced, caseIds);
  compare('run', result.run, caseIds);
  if (result.continuation) {
    compare('continuation', result.continuation, ['continuation']);
  } else if (result.run.receipt?.status === 'completed' &&
      !refusals.some(({ mode }) => mode === 'run')) {
    issues.push({ mode: 'continuation', differences: ['missing-continuation'] });
  }
  return { issues, refusals };
}


function fixtureKey({ language, id }: { language: string; id: string }) {
  return language + '/' + id;
}

function fixtureSnapshot({ language, id, style, functionName, executionStyle, expectation, code, cases }: SyntaxParityFixture) {
  return { language, id, style, functionName, executionStyle, expectation, code, cases };
}

export function verifySyntaxPinInventory(fixtures: readonly SyntaxParityFixture[]) {
  const byKey = new Map(fixtures.map((fixture) => [fixtureKey(fixture), fixture]));
  const pinned = new Set<string>();
  for (const { fixture } of syntaxPins.programs) {
    const key = fixtureKey(fixture);
    if (pinned.has(key)) throw new Error(`Duplicate syntax parity pin for ${key}`);
    pinned.add(key);
    const actual = byKey.get(key);
    if (!actual) throw new Error(`${key}: stale pin: remove it (fixture missing)`);
    if (!isDeepStrictEqual(fixture, fixtureSnapshot(actual))) {
      throw new Error(`${key}: pinned syntax parity fixture changed`);
    }
  }
}

function isPinnedCompileShape(side: Side) {
  const receipt = side.receipt;
  return receipt?.status === 'compile-failed' &&
    receipt.compile?.status === 'compile-failed' &&
    receipt.compile.failure?.origin === 'program' &&
    Object.keys(receipt.cases).length === 0 &&
    (!('verdict' in receipt) || receipt.verdict === 'failed');
}

export function checkSyntaxParity(problem: SyntaxParityFixture, result: Results) {
  const comparison = compareSyntaxParity(problem, result);
  const { issues, refusals } = comparison;
  const key = fixtureKey(problem);
  const pin = syntaxPins.programs.find(({ fixture }) => fixtureKey(fixture) === key);
  if (!pin) return { ...comparison, pinnedIssues: [] };

  const sameFixture = isDeepStrictEqual(fixtureSnapshot(problem), pin.fixture);
  if (sameFixture && !issues.length) {
    return { issues: [{ mode: 'traced' as const, differences: ['stale pin: remove it'] }], refusals, pinnedIssues: [] };
  }
  if (
    sameFixture && problem.expectation === 'compile-error' &&
    (problem.language === 'cpp' || problem.language === 'csharp') &&
    issues.every(({ mode }) => mode !== 'untraced') &&
    result.continuation === undefined &&
    [result.untraced, result.traced, result.run].every(isPinnedCompileShape)
  ) {
    // These fixtures fail before any case runs. In the saved report each Run
    // receipt exactly matches traced Submit with the Submit-only verdict omitted.
    const { verdict: _submitVerdict, ...run } = pin.traced;
    const expected = {
      untraced: { receipt: pin.untraced },
      traced: { receipt: pin.traced },
      run: { receipt: run },
    };
    // Compare the same JSON representation the report records. It omits
    // undefined fields, with no normalization of diagnostic values.
    const actual = JSON.parse(JSON.stringify({
      untraced: result.untraced, traced: result.traced, run: result.run,
    }));
    if (isDeepStrictEqual(actual, expected)) {
      return { issues: [], refusals, pinnedIssues: issues };
    }
  }
  issues.push({ mode: 'traced', differences: [sameFixture
    ? 'pinned syntax parity outcomes changed'
    : 'pinned syntax parity fixture changed'] });
  return { ...comparison, pinnedIssues: [] };
}
