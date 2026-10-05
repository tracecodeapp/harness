#!/usr/bin/env node
// Resume a source checkout using pinned dependencies and retained release assets.
// Source toolchain builds and deployments are separate, explicit operations.
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const config = {
  "minimum": [
    22,
    0,
    0
  ],
  "maximum": 23,
  "steps": [
    [
      "node",
      "--import",
      "tsx",
      "scripts/csharp-role-artifacts.ts",
      "materialize"
    ],
    [
      "pnpm",
      "build"
    ],
    [
      "node",
      "--import",
      "tsx",
      "scripts/csharp-role-artifacts.ts",
      "verify"
    ]
  ],
  "checks": [
    [
      "node",
      "--import",
      "tsx",
      "scripts/csharp-role-artifacts.ts",
      "verify"
    ],
    [
      "node",
      "--import",
      "tsx",
      "scripts/verify-python-runtime-assets.ts"
    ]
  ]
};
const args = process.argv.slice(2);
if (args.some(arg => !['--plan', '--check'].includes(arg)) || args.length > 1) {
  console.error('Usage: node scripts/setup-local.mjs [--plan | --check]');
  process.exit(2);
}
const check = args.includes('--check');
const plan = args.includes('--plan');
const version = process.versions.node.split('.').map(Number);
const supported = version.some((part, index) =>
  part > config.minimum[index] && version.slice(0, index).every((v, i) => v === config.minimum[i])
) || version.every((part, index) => part === config.minimum[index]);
if (!supported || (config.maximum !== null && version[0] >= config.maximum)) {
  console.error(`Unsupported Node ${process.versions.node}; this checkout requires ${config.minimum.join('.')}+${config.maximum ? ` and <${config.maximum}` : ''}.`);
  process.exit(2);
}
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
if (!/^pnpm@\d+\.\d+\.\d+$/.test(pkg.packageManager ?? '')) {
  throw new Error('package.json must pin an exact pnpm version.');
}
const npm = join(dirname(process.execPath), process.platform === 'win32' ? 'npm.cmd' : 'npm');
const commands = check ? config.checks : [['pnpm', 'install', '--frozen-lockfile', '--include-workspace-root'], ...config.steps];
function run(command, arguments_) {
  console.log(`> ${command} ${arguments_.join(' ')}`);
  if (plan) return;
  const result = spawnSync(command, arguments_, { cwd: root, stdio: 'inherit', shell: process.platform === 'win32' });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} failed (${result.signal ?? result.status}). Setup stopped; see output above.`);
}
try {
  if (check && !plan && Object.keys({ ...pkg.dependencies, ...pkg.devDependencies }).some(name => !existsSync(join(root, 'node_modules', name)))) {
    throw new Error('Local dependencies are missing or have broken links. Run node scripts/setup-local.mjs first.');
  }
  if (!plan && !check && pkg.name === '@tracecode/harness') {
    const java = spawnSync('javac', ['-version'], { encoding: 'utf8' });
    const major = /javac (\d+)/.exec(`${java.stdout ?? ''}${java.stderr ?? ''}`)?.[1];
    if (java.status !== 0 || Number(major ?? 0) < 17) {
      throw new Error('Harness builds its Java helpers: install/activate a JDK >=17 first. TraceJVM runtime restoration itself requires no JDK.');
    }
  }
  for (const [command, ...arguments_] of commands) {
    if (command === 'pnpm') {
      if (arguments_[0] === 'install' && existsSync(join(root, 'node_modules')) &&
          Object.keys({ ...pkg.dependencies, ...pkg.devDependencies }).some(name => !existsSync(join(root, 'node_modules', name)))) {
        console.log('Incomplete dependency links detected; reinstalling the generated dependency tree.');
        arguments_.push('--force');
      }
      if (!existsSync(npm)) throw new Error(`npm is missing beside Node: ${npm}. Use a complete Node installation.`);
      run(npm, ['exec', '--yes', `--package=${pkg.packageManager}`, '--', 'pnpm', ...arguments_]);
    } else {
      run(process.execPath, arguments_);
    }
  }
  console.log(plan ? 'Plan only. No installation, restoration, or build ran.' : check ? 'Local asset checks passed.' : 'Local setup complete. See docs/local-development.md for tests and source toolchain rebuilds.');
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
