import { spawnSync } from 'node:child_process';

export const cppStep7Subject = '9b30ad9bc203ad2ba2f159d96dfaef62940262c7';
export const cppValueAdapterMerge = '9fcf520ae26f43ae1580aeb7b857bdf3b66ced82';
const qualificationPins = new Set([
  '39b2119a72d5afe003dbc6d66aba19633c15292f',
  '46943f54e42abcd5c008ac88261446a89a3fd270',
]);
const fallbackPins = new Set([
  cppValueAdapterMerge,
  '77b6545d7e1b4c714a0de80d3267b4c34a53121c',
  '98068e382702ca0719aeadfcbe28f3d4b1249ec4',
]);

export function admitsCppValueAdapter(subject, source, merge = cppValueAdapterMerge) {
  // These two packages qualified the implementation before it was merged.
  if (qualificationPins.has(subject)) return true;
  if (source && /^[a-f0-9]{40}$/.test(subject)) {
    const git = (...args) => spawnSync('git', ['-C', source, ...args], { encoding: 'utf8' });
    const ancestry = git('merge-base', '--is-ancestor', merge, subject).status;
    if (ancestry === 0) return true;
    if (ancestry === 1 && (
      git('rev-parse', '--is-shallow-repository').stdout?.trim() === 'false' ||
      git('merge-base', '--is-ancestor', subject, merge).status === 0
    )) return false;
  }
  // A pin can outlive its Git mirror, or the mirror can cut off its ancestry.
  return fallbackPins.has(subject);
}
