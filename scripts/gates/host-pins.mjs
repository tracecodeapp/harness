import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { tracksInput } from './inventory.mjs';
import { packageInputs } from './package-inputs.mjs';

const allowed = [
  'PATH', 'HOME', 'LANG', 'LC_ALL', 'TZ', 'TMPDIR', 'XDG_CACHE_HOME', 'XDG_DATA_HOME',
  'COREPACK_HOME', 'PNPM_HOME', 'JAVA_HOME', 'DOTNET_ROOT', 'DOTNET_ROOT_X64',
];

export function allowedEnvironment(source = process.env) {
  return Object.fromEntries(allowed.filter((key) => source[key] !== undefined).map((key) => [key, source[key]]));
}

function toolVersion(binary, option, env) {
  const result = spawnSync(binary, [option], { encoding: 'utf8', env });
  if (result.error?.code === 'ENOENT') return null;
  if (result.error) throw result.error;
  const output = [result.stdout, result.stderr].filter(Boolean).join('\n').trim();
  return { exitCode: result.status, signal: result.signal, output };
}

function toolchainPins(cell, env) {
  const manifest = JSON.parse(readFileSync('package.json', 'utf8'));
  const { scripts } = packageInputs(cell, manifest);
  const commands = [cell.setup, cell.command, ...Object.values(scripts)].filter(Boolean).join('\n');
  const java = cell.language === 'java' || /\b(?:java|javac|build-java-browser-helper)\b/.test(commands) ||
    tracksInput(cell, 'packages/runtime-java/src/index.ts');
  const dotnet = cell.language === 'csharp' || /\b(?:dotnet|restore-csharp-toolchain)\b/.test(commands) ||
    tracksInput(cell, 'toolchains/csharp/manifest.json');
  const interpreters = Object.fromEntries([...new Set(['bash', 'sh', ...(cell.pins.interpreters ?? [])])].sort().map((name) => {
    if (name === 'sh') {
      // POSIX sh does not standardize a version flag.
      const path = execFileSync('bash', ['-c', 'command -v sh'], { encoding: 'utf8', env }).trim();
      return [name, { sha256: sha256(realpathSync(path)) }];
    }
    return [name === 'node' ? 'nodeOnPath' : name, toolVersion(name, '--version', env)];
  }));
  return {
    ...interpreters,
    ...(java ? { javac: toolVersion('javac', '-version', env), java: toolVersion('java', '-version', env) } : {}),
    ...(dotnet ? { dotnet: toolVersion('dotnet', '--version', env) } : {}),
  };
}

export function sha256(file) {
  return execFileSync('sha256sum', ['--', file], { encoding: 'utf8' }).match(/[a-f0-9]{64}/)[0];
}

function requiredPath(variable, kind) {
  const name = process.env[variable];
  if (!name || !existsSync(name) || !statSync(name)[kind]()) {
    throw new Error(`Set ${variable} to the pinned external ${kind === 'isFile' ? 'file' : 'directory'}.`);
  }
  return realpathSync(name);
}

function treeDigest(root) {
  function entries(dir) {
    return readdirSync(join(root, dir), { withFileTypes: true }).flatMap((entry) => {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) return entries(path);
      if (entry.isFile()) return [[path, sha256(join(root, path))]];
      throw new Error(`Stage regular files only in ${root}. Found ${path}.`);
    });
  }
  const files = entries('').sort(([left], [right]) => Buffer.compare(Buffer.from(left), Buffer.from(right)));
  return createHash('sha256').update(JSON.stringify(files)).digest('hex');
}

export function hostInputs(cell) {
  const browserPath = process.env.PLAYWRIGHT_BROWSERS_PATH;
  if (browserPath === '0') throw new Error('Set PLAYWRIGHT_BROWSERS_PATH to the host browser cache.');
  const browsers = resolve(browserPath || join(process.env.XDG_CACHE_HOME || join(homedir(), '.cache'), 'ms-playwright'));
  const inputs = { ...allowedEnvironment(), CI: '1', PLAYWRIGHT_BROWSERS_PATH: browsers };
  const pins = {
    node: process.version,
    pnpm: execFileSync('pnpm', ['--version'], { encoding: 'utf8', env: inputs }).trim(),
    playwrightBrowsers: existsSync(browsers) ? readdirSync(browsers)
      .filter((name) => /^(?:chromium(?:_headless_shell)?|firefox|webkit|ffmpeg)-\d+$/.test(name))
      .filter((name) => existsSync(join(browsers, name, 'INSTALLATION_COMPLETE'))).sort() : [],
    ...toolchainPins(cell, inputs),
  };
  if (cell.pins.candidateTarball) {
    inputs.GATE_CANDIDATE_TARBALL = requiredPath('GATE_CANDIDATE_TARBALL', 'isFile');
    inputs.GATE_MUX_SOURCE = requiredPath('GATE_MUX_SOURCE', 'isDirectory');
    pins.candidateTarballSha256 = sha256(inputs.GATE_CANDIDATE_TARBALL);
    pins.muxSha256 = treeDigest(inputs.GATE_MUX_SOURCE);
  }
  if (cell.pins.appData) {
    const directory = cell.pins.appData === 'catalog';
    inputs.GATE_APP_DATA = requiredPath('GATE_APP_DATA', directory ? 'isDirectory' : 'isFile');
    if (directory) {
      const catalog = inputs.GATE_APP_DATA;
      const problems = treeDigest(join(catalog, 'problems'));
      const references = cell.language === 'python' ? '' :
        treeDigest(join(catalog, 'reference-solutions', cell.language, 'practice'));
      pins.appDataSha256 = createHash('sha256').update(problems + references).digest('hex');
    } else {
      pins.appDataSha256 = sha256(inputs.GATE_APP_DATA);
    }
  }
  pins.environment = inputs;
  return { pins, inputs };
}
