#!/usr/bin/env npx tsx

import { cp, mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  assertCondition,
  runCommand,
  runExampleBrowserSmoke,
  startPreviewServer,
  waitForHttp,
} from './example-app-smoke';

async function createPackagedExampleApp(tempRoot: string): Promise<string> {
  const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
  const sourceDir = join(repoRoot, 'examples', 'web-ide');
  const appDir = join(tempRoot, 'packaged-web-ide');
  await mkdir(join(appDir, 'src'), { recursive: true });

  await cp(join(sourceDir, 'index.html'), join(appDir, 'index.html'));
  await cp(join(sourceDir, 'tsconfig.json'), join(appDir, 'tsconfig.json'));
  await cp(join(sourceDir, 'src'), join(appDir, 'src'), { recursive: true });

  const packageJson = {
    name: '@tracecode/harness-example-web-ide-packaged-smoke',
    private: true,
    type: 'module',
    scripts: {
      'sync:assets': 'pnpm exec tracecode-harness sync-assets public/workers',
      build: 'pnpm sync:assets && vite build',
      preview: 'pnpm sync:assets && vite preview --host 127.0.0.1 --port 4175',
    },
    dependencies: {
      '@tracecode/harness': '',
      'monaco-editor': '^0.55.1',
    },
    devDependencies: {
      typescript: '^5.0.0',
      vite: '^7.2.0',
    },
  };

  await writeFile(join(appDir, 'package.json'), JSON.stringify(packageJson, null, 2) + '\n', 'utf8');
  return appDir;
}

async function main(): Promise<void> {
  const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
  const tempRoot = await mkdtemp(join(tmpdir(), 'tracecode-harness-example-pack-'));
  const packOutput = spawnSync('pnpm', ['pack', '--pack-destination', tempRoot], {
    cwd: repoRoot,
    encoding: 'utf8',
  });

  if (packOutput.status !== 0) {
    throw new Error(packOutput.stderr || packOutput.stdout || 'pnpm pack failed');
  }

  const tarballName = String(packOutput.stdout || '')
    .trim()
    .split('\n')
    .filter(Boolean)
    .at(-1);
  assertCondition(Boolean(tarballName), 'pnpm pack should print the generated tarball name');

  const tarballPath = isAbsolute(tarballName!) ? tarballName! : join(tempRoot, tarballName!);
  const appDir = await createPackagedExampleApp(tempRoot);

  const packageJsonPath = join(appDir, 'package.json');
  const packageJson = JSON.parse(await readFile(packageJsonPath, 'utf8')) as {
    dependencies: Record<string, string>;
  };
  packageJson.dependencies['@tracecode/harness'] = `file:${tarballPath}`;
  await writeFile(packageJsonPath, JSON.stringify(packageJson, null, 2) + '\n', 'utf8');

  await runCommand('pnpm', ['install'], appDir);
  await runCommand('pnpm', ['build'], appDir);

  const previewPort = 4500 + Math.floor(Math.random() * 200);
  const preview = startPreviewServer(
    'pnpm',
    ['exec', 'vite', 'preview', '--host', '127.0.0.1', '--port', String(previewPort), '--strictPort'],
    appDir
  );

  try {
    const previewUrl = await preview.waitForUrl;
    await waitForHttp(previewUrl, 30_000);
    await runExampleBrowserSmoke(previewUrl);
  } finally {
    if (!preview.process.killed) {
      preview.process.kill('SIGTERM');
    }
    await preview.waitForExit;
  }

  console.log('PASS: packaged example web IDE works against the packed harness release');
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
