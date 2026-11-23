import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { families, legacyCases } from './legacy-cases.mjs';

const [root, reportPath] = process.argv.slice(2);
if (!root || !reportPath) throw new Error('Usage: classify-catalog.mjs <catalog directory> <legacy report>');
const { rows } = JSON.parse(readFileSync(reportPath, 'utf8'));
const statuses = new Map(families.map(family => {
  const cases = legacyCases.filter(c => c.family === family);
  const counts = { pass: 0, fail: 0, unexecuted: 0 };
  for (const c of cases) {
    const found = rows.filter(row => row.id === c.id);
    counts[found.length === 1 ? found[0].status : 'unexecuted']++;
  }
  return [family, { ...counts, verdict: counts.fail ? 'fail' : counts.unexecuted ? 'unknown' : 'pass' }];
}));

const scalar = '\\b(?:int|long|short|bool|char|float|double|size_t|u?int\\d+_t)\\b';
const functionDeclaration = /\b(?:int|long|bool|char|double|void|auto|[A-Z]\w*)\s+([A-Za-z_]\w*)\s*\([^;{}]*\)\s*(?:const\s*)?\{/g;
const signatures = [
  ['scalars', new RegExp(scalar)],
  ['loops', /\b(?:for|while|do)\b/],
  ['short circuits', /&&|\|\|/],
  ['aliases and references', /(?:\w|>)\s*&&?\s*[A-Za-z_]\w*\s*(?=[=,);{])|[=,(]\s*&\s*[A-Za-z_]\w*/],
  ['vectors and arrays', /\b(?:vector|array|span)\b|\w\s*\[[^\]\n]+\]/],
  ['strings', /\b(?:string(?:_view)?|wstring|u8string|char_traits|STRING_LITERAL)\b/],
  ['maps and sets', /\b(?:unordered_)?(?:multi)?(?:map|set)\b/],
  ['structs', /\bstruct\b|\b(?:ListNode|TreeNode|Node)\b|->/],
  ['uninitialized locals', new RegExp(scalar + '\\s+[*&]?\\s*\\w+\\s*(?:\\[[^\\]]*\\])?\\s*;')],
  ['other', /\b(?:new|delete|switch|try|throw|catch|union|enum|template|namespace|auto|goto|tuple|queue|deque|stack|list|pair|priority_queue|function|optional|variant)\b|\?\s*[^:]+:|\]\s*\(|\bif\s*\([^\n]*\)\s*(?!\s|\{|return\b)\w/],
];
function classify(source) {
  const cpp = source.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'/g,
    token => token[0] === '/' ? ' ' : token[0] === '"' ? ' STRING_LITERAL ' : ' CHAR_LITERAL ')
    .replace(/^\s*#\s*include[^\n]*$/gm, '');
  const kinds = signatures.filter(([, regex]) => regex.test(cpp)).map(([family]) => family);
  for (const match of cpp.matchAll(functionDeclaration)) {
    const [, name] = match;
    // Scope matching is lexical. Calls in nested bodies count towards this function.
    const tokens = cpp.slice(match.index + match[0].length).matchAll(/[{}]|\b[A-Za-z_]\w*\s*(?=\()/g);
    let depth = 1;
    for (const [token] of tokens) {
      if (token === '{') depth++;
      if (token === '}' && --depth === 0) break;
      if (token.trim() === name) {
        kinds.push('recursion');
        break;
      }
    }
  }
  // Even when every detected kind has a green witness, regexes cannot certify
  // an arbitrary program. Keep such files outside the measured drawing rate.
  return [...new Set(kinds)].sort();
}

function cppFiles(dir) {
  return readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))
    .flatMap(entry => {
      const path = join(dir, entry.name);
      return entry.isDirectory() ? cppFiles(path) : entry.isFile() && /\.cpp$/.test(entry.name) ? [path] : [];
    });
}
const files = cppFiles(root).map(path => {
  const source = readFileSync(path, 'utf8');
  const kinds = classify(source);
  const result = kinds.some(kind => statuses.get(kind)?.verdict === 'fail') ? 'failing-kind'
    : kinds.length && kinds.every(kind => statuses.get(kind)?.verdict === 'pass') ? 'passing-kinds'
    : 'unclassified';
  return { path: relative(root, path), sha256: createHash('sha256').update(source).digest('hex'), kinds, result };
});
if (files.length === 0) throw new Error('Empty catalog');
const summary = Object.fromEntries(['passing-kinds', 'failing-kind', 'unclassified'].map(result =>
  [result, files.filter(file => file.result === result).length]));
console.log(JSON.stringify({
  sourceManifestSha256: createHash('sha256').update(JSON.stringify(files.map(({ path, sha256 }) =>
    [path, sha256]))).digest('hex'),
  total: files.length, summary, families: Object.fromEntries([...statuses].map(([kind, result]) =>
    [kind, { ...result, references: files.filter(file => file.kinds.includes(kind)).length }])),
  files,
}, null, 2));
