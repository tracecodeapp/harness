export const judgedByteLimitName = 'judged-byte-limit';
export const judgedByteLimit = 1024;

const sources = {
  javascript: 'function solve(n) { return "x".repeat(n); }',
  typescript: 'function solve(n: number): string { return "x".repeat(n); }',
  java: 'class Solution { public String solve(int n) { return "x".repeat(n); } }',
  csharp: 'public class Solution { public string solve(int n) { return new string(\'x\', n); } }',
  cpp: '#include <string>\nclass Solution { public: std::string solve(int n) { return std::string(n, \'x\'); } };',
};

const cases = [
  { id: 'short', input: { n: 64 }, expected: 'x'.repeat(64) },
  { id: 'long', input: { n: 2048 }, expected: 'x'.repeat(2048) },
];

export const judgedByteLimitFixtures = [...Object.keys(sources), 'python'].map((language) => ({
  gate: 'G6',
  name: judgedByteLimitName,
  language,
  code: sources[language],
  functionName: 'solve',
  executionStyle: language === 'javascript' || language === 'typescript' ? 'function' : 'solution-method',
  limits: { wallClockMs: 10000 },
  cases,
  judgedByteLimit: sources[language] ? judgedByteLimit : undefined,
}));

export const judgedByteLimitRequest = {
  id: 'policy', mode: 'submit', selected: [], trace: false, cases: cases.map(({ id }) => id),
};

export function judgedByteLimitId({ gate, language, name }) {
  return `${gate}/${language}/${name}/provider/policy/@request/limit`;
}

export function checkJudgedByteLimit(fixture, observations) {
  const { language } = fixture;
  const result = { id: judgedByteLimitId(fixture), language };
  if (language === 'python') {
    return { ...result, status: 'not-applicable', message: 'Python has no judged-output policy in Harness 0.21' };
  }
  const fail = (message) => ({ ...result, status: 'fail', message });
  const [observation] = observations;
  const markers = (observation?.journal ?? []).filter(({ phase }) => phase === 'judged-output-policy');
  if (!markers.length) {
    const detail = observation?.error?.message ?? observation?.reported?.evaluation?.compile?.failure?.message;
    return fail(detail ? `no policy marker (${detail})` : 'no policy marker');
  }
  if (markers.some((marker) => marker.language !== language || marker.maxBytes !== judgedByteLimit ||
      marker.lowered !== true || typeof marker.evaluationId !== 'string' || !marker.evaluationId)) {
    return fail('policy not honoured: marker did not confirm the 1024-byte cap for this language');
  }
  const evaluation = observation.reported?.evaluation;
  if (observations.length !== 1 || evaluation?.status !== 'completed' || evaluation.cases.length !== cases.length) {
    return fail('policy not honoured: expected one completed evaluation with both cases');
  }
  const short = evaluation.cases.find(({ caseId }) => caseId === 'short');
  const long = evaluation.cases.find(({ caseId }) => caseId === 'long');
  if (short?.status !== 'completed' || short.value !== cases[0].expected || short.verdict?.kind !== 'passed') {
    return fail('policy not honoured: 64-character answer did not complete with the expected value');
  }
  const hasValue = long?.value !== undefined && long.value?.['$gate.undefined'] !== true;
  if (!long || long.status === 'completed' || long.failure?.origin !== 'limit' ||
      long.failure.reason !== 'serialization-limit' || hasValue) {
    return fail('policy not honoured: 2048-character answer did not return serialization-limit with no value');
  }
  return { ...result, status: 'pass' };
}
