import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const muxPin = '82888fb7bc95272e43477ab5ae62b95cc28e9008';

export async function loadMux(directory, output) {
  assert.equal((await readFile(join(directory, 'mux.sha'), 'utf8')).trim(), muxPin);
  const outfile = join(output, 'pinned-mux-adapter.mjs');
  await build({
    entryPoints: [join(directory, 'judge-browser-slot.ts')],
    outfile, platform: 'node', bundle: true, format: 'esm',
  });
  const { JudgeBrowserSlot } = await import(pathToFileURL(outfile).href);
  return { JudgeBrowserSlot, muxPin };
}

// Use the same pinned adapter as GA. The existing page owns GB's worker
// transcript, so run the adapter's actual slot expressions in that page.
export async function runMux({ JudgeBrowserSlot, muxPin }, page, origin, language, bundle) {
  const slot = new JudgeBrowserSlot(`gb-${bundle.id}`, {
    browser: {
      async createSlot() {
        return {
          async navigate(url) { assert.equal(page.url(), url); },
          evaluate: (expression) => page.evaluate((source) => (0, eval)(source), expression),
          async dispose() {
            await page.evaluate(() => globalThis.__tracecodeMuxOneShotJudgeAuthority?.dispose());
          },
        };
      },
    },
    pageUrl: origin,
    judgeModuleUrl: '/gate.mjs',
    traceKernelModuleUrl: '/gate.mjs',
    providers: [language],
    prewarmLanguages: [language],
  });
  const request = { requestId: bundle.id, bundle };
  try {
    await slot.warm();
    return { muxPin, request, response: await slot.runAlgorithm(request) };
  } finally {
    await slot.dispose();
  }
}
