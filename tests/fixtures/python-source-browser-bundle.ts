import { join } from 'node:path';
import { build } from 'esbuild';
import { runCommand } from '../example-app-smoke';

export async function bundlePythonBrowserFixture(root: string, target: string, entry: string) {
  const tsconfig = join(root, 'tsconfig.base.json');
  await runCommand('pnpm', [
    'exec', 'tsx', '--tsconfig', tsconfig, 'src/cli.ts', 'sync-assets', join(target, 'workers'),
    '--languages', 'python',
  ], root);
  const zlib = join(root, 'packages/tracekernel/src/zlib-browser-shim.ts');
  await build({
    absWorkingDir: root,
    tsconfig,
    entryPoints: [join(root, 'tests/fixtures', entry)],
    outfile: join(target, 'entry.mjs'),
    bundle: true,
    format: 'esm',
    platform: 'browser',
    target: ['es2022'],
    alias: { zlib, 'node:zlib': zlib },
    define: { 'process.env.NODE_ENV': '"production"' },
    logLevel: 'warning',
  });
}
