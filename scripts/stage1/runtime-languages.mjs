import { readFileSync } from 'node:fs';

const all = ['typescript', 'javascript', 'python', 'java', 'csharp', 'cpp'];
const affected = new Set(['typescript']);
for (const file of readFileSync(0, 'utf8').trim().split('\n')) {
  const specific = /^(?:packages\/runtime-|workers\/)(javascript|python|java|csharp|cpp)\//u.exec(file)?.[1];
  if (specific) affected.add(specific);
  else if (/^(?:src\/|packages\/|workers\/|scripts\/|package\.json$|pnpm-lock\.yaml$|runtime-assets\.lock\.json$)/u.test(file)) {
    all.forEach((language) => affected.add(language));
  }
}
console.log(all.filter((language) => affected.has(language)).join(','));
