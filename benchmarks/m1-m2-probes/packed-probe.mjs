import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

function replaceOnce(source, first, last, replacement) {
  const start = source.indexOf(first);
  assert.ok(start !== -1 && source.indexOf(first, start + first.length) === -1, first);
  const end = source.indexOf(last, start + first.length);
  assert.ok(end !== -1, last);
  return source.slice(0, start) + replacement(source.slice(start, end)) + source.slice(end);
}

function csharpBatchMethod(singleton) {
  return singleton
    .replace('async executePreparedCode(', 'async executeP0fBatch(')
    .replace(/const inputBytes = [\s\S]*?const program =/, `const cases = call.inputBatch.map((inputs) => ({
      inputs,
      inputBytes: encodeTraceClrWireInputs(prepared.traceClrWireContract, inputs),
    }));
    const program =`)
    .replace(/"execute-prepared-code", \{[\s\S]*?assetBaseUrl:/, `"p0f-execute-prepared-code-batch", {
      prepared,
      cases,
      assetBaseUrl:`)
    .replace(/\}, null\),\s*wallClockMs/, '}, null), wallClockMs * cases.length')
    .replace(/\} catch \(error\) \{[\s\S]*?if \(prepared.preparedRunnerTier/, `} catch (error) {
      throw error;
    }
    return result.results.map((result) => {
    if (prepared.preparedRunnerTier`)
    .replace(/return outcome;\s*\}\);/, 'return outcome; }); });');
}

export function packedM1Probe() {
  return {
    name: 'p0f-packed-probe',
    setup(build) {
      build.onLoad({ filter: /\/(judge|chunk-6GZXRECY|chunk-KRRON7NU)\.js$/ }, async ({ path }) => {
        let contents = await readFile(path, 'utf8');
        if (path.endsWith('/judge.js')) {
          contents = replaceOnce(contents, '      executeBatchIsolated: (preparedCall) => executeOwned(\n        preparedCall,\n        (preparedArtifact, forwardedCall) => withOwnedPreparedBatchRunners(\n          preparedArtifact.preparedRunnerTier,\n          forwardedCall.inputBatch,\n          (runner, inputs) => runner.executePreparedCode(', '      dispose\n', () => `      executeBatchIsolated: (preparedCall) => executeOwned(
        preparedCall,
        (artifact, call) => {
          if (artifact.preparedRunnerTier !== 'algorithm-fast') {
            throw new Error('P0-F C# requires the retained algorithm runner');
          }
          return withOwnedPreparedRunner(artifact.preparedRunnerTier,
            (runner) => runner.executeP0fBatch(artifact, call, judgedOutputPolicy));
        }
      ),
`);
          contents += '\nexport { createBrowserRuntimeHost2 as probeHost, getBrowserRuntimeHostPreparedProvider as probeProvider, compareJudgeValues };\n';
        } else if (path.endsWith('/chunk-6GZXRECY.js')) {
          contents = replaceOnce(contents, 'const executeCodeCases = async (execution) => {', '        const executeTraceCases', () => (
            'const executeCodeCases = async (execution) => client.executePreparedCodeBatch(await currentHandle(), execution);\n'
          ));
        } else {
          contents = replaceOnce(contents, '  async executePreparedCode(prepared, call, policy) {', '  async executePreparedTrace(', (singleton) => {
            const batch = csharpBatchMethod(singleton);
            assert.match(batch, /sendCommandEffect\("p0f-execute-prepared-code-batch"/);
            assert.match(batch, /return result.results.map/);
            return singleton + batch;
          });
        }
        return { contents, loader: 'js' };
      });
    },
  };
}
