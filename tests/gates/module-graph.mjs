import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { posix } from 'node:path';

const ts = createRequire(import.meta.url)('typescript');
const extensions = ['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs', '.json'];
const moduleFile = /\.[cm]?[jt]sx?$/;
const hostInterpreters = new Set(['python3', 'python', 'node', 'bash', 'sh', 'ruby', 'perl']);

function opaqueSite(file, kind, expression) {
  const text = expression.replace(/\s+/g, ' ').trim();
  return {
    file, kind, text,
    key: `${file}:${kind}:${createHash('sha256').update(expression).digest('hex').slice(0, 16)}`,
  };
}

function calleeName(expression) {
  if (ts.isIdentifier(expression)) return expression.text;
  if (ts.isPropertyAccessExpression(expression)) return expression.name.text;
  return '';
}

function references(file, source) {
  const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
  const imports = new Set();
  const entries = new Set();
  const opaque = [];
  const interpreters = new Set();
  const addOpaque = (kind, node) => opaque.push(opaqueSite(file, kind, node.getText(ast)));
  function visit(node) {
    let specifier;
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
      specifier = node.moduleSpecifier;
    } else if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) {
      specifier = node.moduleReference.expression;
    } else if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument)) {
      specifier = node.argument.literal;
    } else if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
      (ts.isIdentifier(node.expression) && node.expression.text === 'require') ||
      (ts.isPropertyAccessExpression(node.expression) && ts.isIdentifier(node.expression.expression) &&
        node.expression.expression.text === 'require' && node.expression.name.text === 'resolve'))) {
      [specifier] = node.arguments;
    }
    if (specifier && ts.isStringLiteralLike(specifier)) imports.add(specifier.text);
    if (ts.isCallExpression(node)) {
      if (node.expression.kind === ts.SyntaxKind.ImportKeyword &&
        (!specifier || !ts.isStringLiteralLike(specifier))) addOpaque('dynamic-import', node);
      if (calleeName(node.expression) === 'importScripts') addOpaque('import-scripts', node);
    }
    if (ts.isNewExpression(node)) {
      const name = calleeName(node.expression);
      if (name === 'Worker' || name === 'NodeWorker') addOpaque('worker', node);
      if (name === 'URL' && node.arguments?.[1]?.getText(ast).replace(/\s/g, '') === 'import.meta.url') {
        addOpaque('module-url', node);
      }
    }
    if (ts.isPropertyAssignment(node) && (node.name.getText(ast).replace(/['"]/g, '') === 'entryPoints' ||
      (/\btsup.*\.ts$/.test(file) && node.name.getText(ast).replace(/['"]/g, '') === 'entry'))) {
      const entry = node.initializer;
      const candidates = ts.isArrayLiteralExpression(entry) ? entry.elements :
        ts.isObjectLiteralExpression(entry) ? entry.properties.filter(ts.isPropertyAssignment).map(p => p.initializer) : [entry];
      for (const candidate of candidates) {
        if (!ts.isStringLiteralLike(candidate)) addOpaque('bundle-entry', candidate);
      }
    }
    // Bundler entryPoints and subprocess argv in these runners often use
    // repository-relative file literals instead of module specifiers.
    if (ts.isStringLiteralLike(node) && /^(?:src|packages|scripts|tests|workers|tools)\//.test(node.text)) {
      entries.add(node.text);
    }
    if (ts.isStringLiteralLike(node) && hostInterpreters.has(node.text)) interpreters.add(node.text);
    ts.forEachChild(node, visit);
  }
  visit(ast);
  return { imports, entries, opaque, interpreters };
}

export function moduleGraph({ files, read, aliases, allowances }) {
  const direct = new Map();

  function localCandidates(file, specifier) {
    // GA bundles this file as stdin relative to the candidate checkout.
    if (file === 'tests/stage1-gates/routes.mjs' && /^\.\/(?:packages|src)\//.test(specifier)) {
      return [specifier.slice(2)];
    }
    if (file === 'tests/fixtures/tracekernel-shared-client-worker.mjs' &&
      specifier === '../../packages/tracekernel/dist/index.js') {
      return ['packages/tracekernel/src/index.ts'];
    }
    // The asset CLI publishes the C++ worker beside workers/shared.
    if (file === 'workers/cpp/cpp-worker.js' && specifier === './shared/runtime-kernel-policy.js') {
      return ['workers/shared/runtime-kernel-policy.js'];
    }
    // dotnet publish creates _framework; the checked-in toolchain pin and
    // runner sources are the Git inputs of the generated runtime.
    if (/^packages\/runtime-csharp\/dotnet\/TraceCode\.CSharpAlgorithmRunner\/runner(?:-controlled)?-worker\.mjs$/.test(file) &&
      specifier === './_framework/dotnet.js') return ['toolchains/csharp/manifest.json'];
    if (specifier.startsWith('.')) return [posix.join(posix.dirname(file), specifier)];
    if (specifier.startsWith('src/')) return [specifier];
    if (/^@tracecode\/harness\/(?:judge|tracekernel)$/.test(specifier)) {
      return [specifier.replace('@tracecode/harness/', 'src/')];
    }
    if (specifier === '@tracecode/harness/package.json') return ['package.json'];
    for (const [pattern, targets] of Object.entries(aliases)) {
      if (pattern === specifier) return targets;
      if (pattern.endsWith('*') && specifier.startsWith(pattern.slice(0, -1))) {
        return targets.map((target) => target.replace('*', specifier.slice(pattern.length - 1)));
      }
    }
    return [];
  }

  function resolve(base) {
    const stem = base.replace(/\.[cm]?jsx?$/, '');
    const candidates = [
      base,
      ...extensions.map((ext) => stem + ext),
      ...extensions.map((ext) => posix.join(base, 'index' + ext)),
    ];
    return candidates.find((candidate) => files.has(candidate));
  }

  function edges(file) {
    if (!direct.has(file)) {
      const dependencies = [];
      const unresolved = [];
      let opaque = [];
      let interpreters = new Set();
      if (moduleFile.test(file)) {
        const refs = references(file, read(file));
        ({ opaque, interpreters } = refs);
        const { imports, entries } = refs;
        for (const specifier of imports) {
          const bases = localCandidates(file, specifier);
          const path = bases.map(resolve).find(Boolean);
          if (path) dependencies.push(path);
          else if (/^(?:@tracecode|src)\//.test(specifier)) {
            opaque.push(opaqueSite(file, 'unresolved-workspace', specifier));
          } else if (bases.length) unresolved.push(`${file}: ${specifier}`);
        }
        for (const entry of entries) {
          if (files.has(entry)) dependencies.push(entry);
        }
        for (const site of opaque) {
          for (const entry of allowances[site.key]?.entries ?? []) {
            if (files.has(entry)) dependencies.push(entry);
            else unresolved.push(`${file}: allowlisted entry ${entry} is missing`);
          }
        }
      } else if (/\.sh$/.test(file)) {
        const source = read(file);
        for (const name of hostInterpreters) {
          if (new RegExp(`(?:^|[\\s/'"])${name}(?=$|[\\s'"])`, 'm').test(source)) interpreters.add(name);
        }
      }
      direct.set(file, { dependencies, unresolved, opaque, interpreters });
    }
    return direct.get(file);
  }

  return (roots) => {
    const parents = new Map(roots.map((file) => [file, null]));
    const unresolved = new Set();
    const opaque = new Map();
    const interpreters = new Map();
    for (const file of parents.keys()) {
      const edge = edges(file);
      for (const error of edge.unresolved) unresolved.add(error);
      for (const site of edge.opaque) opaque.set(site.key, site);
      for (const interpreter of edge.interpreters) {
        if (!interpreters.has(interpreter)) interpreters.set(interpreter, file);
      }
      for (const dependency of edge.dependencies) {
        if (!parents.has(dependency)) parents.set(dependency, file);
      }
      // Build resolution and runtime module format depend on the nearest
      // tracked package boundary, even for an otherwise leaf module.
      for (let dir = posix.dirname(file); ; dir = posix.dirname(dir)) {
        const manifest = posix.join(dir, 'package.json');
        if (files.has(manifest)) {
          if (!parents.has(manifest)) parents.set(manifest, file);
          break;
        }
        if (dir === '.') break;
      }
    }
    return { parents, unresolved, opaque, interpreters };
  };
}
