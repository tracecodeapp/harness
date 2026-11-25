// B8 direct-entry ledger: every public Judge entry point grades from the
// ordinary owner, on the installed package, in Chromium.
//
//   node tests/test-direct-entry-installed.mjs <unpacked-package-dir> \
//     [--public] [--languages python,javascript,...] [--seeded-control]
//
// Prints one JSON ledger line per assertion:
//   { id: 'B8/<language>/<entry>/<check>', status: 'pass'|'fail'|'missing', detail }
// and exits non-zero on any fail or missing. `--seeded-control` re-checks the
// first language's owner-path evidence with a deliberately wrong worker
// classification; that line must come out `fail`, so the run exits non-zero.
// `--public` is accepted for parity with test-python-ordinary-installed.mjs.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { extname, resolve, sep } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { build } from 'esbuild';
import { chromium } from 'playwright';

const ALL_LANGUAGES = ['python', 'javascript', 'typescript', 'java', 'csharp', 'cpp'];
const args = process.argv.slice(2);
assert.ok(args[0] && !args[0].startsWith('--'), 'Supply the unpacked Harness package directory');
const root = resolve(args[0]);
const seededControl = args.includes('--seeded-control');
const languagesArg = (() => {
  const index = args.indexOf('--languages');
  if (index !== -1) return args[index + 1];
  return args.find((arg) => arg.startsWith('--languages='))?.slice('--languages='.length);
})();
const LANGUAGES = languagesArg
  ? languagesArg.split(',').map((entry) => entry.trim()).filter(Boolean)
  : ALL_LANGUAGES;
for (const language of LANGUAGES) assert.ok(ALL_LANGUAGES.includes(language), `Unknown language ${language}`);

// The two cases every entry point grades. B's expected value is deliberately
// wrong, so the verdicts differ and both come from the ordinary value.
const CASES = [
  { id: 'A', input: { n: 3 }, expected: 4 },
  { id: 'B', input: { n: 5 }, expected: 7 },
];
const EXPECTED_ROWS = {
  A: { value: 4, stdout: '3', verdict: 'passed' },
  B: { value: 6, stdout: '5', verdict: 'failed' },
};

// Per entry: which cases are graded (ordinary) and which are selected for a
// drawing, per traffic window. Windows split at the entry's marks.
const ENTRY_SPECS = {
  'evaluate-all': { windows: { main: { graded: ['A', 'B'], selected: ['A', 'B'] } } },
  'evaluate-selected': { windows: { main: { graded: ['A', 'B'], selected: ['A'] } } },
  'evaluate-singleton': { windows: { main: { graded: ['A'], selected: ['A'] } } },
  'execute-continuation': {
    windows: {
      main: { graded: ['A', 'B'], selected: ['A'] },
      continuation: { graded: [], selected: ['B'], rows: 'continuation' },
      dispose: { graded: [], selected: [] },
    },
  },
  'evaluate-algorithm': { windows: { main: { graded: ['A', 'B'], selected: ['A', 'B'] } } },
  'evaluate-code': { windows: { main: { graded: ['A', 'B'], selected: [] } } },
  'owner-execute': {
    windows: { main: { graded: ['A', 'B'], selected: ['A'] }, dispose: { graded: [], selected: [] } },
  },
  'owner-evaluate-algorithm': { windows: { main: { graded: ['A', 'B'], selected: [] } } },
};

// Phases the Judge test bridge defines (packages/runtime-browser/src/
// browser-runtime-host-internal.ts JudgeSchedulePhase, plus the bridge's own
// 'injection-ack' in src/internal/judge-test-bridge.ts). This page installs no
// faultAt, so 'injection-ack' must not occur either.
const SCHEDULE_PHASES = new Set([
  'ordinary-write-attempt', 'ordinary-commit', 'observer-start', 'observer-end',
  'attachment-bind', 'observation-cache-hit', 'public-resolve',
  // D-WATCH's journal of a healthy batch. A healthy run never rejects
  // progress or meets the service deadline, so 'ordinary-case-rejected' and
  // 'service-deadline' stay undefined here and fail this check if they occur.
  'ordinary-case-started', 'ordinary-case-accepted',
]);

/*
 * Worker command classification. Each learner command is `prepare` (builds an
 * artifact; never graded) or `execute` (runs learner code for the inputs it
 * carries). An execute's role is one of:
 *   ordinary     code-mode execution on the ordinary lease (the only grade source)
 *   observer     observation-only traced execution for a drawing
 *   legacy-trace traced execution that is not observation-only (mixed authority)
 * An execute whose inputs are not one of CASES' inputs is not a learner case
 * (for example C#'s trusted standby prime, inputs { a: 1, b: 2 }).
 * Every reply is matched to its command by worker instance, id and, when the
 * command carried one, protocolToken (WorkerSessionCore, packages/runtime-
 * browser/src/worker-session-core.ts:303). Nonterminal replies are skipped.
 *
 * | language   | worker                                | command                                   | kind    | role
 * | python     | python-worker.js                      | prepare-program                           | prepare | mode code -> ordinary; observationOnly -> observer; else legacy-trace   (python-worker-client.ts:687-694)
 * |            |                                       | execute-prepared-program(-batch)          | execute | mode code -> ordinary (715-718, 766, 803); mode trace + artifact.observationOnly -> observer, else legacy-trace (870-873, 934, 975)
 * |            |                                       | execute-code / execute-with-tracing       | execute | ordinary / legacy-trace (663 / 621)
 * | javascript | javascript-worker.js (coordinator)    | prepare-execution / prepare-observation   | prepare | operation execute-code -> ordinary, execute-with-tracing -> legacy-trace (javascript-worker-client.ts:600-603, 959-976) / observer (1256)
 * | typescript | javascript-worker.js (executor)       | execute-code                              | execute | ordinary (1354-1365; unprepared 1603-1605)
 * |            |                                       | execute-with-tracing                      | execute | legacy-trace (1436-1450; unprepared 1566-1568)
 * |            |                                       | observe-execution                         | execute | observer (1277-1285, carries attemptToken)
 * |            | javascript-ses-algorithm-worker.js    | prepare { programId, source.mode }        | prepare | source.mode code -> ordinary, trace -> legacy-trace (ses-algorithm-worker-client.ts:1127, 1321; javascript-worker-client.ts:1028-1060)
 * |            |                                       | execute-batch { programId }               | execute | role of (worker, programId)'s prepare (1177-1182); reply { id, ok } has no token (614-634)
 * | java       | java-runtime-worker.js                | prepare-runtime-program                   | prepare | observerOnly -> observer; mode code -> ordinary; else legacy-trace (java-worker-client.ts:870-878); reply.programId binds the role
 * |            |                                       | restore-prepared-runtime-program          | prepare | inherits snapshot.programId's role (893-900; java-prepared-provider.ts:185-193)
 * |            |                                       | execute-prepared-runtime-program(-batch)  | execute | attemptToken -> observer (1053-1067); else role of programId (916-919, 961-967, 1090-1097)
 * |            |                                       | execute-code(-batch) / execute-with-tracing | execute | ordinary (810, 840) / legacy-trace (763)
 * | csharp     | csharp-worker.js (compiler, runners)  | prepare-program                           | prepare | mode (csharp-worker-client.ts:637-646)
 * |            |                                       | execute-prepared-code                     | execute | prepared.mode code -> ordinary; prepared.mode trace is the trusted prime (685-690; browser-runtime-provider.ts:236-238)
 * |            |                                       | execute-prepared-trace                    | execute | payload.observation -> observer (825-833); else legacy-trace (762-771)
 * |            |                                       | execute-code(-batch) / execute-with-tracing | execute | ordinary (558, 608) / legacy-trace (900)
 * | cpp        | cpp-worker.js                         | prepare-runtime-program                   | prepare | mode code -> ordinary; observationOnly -> observer; else legacy-trace (cpp-worker-client.ts:1476-1483)
 * |            |                                       | execute-prepared-runtime-program(-batch)  | execute | mode code -> ordinary (1550-1553, 1601-1605); mode trace + attemptToken -> observer, else legacy-trace (1673-1681)
 * |            |                                       | compile-run(-batch) / execute-trace-batch / execute-with-tracing | execute | ordinary (1791-1792, 1820-1821) / legacy-trace (1854, 1907)
 *
 * Python: a batch reply with algorithmFastBatchUnavailable ran nothing; the
 * client retries per case (python-worker-client.ts:829-847), so it is not an
 * acknowledged execution. No language routes learner work through a
 * MessagePort here: the page configures no executionHost, the only
 * MessageChannel user (packages/runtime-browser/src/execution-host.ts:206).
 */
const roleFromMode = (mode, observer) =>
  mode === 'code' ? (observer ? 'invalid' : 'ordinary') : observer ? 'observer' : 'legacy-trace';

function programRole(state, key) {
  return state.programs.get(key) ?? 'unknown-program';
}

const CLASSIFIERS = {
  python: {
    workers: [/\/python-worker\.js$/],
    commands: {
      'prepare-program': (m) => ({ kind: 'prepare', role: roleFromMode(m.mode, m.observationOnly) }),
      'execute-prepared-program': (m) => ({ kind: 'execute', role: roleFromMode(m.mode, m.observationOnly) }),
      'execute-prepared-program-batch': (m) => ({ kind: 'execute', role: roleFromMode(m.mode, m.observationOnly) }),
      'execute-code': () => ({ kind: 'execute', role: 'ordinary' }),
      'execute-with-tracing': () => ({ kind: 'execute', role: 'legacy-trace' }),
    },
  },
  javascript: {
    workers: [/\/javascript-worker\.js$/, /\/javascript-ses-algorithm-worker\.js$/],
    commands: {
      'prepare-execution': (m) => ({
        kind: 'prepare',
        role: m.operation === 'execute-code' ? 'ordinary' : 'legacy-trace',
      }),
      'prepare-observation': () => ({ kind: 'prepare', role: 'observer' }),
      'execute-code': () => ({ kind: 'execute', role: 'ordinary' }),
      'execute-with-tracing': () => ({ kind: 'execute', role: 'legacy-trace' }),
      'observe-execution': (m) => ({ kind: 'execute', role: m.attemptToken ? 'observer' : 'invalid' }),
      prepare: (m, state, worker) => {
        const role = m.sourceMode === 'code' ? 'ordinary' : 'legacy-trace';
        state.programs.set(`${worker}:${m.programId}`, role);
        return { kind: 'prepare', role };
      },
      'execute-batch': (m, state, worker) => ({ kind: 'execute', role: programRole(state, `${worker}:${m.programId}`) }),
    },
  },
  java: {
    workers: [/\/java-runtime-worker\.js$/, /\/java-worker\.js$/],
    commands: {
      'prepare-runtime-program': (m) => ({
        kind: 'prepare',
        role: m.observerOnly ? 'observer' : m.mode === 'code' ? 'ordinary' : 'legacy-trace',
        bindsProgramFromReply: true,
      }),
      'restore-prepared-runtime-program': (m, state) => ({ kind: 'prepare', role: programRole(state, m.snapshotProgramId) }),
      'execute-prepared-runtime-program': (m, state) => ({
        kind: 'execute',
        role: m.attemptToken ? 'observer' : programRole(state, m.programId),
      }),
      'execute-prepared-runtime-program-batch': (m, state) => ({
        kind: 'execute',
        role: m.attemptToken ? 'observer' : programRole(state, m.programId),
      }),
      'execute-code': () => ({ kind: 'execute', role: 'ordinary' }),
      'execute-code-batch': () => ({ kind: 'execute', role: 'ordinary' }),
      'execute-with-tracing': () => ({ kind: 'execute', role: 'legacy-trace' }),
    },
  },
  csharp: {
    workers: [/\/csharp-worker\.js$/],
    commands: {
      'prepare-program': (m) => ({ kind: 'prepare', role: m.mode === 'code' ? 'ordinary' : 'legacy-trace' }),
      'execute-prepared-code': (m) => ({ kind: 'execute', role: m.preparedMode === 'code' ? 'ordinary' : 'legacy-trace' }),
      'execute-prepared-trace': (m) => ({ kind: 'execute', role: m.observation ? 'observer' : 'legacy-trace' }),
      'execute-code': () => ({ kind: 'execute', role: 'ordinary' }),
      'execute-code-batch': () => ({ kind: 'execute', role: 'ordinary' }),
      'execute-with-tracing': () => ({ kind: 'execute', role: 'legacy-trace' }),
    },
  },
  cpp: {
    workers: [/\/cpp-worker\.js$/],
    commands: {
      'prepare-runtime-program': (m) => ({ kind: 'prepare', role: roleFromMode(m.mode, m.observationOnly) }),
      'execute-prepared-runtime-program': (m) => ({ kind: 'execute', role: roleFromMode(m.mode, m.attemptToken) }),
      'execute-prepared-runtime-program-batch': (m) => ({ kind: 'execute', role: roleFromMode(m.mode, m.attemptToken) }),
      'compile-run': () => ({ kind: 'execute', role: 'ordinary' }),
      'compile-run-batch': () => ({ kind: 'execute', role: 'ordinary' }),
      'execute-trace-batch': () => ({ kind: 'execute', role: 'legacy-trace' }),
      'execute-with-tracing': () => ({ kind: 'execute', role: 'legacy-trace' }),
    },
  },
};
CLASSIFIERS.typescript = CLASSIFIERS.javascript;

// Seeded control: a deliberately wrong table that reads code-mode execution as
// traced. Checks run with it must fail; if they pass, the ledger has no teeth.
function wrongClassifier(language) {
  const right = CLASSIFIERS[language];
  const commands = {};
  for (const [type, classify] of Object.entries(right.commands)) {
    commands[type] = (...input) => {
      const result = classify(...input);
      return result.role === 'ordinary' ? { ...result, role: 'legacy-trace' } : result;
    };
  }
  return { ...right, commands };
}

const NONTERMINAL_REPLIES = new Set([
  'runtime-progress', 'batch-case-progress', 'kernel-syscall', 'project-event',
  'compiler-artifact-cache-request', 'worker-ready', 'idle-timeout',
]);
const isNonterminal = (type) => NONTERMINAL_REPLIES.has(type) || (typeof type === 'string' && type.startsWith('kernel-'));
// Command types that run learner code; anything matching that no table row
// names fails B8/<language>/protocol/unclassified-commands.
const EXECUTION_LIKE = /execute|observe|trac|compile-run/;
// Trusted commands that run no learner code: the JS executor prewarm
// (javascript-worker-client.ts:390) and the TraceCC compiler service's
// asset prewarm and compiles (tracecc-compiler-service.ts:134, 174, 197).
const NOT_LEARNER_COMMANDS = new Set([
  'prewarm-executor', 'prewarm-trusted-tracecc-assets', 'compile-trusted-tracecc',
]);

function caseOfInput(input) {
  return CASES.find((testCase) => isDeepStrictEqual(testCase.input, input))?.id;
}

/** Classify every learner command in a language run's traffic log. */
function classifyTraffic(traffic, classifier) {
  const state = { programs: new Map() };
  const workerPaths = new Map();
  const pendingPrepares = new Map();
  const commands = [];
  const unclassified = [];
  const strangers = new Map();
  traffic.forEach((entry, index) => {
    if (entry.dir === 'spawn') workerPaths.set(entry.worker, entry.path);
    const path = workerPaths.get(entry.worker) ?? '';
    const ours = classifier.workers.some((pattern) => pattern.test(path));
    if (entry.dir === 'recv') {
      const prepare = pendingPrepares.get(`${entry.worker}:${entry.id}`);
      if (prepare && !isNonterminal(entry.type) && entry.type !== 'error' && entry.programId !== undefined) {
        state.programs.set(entry.programId, prepare.role);
        pendingPrepares.delete(`${entry.worker}:${entry.id}`);
      }
      return;
    }
    if (entry.dir !== 'send') return;
    if (!ours) {
      if (EXECUTION_LIKE.test(entry.type ?? '')) strangers.set(`${path} ${entry.type}`, true);
      return;
    }
    const classify = classifier.commands[entry.type];
    if (!classify) {
      if (EXECUTION_LIKE.test(entry.type ?? '') && !NOT_LEARNER_COMMANDS.has(entry.type)) unclassified.push(`${path}:${entry.type}`);
      return;
    }
    const { kind, role, bindsProgramFromReply } = classify(entry, state, entry.worker);
    if (bindsProgramFromReply) pendingPrepares.set(`${entry.worker}:${entry.id}`, { role });
    const inputs = entry.inputBatch ?? (entry.inputs !== undefined ? [entry.inputs] : []);
    const caseIds = inputs.map(caseOfInput);
    const learnerInputs = caseIds.filter(Boolean).length;
    commands.push({
      index,
      worker: entry.worker,
      path,
      type: entry.type,
      kind,
      role,
      caseIds,
      learner: kind === 'prepare' ? true : learnerInputs > 0,
      mixedInputs: learnerInputs > 0 && learnerInputs !== caseIds.length,
      reply: kind === 'execute' ? correlate(traffic, index, entry) : undefined,
    });
  });
  return { commands, unclassified: [...new Set(unclassified)], strangers: [...strangers.keys()] };
}

function correlate(traffic, sendIndex, send) {
  const tokenMismatches = [];
  for (let index = sendIndex + 1; index < traffic.length; index += 1) {
    const entry = traffic[index];
    if (entry.worker !== send.worker) continue;
    if (entry.dir === 'terminate') return { index, terminated: true, acked: false, tokenMismatches };
    if (entry.dir !== 'recv' || entry.id !== send.id) continue;
    if (entry.type === undefined && typeof entry.ok === 'boolean') {
      // SES lane reply { id, ok, value|error }: correlated by id only.
      return { index, type: 'ses-reply', acked: entry.ok, tokenMismatches };
    }
    if (send.protocolToken !== undefined && entry.protocolToken !== send.protocolToken) {
      tokenMismatches.push(index);
      continue;
    }
    if (isNonterminal(entry.type)) continue;
    const acked = entry.type !== 'error' && entry.algorithmFastBatchUnavailable !== true;
    return { index, type: entry.type, acked, success: entry.success, tokenMismatches };
  }
  return { acked: false, missing: true, tokenMismatches };
}

// --------------------------------------------------------------------------
// Ledger
// --------------------------------------------------------------------------
const ledger = [];
let quiet = false;
function record(id, status, detail) {
  const line = { id, status, detail };
  ledger.push(line);
  if (!quiet) console.log(JSON.stringify(line));
}
const check = (id, ok, detail) => record(id, ok ? 'pass' : 'fail', detail);

function counts(list) {
  const map = {};
  for (const item of list) map[item ?? '(none)'] = (map[item ?? '(none)'] ?? 0) + 1;
  return map;
}

function windowsOf(entry) {
  const marks = [{ label: 'main', ...entry.from }, ...entry.marks, { label: '(end)', ...entry.to }];
  const result = {};
  for (let index = 0; index < marks.length - 1; index += 1) {
    result[marks[index].label] = {
      traffic: [marks[index].traffic, marks[index + 1].traffic],
      events: [marks[index].events, marks[index + 1].events],
    };
  }
  return result;
}

function checkRows(prefix, rows, graded, selected) {
  if (!Array.isArray(rows)) {
    for (const name of ['rows-value-stdout', 'rows-verdict', 'rows-attachment', 'rows-trace-drawn-only', 'rows-legacy-fields']) {
      record(`${prefix}/${name}`, 'missing', 'the entry returned no rows');
    }
    return;
  }
  const ids = rows.map((row) => row.caseId);
  const valueProblems = [];
  if (!isDeepStrictEqual(ids, graded)) valueProblems.push(`rows ${JSON.stringify(ids)} != ${JSON.stringify(graded)}`);
  for (const row of rows) {
    const want = EXPECTED_ROWS[row.caseId];
    if (!want) continue;
    if (row.status !== 'completed') valueProblems.push(`${row.caseId} status ${row.status}${row.failure ? ` (${row.failure.message})` : ''}`);
    if (!row.hasValue || !isDeepStrictEqual(row.value, want.value)) valueProblems.push(`${row.caseId} value ${JSON.stringify(row.value)}`);
    if (typeof row.stdout !== 'string' || row.stdout.trimEnd() !== want.stdout) valueProblems.push(`${row.caseId} stdout ${JSON.stringify(row.stdout)}`);
  }
  check(`${prefix}/rows-value-stdout`, valueProblems.length === 0, valueProblems.length ? valueProblems : { rows: ids });

  const verdicts = rows.map((row) => [row.caseId, row.verdict]);
  check(`${prefix}/rows-verdict`,
    rows.every((row) => !EXPECTED_ROWS[row.caseId] || row.verdict === EXPECTED_ROWS[row.caseId].verdict),
    { verdicts });

  const attachmentProblems = [];
  for (const row of rows) {
    const isSelected = selected.includes(row.caseId);
    if (isSelected && !row.hasAttachment) attachmentProblems.push(`${row.caseId} selected but has no attachment`);
    if (!isSelected && row.hasAttachment) attachmentProblems.push(`${row.caseId} unselected but has attachment ${row.attachmentStatus}`);
    if (!isSelected && row.hasTrace) attachmentProblems.push(`${row.caseId} unselected but has trace`);
  }
  check(`${prefix}/rows-attachment`, attachmentProblems.length === 0, attachmentProblems.length ? attachmentProblems : {
    attachments: rows.map((row) => [row.caseId, row.hasAttachment ? row.attachmentStatus : null, row.attachmentReason ?? null]),
  });

  const traceProblems = rows
    .filter((row) => row.hasTrace && !(row.hasAttachment && ['drawn', 'truncated'].includes(row.attachmentStatus)))
    .map((row) => `${row.caseId} trace with attachment ${row.hasAttachment ? row.attachmentStatus : 'absent'}`);
  check(`${prefix}/rows-trace-drawn-only`, traceProblems.length === 0, traceProblems.length ? traceProblems : {
    traces: rows.map((row) => [row.caseId, row.hasTrace ? row.traceEvents ?? 'present' : null]),
  });

  const legacy = rows.flatMap((row) => [
    ...row.legacyOwn.map((key) => `${row.caseId}.${key}`),
    ...row.diagnostics.filter((diagnostic) => diagnostic.code === 'trace-unavailable').map(() => `${row.caseId} trace-unavailable diagnostic`),
  ]);
  check(`${prefix}/rows-legacy-fields`, legacy.length === 0, legacy.length ? legacy : 'none');
}

function checkBridge(prefix, events, graded, selected) {
  const writes = events.filter((event) => event.phase === 'ordinary-write-attempt').map((event) => event.caseId);
  const expectedWrites = counts(graded);
  check(`${prefix}/bridge-ordinary-write`, isDeepStrictEqual(counts(writes), expectedWrites),
    { observed: counts(writes), expected: expectedWrites });
  const starts = events.filter((event) => event.phase === 'observer-start').map((event) => event.caseId);
  const startCounts = counts(starts);
  const unselectedStarts = starts.filter((caseId) => !selected.includes(caseId));
  const duplicateStarts = Object.entries(startCounts).filter(([, count]) => count > 1).map(([caseId]) => caseId);
  check(`${prefix}/bridge-observer-start`, unselectedStarts.length === 0 && duplicateStarts.length === 0,
    { observed: startCounts, selected });
  const undefinedEvents = events.filter((event) => !SCHEDULE_PHASES.has(event.phase));
  check(`${prefix}/bridge-undefined-events`, undefinedEvents.length === 0,
    undefinedEvents.length ? counts(undefinedEvents.map((event) => event.phase)) : { phases: counts(events.map((event) => event.phase)) });
}

function checkWorkers(prefix, commands, graded, selected, language) {
  const executes = commands.filter((command) => command.kind === 'execute' && command.learner);
  const ordinary = executes.filter((command) => command.role === 'ordinary');
  const ackedOrdinaryCases = ordinary.filter((command) => command.reply?.acked).flatMap((command) => command.caseIds);
  const expected = counts(graded);
  check(`${prefix}/worker-ordinary-once`, isDeepStrictEqual(counts(ackedOrdinaryCases), expected), {
    acked: counts(ackedOrdinaryCases),
    expected,
    ordinaryCommands: ordinary.map((command) => `${command.type}@w${command.worker}[${command.caseIds}]${command.reply?.acked ? '' : ' unacked'}`),
  });

  const traced = executes.filter((command) => command.role !== 'ordinary' && command.role !== 'observer');
  check(`${prefix}/worker-no-legacy-trace`, traced.length === 0 && executes.every((command) => !command.mixedInputs),
    traced.length || executes.some((command) => command.mixedInputs)
      ? traced.map((command) => `${command.role}:${command.type}@w${command.worker}[${command.caseIds}]`)
        .concat(executes.filter((command) => command.mixedInputs).map((command) => `mixed inputs ${command.type}@w${command.worker}`))
      : 'none');

  const observers = executes.filter((command) => command.role === 'observer');
  const observedCases = observers.flatMap((command) => command.caseIds);
  const outside = observedCases.filter((caseId) => !selected.includes(caseId));
  check(`${prefix}/worker-observer-selected`, outside.length === 0, {
    observed: counts(observedCases),
    selected,
    unacked: observers.filter((command) => !command.reply?.acked).length,
  });

  const ordinaryWorkers = new Set(ordinary.map((command) => command.worker));
  const tracedWorkers = new Set(executes.filter((command) => command.role !== 'ordinary').map((command) => command.worker));
  const shared = [...ordinaryWorkers].filter((worker) => tracedWorkers.has(worker));
  // Python draws sequentially on the verdict's warm worker (F2, #92): an
  // observer may share that worker only after every ordinary execution on it.
  const sequential = language === 'python' && shared.every((worker) => {
    const onWorker = executes.filter((command) => command.worker === worker);
    const lastOrdinary = Math.max(...onWorker.filter((command) => command.role === 'ordinary').map((command) => command.index));
    return onWorker.filter((command) => command.role !== 'ordinary')
      .every((command) => command.role === 'observer' && command.index > lastOrdinary);
  });
  check(`${prefix}/worker-lease-separation`, shared.length === 0 || sequential,
    { ordinaryWorkers: [...ordinaryWorkers], tracedWorkers: [...tracedWorkers], shared, sequentialOnVerdictWorker: sequential });

  const uncorrelated = executes.filter((command) => !command.reply || command.reply.missing || command.reply.tokenMismatches.length > 0);
  const failedOrdinary = ordinary.filter((command) => command.reply && !command.reply.missing && !command.reply.acked);
  check(`${prefix}/worker-correlation`, uncorrelated.length === 0 && failedOrdinary.length === 0, {
    executions: executes.length,
    uncorrelated: uncorrelated.map((command) => `${command.type}@w${command.worker}${command.reply?.tokenMismatches?.length ? ' token-mismatch' : ' no-terminal-reply'}`),
    failedOrdinary: failedOrdinary.map((command) => `${command.type}@w${command.worker}:${command.reply.type}`),
  });
}

function judgeLanguage(language, evidence, classifier = CLASSIFIERS[language], only) {
  const { commands, unclassified, strangers } = classifyTraffic(evidence.traffic, classifier);
  if (!only) {
    check(`B8/${language}/protocol/unclassified-commands`, unclassified.length === 0,
      { unclassified, otherWorkerExecutionCommands: strangers });
    console.log(JSON.stringify({
      witness: 'b8-classified-commands',
      language,
      commands: counts(commands.map((command) => `${command.kind}:${command.type}:${command.role}${command.learner ? '' : ':non-learner'}`)),
    }));
  }
  for (const entry of evidence.entries) {
    if (only && entry.name !== only.entry) continue;
    const spec = ENTRY_SPECS[entry.name];
    const prefix = `B8/${language}/${entry.name}${only ? `/${only.suffix}` : ''}`;
    if (!only) check(`${prefix}/completed`, entry.error === undefined, entry.error ?? 'resolved');
    const windows = windowsOf(entry);
    for (const [label, expectation] of Object.entries(spec.windows)) {
      const windowPrefix = label === 'main' ? prefix : `${prefix}/${label}`;
      const window = windows[label];
      if (!window || entry.error !== undefined) {
        const reason = entry.error !== undefined ? `entry threw: ${entry.error}` : `window ${label} was never reached`;
        const names = only ? ['worker-ordinary-once'] : [
          ...(label === 'dispose' ? [] : ['rows-value-stdout', 'rows-verdict', 'rows-attachment', 'rows-trace-drawn-only', 'rows-legacy-fields']),
          'bridge-ordinary-write', 'bridge-observer-start', 'bridge-undefined-events',
          'worker-ordinary-once', 'worker-no-legacy-trace', 'worker-observer-selected', 'worker-lease-separation', 'worker-correlation',
        ];
        for (const name of names) record(`${windowPrefix}/${name}`, 'missing', reason);
        continue;
      }
      const inWindow = commands.filter((command) => command.index >= window.traffic[0] && command.index < window.traffic[1]);
      if (only) {
        const before = ledger.length;
        quiet = true;
        try {
          checkWorkers(windowPrefix, inWindow, expectation.graded, expectation.selected, language);
        } finally {
          quiet = false;
        }
        // Keep only the ordinary-once line for the seeded control.
        const lines = ledger.splice(before);
        return lines.find((line) => line.id.endsWith('/worker-ordinary-once'));
      }
      if (label !== 'dispose') {
        const rows = expectation.rows === 'continuation' ? entry.output?.continuation?.cases : entry.output?.evaluation?.cases;
        const rowGraded = expectation.rows === 'continuation' ? expectation.selected : expectation.graded;
        checkRows(windowPrefix, rows, rowGraded, expectation.selected);
      }
      checkBridge(windowPrefix, evidence.events.slice(window.events[0], window.events[1]), expectation.graded, expectation.selected);
      checkWorkers(windowPrefix, inWindow, expectation.graded, expectation.selected, language);
    }
    if (!only && entry.name === 'execute-continuation' && entry.error === undefined) {
      check(`${prefix}/execution-id`, entry.output?.hasExecutionId === true && entry.output?.sameExecutionId === true,
        { hasExecutionId: entry.output?.hasExecutionId, sameExecutionId: entry.output?.sameExecutionId });
    }
  }
  return undefined;
}

// --------------------------------------------------------------------------
// Installed package, staged assets, page entry
// --------------------------------------------------------------------------
const syncLanguages = [...new Set(LANGUAGES.map((language) => (language === 'typescript' ? 'javascript' : language)))];
execFileSync(process.execPath, [
  resolve(root, 'dist/cli.cjs'), 'sync-assets', resolve(root, 'staged/workers'), '--languages', syncLanguages.join(','),
], { stdio: 'inherit' });
await build({
  entryPoints: ['tests/fixtures/direct-entry-installed-entry.mjs'],
  outfile: resolve(root, 'staged/direct-entry.js'),
  bundle: true,
  platform: 'browser',
  format: 'esm',
  nodePaths: [resolve('node_modules')],
  alias: {
    'tracecode-harness-under-test/judge': resolve(root, 'dist/judge.js'),
    zlib: resolve(root, 'dist/zlib-browser-shim.js'),
    'node:zlib': resolve(root, 'dist/zlib-browser-shim.js'),
  },
});

const contentTypes = {
  '.js': 'text/javascript',
  '.mjs': 'text/javascript',
  '.wasm': 'application/wasm',
  '.json': 'application/json',
};
const assets = new Map();
const server = createServer(async (request, response) => {
  const { pathname } = new URL(request.url, 'http://localhost');
  if (pathname === '/') {
    response.writeHead(200, { 'content-type': 'text/html' }).end('<!doctype html><meta charset="utf-8">');
    return;
  }
  const path = resolve(root, '.' + decodeURIComponent(pathname));
  if (!path.startsWith(root + sep) || !pathname.startsWith('/staged/')) {
    response.writeHead(404).end();
    return;
  }
  try {
    const bytes = await readFile(path);
    if (pathname.endsWith('.js') || pathname.endsWith('.wasm')) {
      assets.set(pathname, createHash('sha256').update(bytes).digest('hex'));
    }
    response.writeHead(200, { 'content-type': contentTypes[extname(path)] ?? 'application/octet-stream' }).end(bytes);
  } catch {
    response.writeHead(404).end();
  }
});
await new Promise((done) => server.listen(0, '127.0.0.1', done));

async function launch() {
  // Full Chromium on Linux, as the learner-failure matrix uses; the headless
  // shell elsewhere or when the full build is not installed.
  if (process.platform === 'linux') {
    try {
      return await chromium.launch({ channel: process.env.DIRECT_ENTRY_BROWSER_CHANNEL || 'chromium' });
    } catch (error) {
      console.error(`full Chromium unavailable (${error.message.split('\n')[0]}); using the default headless build`);
    }
  }
  return chromium.launch();
}

let browser;
const evidenceByLanguage = new Map();
try {
  browser = await launch();
  for (const language of LANGUAGES) {
    const page = await browser.newPage();
    page.setDefaultTimeout(30 * 60_000);
    page.on('console', (message) => {
      if (message.type() === 'error') console.error(`[${language} console] ${message.text().slice(0, 500)}`);
    });
    page.on('pageerror', (error) => console.error(`[${language} pageerror] ${error.message}`));
    await page.goto(`http://127.0.0.1:${server.address().port}/`);
    let watchdog;
    try {
      const evidence = await Promise.race([
        page.evaluate(async ({ language, cases }) => {
          const { run } = await import('/staged/direct-entry.js');
          return run({ language, cases });
        }, { language, cases: CASES }),
        new Promise((_, reject) => {
          watchdog = setTimeout(() => reject(new Error(`${language} exceeded its 25-minute deadline`)), 25 * 60_000);
        }),
        new Promise((_, reject) => page.once('crash', () => reject(new Error(`${language} page crashed`)))),
      ]);
      evidenceByLanguage.set(language, evidence);
      check(`B8/${language}/warmup/completed`, evidence.warmup.error === undefined, evidence.warmup.error ?? evidence.warmup.result);
      judgeLanguage(language, evidence);
    } catch (error) {
      record(`B8/${language}/run/completed`, 'fail', error.message);
      for (const name of Object.keys(ENTRY_SPECS)) {
        record(`B8/${language}/${name}/completed`, 'missing', `language run failed: ${error.message}`);
      }
    } finally {
      clearTimeout(watchdog);
      await page.close().catch(() => undefined);
    }
  }
} finally {
  await browser?.close();
  await new Promise((done) => server.close(done));
}

if (seededControl) {
  const language = LANGUAGES.find((candidate) => evidenceByLanguage.has(candidate));
  if (!language) {
    record('B8/seeded-control/wrong-classification', 'missing', 'no language produced evidence');
  } else {
    const line = judgeLanguage(language, evidenceByLanguage.get(language), wrongClassifier(language), {
      entry: 'owner-execute',
      suffix: 'seeded-wrong-classification',
    });
    if (line) {
      ledger.push(line);
      console.log(JSON.stringify(line));
      console.log(JSON.stringify({
        witness: 'b8-seeded-control',
        language,
        expected: 'fail',
        observed: line.status,
        bites: line.status === 'fail',
      }));
      if (line.status !== 'fail') {
        record(`B8/${language}/seeded-control/bites`, 'fail', 'the wrong classification passed worker-ordinary-once');
      }
    } else {
      record(`B8/${language}/seeded-control/wrong-classification`, 'missing', 'owner-execute evidence is unavailable');
    }
  }
}

const summary = counts(ledger.map((line) => line.status));
console.log(JSON.stringify({
  witness: 'b8-direct-entry-ledger',
  languages: LANGUAGES,
  seededControl,
  summary,
  failed: ledger.filter((line) => line.status !== 'pass').map((line) => line.id),
  assets: Object.fromEntries([...assets].filter(([path]) => !path.includes('/pyodide-')).sort()),
}));
if (ledger.length === 0 || ledger.some((line) => line.status !== 'pass')) process.exitCode = 1;
