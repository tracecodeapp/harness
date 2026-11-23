import { join } from 'node:path';
import { build } from 'esbuild';
import { runCommand } from '../example-app-smoke';

export async function bundlePythonBrowserFixture(root: string, target: string, entry: string) {
  const tsconfig = join(root, 'tsconfig.base.json');
  const installed = process.env.TRACECODE_G7_INSTALLED_PACKAGE;
  if (installed) {
    await runCommand(process.execPath, [
      join(installed, 'dist/cli.cjs'), 'sync-assets', join(target, 'workers'), '--languages', 'python',
    ], root);
  } else {
    await runCommand('pnpm', [
      'exec', 'tsx', '--tsconfig', tsconfig, 'src/cli.ts', 'sync-assets', join(target, 'workers'),
      '--languages', 'python',
    ], root);
  }
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
    plugins: installed ? [{
      name: 'g7-installed-judge',
      setup(builder) {
        builder.onResolve({ filter: /^\.\.\/\.\.\/src\/judge$/ }, () => ({
          path: join(installed, 'dist/judge.js'),
        }));
      },
    }] : [],
    define: { 'process.env.NODE_ENV': '"production"' },
    logLevel: 'warning',
  });
}
