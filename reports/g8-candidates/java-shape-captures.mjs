// Exact real-capture inventory from the accepted 2026-11-24 S(Java) be2f3d79
// session. Desktop groups rotated both policies in one group; phone groups
// paired each policy with its own 0.17.1 control.
export const javaCapturedShapeKeys = Object.freeze([
  ...['binary-search', 'permutations'].flatMap((problem) =>
    ['warm', 'cold', 'switched'].flatMap((state) => [
      ...['0.17.1', 'candidate-main', 'candidate-deploy'].map((version) =>
        `java|desktop|1|${problem}|${state}|run|continuation|standard|unpaired|${version}`),
      ...['0.17.1', 'candidate-main', 'candidate-deploy'].map((version) =>
        `java|desktop|1|${problem}|${state}|submit|single|standard|unpaired|${version}`),
    ])),
  'java|desktop|1|binary-search|warm|lesson|single|standard|unpaired|0.17.1',
  'java|desktop|1|binary-search|warm|lesson|single|standard|unpaired|candidate-main',
  ...['binary-search', 'permutations'].flatMap((problem) =>
    ['warm', 'cold'].flatMap((state) =>
      ['candidate-main', 'candidate-deploy'].flatMap((policy) => [
        `java|phone|4|${problem}|${state}|run|single|standard|${policy}|0.17.1`,
        `java|phone|4|${problem}|${state}|run|single|standard|${policy}|${policy}`,
      ]))),
]);
