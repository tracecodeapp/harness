import { csharpWarmModes } from './csharp-warm-policy.mjs';
import { pythonWarmModes } from './python-warm-policy.mjs';

const pair = (language, cpu, policy, warmMode) => ({
  language, cpu, problem: 'binary-search', state: 'warm', journey: 'run', target: 20,
  versions: ['0.17.1', policy], continuation: false, pairedControlFor: policy,
  ...(language === 'python' ? { pythonWarmMode: warmMode } : {}),
  ...(language === 'csharp' ? { csharpWarmMode: warmMode } : {}),
});

export const javaClosingPlan = Object.freeze([
  {
    language: 'java', cpu: 1, problem: 'binary-search', state: 'warm', journey: 'lesson',
    target: 20, versions: ['0.17.1'], continuation: false,
  },
  pair('java', 4, 'candidate-main'),
  pair('csharp', 1, 'candidate-main', csharpWarmModes.fresh),
  pair('csharp', 1, 'candidate-deploy', csharpWarmModes.fresh),
  pair('python', 1, 'candidate-main', pythonWarmModes.fresh),
  pair('python', 1, 'candidate-deploy', pythonWarmModes.fresh),
  pair('cpp', 1, 'candidate-deploy'),
]);
