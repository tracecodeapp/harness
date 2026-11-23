import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { muxRequests } from './requests.mjs';

const muxPin = '82888fb7bc95272e43477ab5ae62b95cc28e9008';

export async function loadMux(directory, output) {
  assert.equal(readFileSync(join(directory, 'mux.sha'), 'utf8').trim(), muxPin);
  const outfile = join(output, 'pinned-mux-adapter.mjs');
  await build({
    entryPoints: [join(directory, 'judge-browser-slot.ts')],
    outfile, platform: 'node', bundle: true, format: 'esm',
  });
  return { ...(await import(pathToFileURL(outfile).href)), muxPin };
}

// Run the pinned adapter's exact expressions and projection. Playwright
// supplies its private slot for this PR-level check.
export async function exerciseMux(JudgeBrowserSlot, browser, origin, fixture, onResult) {
  let page;
  let rawReceipt;
  const slotId = `ga-${fixture.language}-${fixture.name}`;
  const slot = new JudgeBrowserSlot(slotId, {
    browser: {
      async createSlot() {
        page = await browser.newPage();
        return {
          navigate: (url) => page.goto(url),
          async evaluate(expression) {
            const result = await page.evaluate((source) => (0, eval)(source), expression);
            if (result?.schema === 'tracecode.judge.algorithm-receipt.v1') rawReceipt = result;
            return result;
          },
          dispose: () => page.close(),
        };
      },
    },
    pageUrl: origin + '/index.html',
    judgeModuleUrl: '/gate-browser.mjs',
    traceKernelModuleUrl: '/gate-browser.mjs',
    providers: [fixture.language],
    prewarmLanguages: [fixture.language],
  });
  try {
    await slot.warm();
    for (const request of muxRequests(fixture)) {
      const id = `${slotId}-${request.id}`;
      const trace = request.selected.length > 0;
      const cases = fixture.cases.map(({ id, input, expected }) => ({
        id, input, ...(expected === undefined ? {} : { expected }),
      }));
      const options = {
        id, language: fixture.language, code: fixture.code, functionName: fixture.functionName,
        executionStyle: fixture.executionStyle, trace, traceOptions: fixture.traceOptions,
        limits: fixture.limits, cases, comparison: { schema: 'tracecode.judge.comparator.v1', mode: 'exact' },
      };
      const bundle = await page.evaluate(async (options) => {
        const { createAlgorithmJudgeBundle } = await import('/gate-browser.mjs');
        return createAlgorithmJudgeBundle(options);
      }, options);
      rawReceipt = undefined;
      let legacy;
      const started = performance.now();
      try {
        if (request.id === 'algorithm') {
          const result = await slot.runAlgorithm({ requestId: id, bundle });
          assert.equal(result.requestId, id);
          assert.equal(result.status, 'completed');
        } else {
          legacy = await slot.runLegacy({
            requestId: id, language: fixture.language, code: fixture.code,
            functionName: fixture.functionName, executionStyle: fixture.executionStyle,
            mode: trace ? 'trace' : 'run',
            compareMode: 'exact', traceOptions: fixture.traceOptions,
            limits: {
              wallTimeMs: fixture.limits.wallClockMs,
              maxLineEvents: fixture.limits.maxLineEvents,
              maxSingleLineHits: fixture.limits.maxSingleLineHits,
            },
            cases: cases.map(({ input, ...row }) => ({ ...row, inputs: input })),
          });
        }
        assert(rawReceipt, 'Mux did not return a portable receipt');
        const projections = await page.evaluate(async ({ receipt, language, trace }) => {
          const { projectCases } = await import('/gate-browser.mjs');
          return projectCases(receipt, language, trace);
        }, { receipt: rawReceipt, language: fixture.language, trace });
        onResult(request, {
          reported: rawReceipt, legacy, projections,
          submitted: { id, workspaceDigest: bundle.workspaceDigest },
          wallMs: performance.now() - started,
        });
      } catch (error) {
        onResult(request, { error: { message: error.message, stack: error.stack }, wallMs: performance.now() - started });
      }
    }
  } finally {
    await slot.dispose();
  }
}
