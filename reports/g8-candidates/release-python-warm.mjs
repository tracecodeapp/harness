export const releasePythonWarmPlan = ['python', 'csharp'].flatMap((language) =>
  ['binary-search', 'permutations'].flatMap((problem) => [
    { language, cpu: 1, problem, state: 'warm', journey: 'run', target: 20,
      versions: ['0.17.1', 'release-deploy'], continuation: true },
    { language, cpu: 1, problem, state: 'warm', journey: 'submit', target: 20,
      versions: language === 'python'
        ? ['0.17.1', 'release-deploy', '0.20.1']
        : ['0.17.1', 'release-deploy'], continuation: false },
  ]));
