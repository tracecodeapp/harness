export const releasePythonWarmPlan = ['binary-search', 'permutations'].flatMap((problem) => [
  { language: 'python', cpu: 1, problem, state: 'warm', journey: 'run', target: 20,
    versions: ['0.17.1', 'release-deploy'], continuation: true },
  { language: 'python', cpu: 1, problem, state: 'warm', journey: 'submit', target: 20,
    versions: ['0.17.1', 'release-deploy', '0.20.1'], continuation: false },
]);
