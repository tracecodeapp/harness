import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

function replaceOnce(source, first, last, replacement) {
  const start = source.indexOf(first);
  assert.ok(start !== -1 && source.indexOf(first, start + first.length) === -1, first);
  const end = source.indexOf(last, start + first.length);
  assert.ok(end !== -1, last);
  return source.slice(0, start) + replacement(source.slice(start, end)) + source.slice(end);
}

function literalOnce(source, search, replacement) {
  const start = source.indexOf(search);
  assert.ok(start !== -1 && source.indexOf(search, start + search.length) === -1, search);
  return source.slice(0, start) + replacement + source.slice(start + search.length);
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

function routeSes(contents) {
  contents = replaceOnce(contents, '  executeCase(programId, inputs, limits, signal, tracingEnabled) {',
    '  disposeProgram(programId)', (singleton) => {
      return singleton
        .replace('executeCase(programId, inputs, limits, signal, tracingEnabled)', 'executeP0fCases(programId, inputBatch, limits, signal)')
        .replace('if (!source)', 'if (source?.mode !== "code")')
        .replace(/inputBatch: \[inputs\],\s*\.\.\.source.mode.*\n/, 'inputBatch, reportCaseProgress: true, protocolToken: createWorkerProtocolToken()\n')
        .replace('signal,\n          executionDeadlineMs', 'signal,\n          executionDeadlineMs * inputBatch.length')
        .replace(/const valid = .*?;/, 'const valid = isCodeExecutionBatch(response, inputBatch.length);')
        .replace('result = response[0];', 'result = response;');
  });
  return replaceOnce(contents, '  async executeBatchInternal(program, inputBatch, limits, signal, traceEnabledBatch) {',
    '  async executeBatch(', () => `  async executeBatchInternal(program, inputBatch, limits, signal, traceEnabledBatch) {
    const record = this.recordFor(program);
    if (record.mode !== 'code' || traceEnabledBatch !== undefined || !inputBatch.length) {
      throw new Error('P0-F uses only nonempty prepared SES code batches');
    }
    return this.lanes[0].executeP0fCases(record.laneProgramIds[0], inputBatch, limits, signal);
  }
`);
}

export function packedM1Probe() {
  return {
    name: 'p0f-packed-probe',
    setup(build) {
      build.onLoad({ filter: /\/(judge|chunk-6GZXRECY|chunk-KRRON7NU|ses-algorithm-worker-client-EZUUWKNS)\.js$/ }, async ({ path }) => {
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
          contents = replaceOnce(contents, '  executeCode(call) {\n    return this.ordinary(this.executeSerial(', '  executeTrace(call)', () => `  executeCode(call) {
    return this.executeCodeBatch({
      inputBatch: [call.inputs], signal: call.signal, limits: call.limits, stopAtFirstRunaway: true
    }).then(([result]) => result);
  }
`);
          contents = literalOnce(contents,
            '          void 0,\n          (worker, result2) => fast && !result2.caseTimedOut && this.handOffVerdictWorker(worker, result2.rows)',
            '          (result) => fast && !result.caseTimedOut && pythonBatchKeepsInterpreter(result.rows)');
          contents = literalOnce(contents, 'function completedPreparedCase(result) {',
            'function completedPreparedCase(result) {\n  if (Array.isArray(result)) return result.length > 0 && result.every(completedPreparedCase);');
          contents = literalOnce(contents, 'function managedHeapBytes(result) {',
            'function managedHeapBytes(result) {\n  if (Array.isArray(result)) return Math.max(0, ...result.map(managedHeapBytes));');
          contents += '\nexport { createBrowserRuntimeHost2 as probeHost, getBrowserRuntimeHostPreparedProvider as probeProvider };\n';
        } else if (path.endsWith('/chunk-6GZXRECY.js')) {
          contents = replaceOnce(contents, 'const executeCodeCases = async (execution) => {', '        const executeTraceCases', () => (
            'const executeCodeCases = async (execution) => client.executePreparedCodeBatch(await currentHandle(), execution);\n'
          ));
        } else if (path.endsWith('/ses-algorithm-worker-client-EZUUWKNS.js')) {
          contents = routeSes(contents);
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
