import { createRequire } from 'node:module';
import { posix } from 'node:path';

const ts = createRequire(import.meta.url)('typescript');
const extensions = ['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs', '.json'];
const moduleFile = /\.[cm]?[jt]sx?$/;

function references(file, source) {
  const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
  const imports = new Set();
  const entries = new Set();
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
    // Bundler entryPoints and subprocess argv in these runners often use
    // repository-relative file literals instead of module specifiers.
    if (ts.isStringLiteralLike(node) && /^(?:src|packages|scripts|tests|workers|tools)\//.test(node.text)) {
      entries.add(node.text);
    }
    ts.forEachChild(node, visit);
  }
  visit(ast);
  return { imports, entries };
}

export function moduleGraph({ files, read, aliases }) {
  const direct = new Map();

  function localCandidates(file, specifier) {
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
      if (moduleFile.test(file)) {
        const { imports, entries } = references(file, read(file));
        for (const specifier of imports) {
          const bases = localCandidates(file, specifier);
          const path = bases.map(resolve).find(Boolean);
          if (path) dependencies.push(path);
          else if (bases.length) unresolved.push(`${file}: ${specifier}`);
        }
        for (const entry of entries) {
          if (files.has(entry)) dependencies.push(entry);
        }
      }
      direct.set(file, { dependencies, unresolved });
    }
    return direct.get(file);
  }

  return (roots) => {
    const parents = new Map(roots.map((file) => [file, null]));
    const unresolved = new Set();
    for (const file of parents.keys()) {
      const edge = edges(file);
      for (const error of edge.unresolved) unresolved.add(error);
      for (const dependency of edge.dependencies) {
        if (!parents.has(dependency)) parents.set(dependency, file);
      }
    }
    return { parents, unresolved };
  };
}
