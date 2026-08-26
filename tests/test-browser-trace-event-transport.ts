#!/usr/bin/env npx tsx

import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import vm from 'node:vm';
import { CppWorkerClient } from '../packages/runtime-cpp/src/cpp-worker-client';
import { CSharpWorkerClient } from '../packages/runtime-csharp/src/csharp-worker-client';
import { JavaWorkerClient } from '../packages/runtime-java/src/java-worker-client';
import { JavaScriptWorkerClient } from '../packages/runtime-javascript/src/javascript-worker-client';
import { PythonWorkerClient } from '../packages/runtime-python/src/python-worker-client';
import { restoreTransferredTraceEvents } from '../packages/runtime-browser/src/trace-event-transport';

interface ProtocolMessage {
  id?: string;
  type: string;
  payload?: unknown;
  protocolToken?: string;
}

type TraceEventTransportRequest = {
  schema?: unknown;
  encoding?: unknown;
  maxChunkBytes?: unknown;
  minTransferBytes?: unknown;
  minEventCount?: unknown;
};

function assertCondition(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function transferableResult(
  result: Record<string, unknown>,
  path: 'trace.events' | 'events' | 'results[].trace.events',
  events: unknown[] | unknown[][],
  chunkBytes = 16 * 1024
): Record<string, unknown> {
  const encoded = new TextEncoder().encode(JSON.stringify(events));
  const eventCounts = path === 'results[].trace.events'
    ? (events as unknown[][]).map((entry) => entry.length)
    : undefined;
  const eventCount = eventCounts
    ? eventCounts.reduce((sum, count) => sum + count, 0)
    : events.length;
  const chunks: ArrayBuffer[] = [];
  for (let offset = 0; offset < encoded.byteLength; offset += chunkBytes) {
    chunks.push(encoded.slice(offset, Math.min(encoded.byteLength, offset + chunkBytes)).buffer);
  }
  return {
    ...result,
    __traceEventTransport: {
      schema: 'tracecode.trace-events.transfer.v1',
      encoding: 'json-utf8',
      path,
      eventCount,
      ...(eventCounts ? { eventCounts } : {}),
      byteLength: encoded.byteLength,
      chunks,
    },
  };
}

function runtimeTrace(language: 'python' | 'javascript' | 'csharp' | 'cpp', eventCount: number): Record<string, unknown> {
  return {
    schemaVersion: 'runtime-trace-2026-04-28',
    language,
    runId: `${language}:run`,
    events: [],
    lineEventCount: eventCount,
    traceStepCount: eventCount,
  };
}

class TraceTransportWorker {
  static readonly requests: Array<{ runtime: string; request: TraceEventTransportRequest }> = [];

  onmessage: ((event: MessageEvent<ProtocolMessage>) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  private readonly runtime: 'python' | 'javascript' | 'java' | 'csharp' | 'cpp';

  constructor(readonly url: string | URL) {
    const workerUrl = String(url);
    this.runtime = workerUrl.includes('python-worker')
      ? 'python'
      : workerUrl.includes('csharp')
        ? 'csharp'
        : workerUrl.includes('cpp-worker')
          ? 'cpp'
      : workerUrl.includes('java-worker')
        ? 'java'
        : 'javascript';
    queueMicrotask(() => this.emit({ type: 'worker-ready' }));
  }

  postMessage(message: ProtocolMessage): void {
    queueMicrotask(() => {
      const { id, type, payload, protocolToken } = message;
      if (type === 'init' || type === 'warmup') {
        this.emit({
          id,
          type: `${type}-result`,
          protocolToken,
          payload: { success: true, loadTimeMs: 0 },
        });
        return;
      }
      if (type === 'prewarm-executor') {
        this.emit({
          id,
          type: 'prewarm-result',
          protocolToken,
          payload: { success: true },
        });
        return;
      }
      if (type === 'prepare-execution') {
        this.emit({
          id,
          type: 'prepare-result',
          protocolToken,
          payload: {
            preparedExecution: {
              schema: 'tracecode.javascript.prepared.v1',
              executableCode: 'function solve() { return 42; }',
              materializers: {},
              inputArguments: [],
              instrumentedCode: 'function solve() { return 42; }',
              traceLineBounds: { startLine: 1, endLine: 1 },
            },
          },
        });
        return;
      }
      if (
        type !== 'execute-with-tracing' &&
        type !== 'execute-trace-batch' &&
        type !== 'execute-prepared-program-batch'
      ) return;

      const request = (payload as { traceEventTransport?: TraceEventTransportRequest })?.traceEventTransport ?? {};
      TraceTransportWorker.requests.push({ runtime: this.runtime, request });
      if (this.runtime === 'python' && type === 'execute-prepared-program-batch') {
        const makeEvents = (caseIndex: number) => Array.from({ length: 500 }, (_, index) => ({
          kind: 'line',
          runId: `python:run:${caseIndex}`,
          file: 'solution.py',
          line: index + 1,
          frameId: `solve:${index}`,
          function: 'solve',
          sourceSpan: { startLine: index + 1, endLine: index + 1 },
        }));
        const eventArrays = [makeEvents(0), makeEvents(1)];
        this.emit({
          id,
          type: 'execute-result',
          protocolToken,
          payload: transferableResult(
            {
              results: eventArrays.map((events, index) => ({
                success: true,
                output: index + 1,
                trace: runtimeTrace('python', events.length),
                executionTimeMs: 1,
                consoleOutput: [],
              })),
            },
            'results[].trace.events',
            eventArrays
          ),
        });
        return;
      }
      if (this.runtime === 'csharp') {
        const events = Array.from({ length: 900 }, (_, index) => ({
          kind: 'line',
          runId: 'csharp:run',
          file: 'solution.cs',
          line: index + 1,
        }));
        this.emit({
          id,
          type: 'execute-result',
          protocolToken,
          payload: transferableResult(
            {
              success: true,
              output: 42,
              events: [],
              trace: runtimeTrace('csharp', events.length),
              executionTimeMs: 1,
              consoleOutput: [],
            },
            'events',
            events
          ),
        });
        return;
      }
      if (this.runtime === 'cpp') {
        const makeEvents = (caseIndex: number) => Array.from({ length: 500 }, (_, index) => ({
          kind: 'line',
          runId: `cpp:run:${caseIndex}`,
          file: 'solution.cpp',
          line: index + 1,
          sourceSpan: { startLine: index + 1, endLine: index + 1 },
        }));
        const batch = Array.isArray((payload as { inputBatch?: unknown[] })?.inputBatch);
        if (batch) {
          const eventArrays = [makeEvents(0), makeEvents(1)];
          this.emit({
            id,
            type: 'execute-result',
            protocolToken,
            payload: transferableResult(
              {
                success: true,
                results: eventArrays.map((events, index) => ({
                  success: true,
                  output: index + 1,
                  trace: runtimeTrace('cpp', events.length),
                  executionTimeMs: 1,
                  consoleOutput: [],
                })),
                consoleOutput: [],
              },
              'results[].trace.events',
              eventArrays
            ),
          });
          return;
        }
        const events = makeEvents(0);
        this.emit({
          id,
          type: 'execute-result',
          protocolToken,
          payload: transferableResult(
            {
              success: true,
              output: 42,
              trace: runtimeTrace('cpp', events.length),
              executionTimeMs: 1,
              consoleOutput: [],
            },
            'trace.events',
            events
          ),
        });
        return;
      }
      if (this.runtime === 'java') {
        const events = Array.from(
          { length: 900 },
          (_, index) => `trace:${JSON.stringify({ kind: 'line', line: index + 1 })}`
        );
        this.emit({
          id,
          type: 'execute-result',
          protocolToken,
          payload: transferableResult(
            {
              success: true,
              output: 42,
              events: [],
              sourceText: Array.from({ length: 900 }, () => 'int x = 1;').join('\n'),
              executionTimeMs: 1,
              consoleOutput: [],
            },
            'events',
            events
          ),
        });
        return;
      }

      const events = Array.from({ length: 900 }, (_, index) => ({
        kind: 'line',
        runId: `${this.runtime}:run`,
        line: index + 1,
        frameId: `solve:${index}`,
        function: 'solve',
        sourceSpan: { startLine: index + 1, endLine: index + 1 },
      }));
      this.emit({
        id,
        type: 'execute-result',
        protocolToken,
        payload: transferableResult(
          {
            success: true,
            output: 42,
            trace: runtimeTrace(this.runtime, events.length),
            executionTimeMs: 1,
            consoleOutput: [],
            lineEventCount: events.length,
            traceStepCount: events.length,
          },
          'trace.events',
          events
        ),
      });
    });
  }

  terminate(): void {}

  private emit(message: ProtocolMessage): void {
    this.onmessage?.({ data: message } as MessageEvent<ProtocolMessage>);
  }
}

function assertNegotiatedRequest(runtime: string): void {
  const request = TraceTransportWorker.requests.find((entry) => entry.runtime === runtime)?.request;
  assertCondition(request?.schema === 'tracecode.trace-events.transfer.v1', `${runtime} did not negotiate trace transfer`);
  assertCondition(request.encoding === 'json-utf8', `${runtime} did not negotiate UTF-8 trace transfer`);
  assertCondition(request.maxChunkBytes === 64 * 1024, `${runtime} did not request bounded 64 KiB chunks`);
  assertCondition(request.minEventCount === 128, `${runtime} did not preserve the small-trace bypass`);
}

async function testClientsRestorePublicResults(): Promise<void> {
  const originalWorker = globalThis.Worker;
  Object.defineProperty(globalThis, 'Worker', {
    configurable: true,
    writable: true,
    value: TraceTransportWorker,
  });

  try {
    const python = new PythonWorkerClient({ workerUrl: '/workers/python-worker.js', debug: false });
    const pythonResult = await python.executeWithTracing({ code: 'def solve():\n    return 42', functionName: 'solve', inputs: {}, executionStyle: 'function' });
    assertCondition((pythonResult.trace as { events: unknown[] }).events.length === 900, 'Python client lost transferred trace events');
    assertCondition(!('__traceEventTransport' in pythonResult), 'Python leaked its transport envelope publicly');
    assertNegotiatedRequest('python');

    const pythonBatch = await python.executePreparedTraceBatch(
      {
        artifact: {
          schemaVersion: 'tracecode.python.prepared-program.v3',
          fingerprint: { cacheTag: 'test', magicNumber: 'test', marshalVersion: 4 },
          mode: 'trace',
          code: 'def solve(value):\n    return value',
          functionName: 'solve',
          executionStyle: 'function',
          traceOptions: {},
          isolationProfile: {
            tier: 'compatibility',
            reasons: ['test-fixture'],
          },
          userCode: '',
          executorCode: '',
        },
        mode: 'trace',
        consoleOutput: [],
      },
      { inputBatch: [{ value: 1 }, { value: 2 }] }
    );
    assertCondition(
      pythonBatch.results?.length === 2 &&
        pythonBatch.results.every((entry) =>
          (entry.trace as { events: unknown[] }).events.length === 500
        ),
      'Python client lost transferred per-case trace event batches'
    );
    const pythonRequests = TraceTransportWorker.requests.filter(
      (entry) => entry.runtime === 'python'
    );
    assertCondition(
      pythonRequests.length === 2 &&
        pythonRequests.every(
          (entry) => entry.request.schema === 'tracecode.trace-events.transfer.v1'
        ),
      'Python prepared trace batch did not negotiate trace transfer'
    );
    python.terminate();

    const javascript = new JavaScriptWorkerClient({
      workerUrl: '/workers/javascript-worker.js',
      debug: false,
    });
    const javascriptResult = await javascript.executeWithTracing({ code: 'function solve() { return 42; }', functionName: 'solve', inputs: {}, executionStyle: 'function', language: 'javascript' });
    assertCondition(javascriptResult.trace.events.length === 900, 'JavaScript client lost transferred trace events');
    assertCondition(!('__traceEventTransport' in javascriptResult), 'JavaScript leaked its transport envelope publicly');
    assertNegotiatedRequest('javascript');
    javascript.terminate();

    const java = new JavaWorkerClient({ workerUrl: '/workers/java-worker.js', debug: false });
    const javaResult = await java.executeWithTracing({ code: 'class Solution { int solve() { return 42; } }', functionName: 'solve', inputs: {}, executionStyle: 'solution-method' });
    assertCondition(javaResult.events.length === 900, 'Java client lost transferred raw trace events');
    assertCondition(javaResult.trace.events.length === 900, 'Java adapter lost transferred runtime trace events');
    assertCondition(!('__traceEventTransport' in javaResult), 'Java leaked its transport envelope publicly');
    assertNegotiatedRequest('java');
    java.terminate();

    const csharp = new CSharpWorkerClient({
      workerUrl: '/workers/csharp-worker.js',
      assetBaseUrl: '/workers/vendor/csharp',
      debug: false,
    });
    const csharpResult = await csharp.executeWithTracing({ code: 'public class Solution { public int Solve() => 42; }', functionName: 'Solve', inputs: {}, executionStyle: 'solution-method' });
    assertCondition(csharpResult.trace.events.length === 900, 'C# client lost transferred trace events');
    assertCondition(!('__traceEventTransport' in csharpResult), 'C# leaked its transport envelope publicly');
    assertNegotiatedRequest('csharp');
    csharp.terminate();

    const cpp = new CppWorkerClient({
      workerUrl: '/workers/cpp-worker.js',
      compilerWasmUrl: '',
      linkerWasmUrl: '',
      sysrootUrl: '',
      runtimeHeaderUrl: '/workers/cpp/tracecode_runtime.hpp',
      compilerBundleUrl: '/workers/cpp/compiler/bundle.js',
      debug: false,
    });
    const cppResult = await cpp.executeWithTracing({ code: 'class Solution { public: int solve() { return 42; } };', functionName: 'solve', inputs: {}, executionStyle: 'solution-method' });
    assertCondition(cppResult.trace.events.length === 500, 'C++ client lost transferred trace events');
    assertCondition(!('__traceEventTransport' in cppResult), 'C++ leaked its transport envelope publicly');
    assertNegotiatedRequest('cpp');

    const cppBatch = await cpp.executeTraceBatch({ code: 'class Solution { public: int solve(int value) { return value; } };', functionName: 'solve', inputBatch: [{ value: 1 }, { value: 2 }], executionStyle: 'solution-method' });
    assertCondition(
      cppBatch.results.length === 2 && cppBatch.results.every((entry) => entry.trace.events.length === 500),
      'C++ client lost transferred per-case trace event batches'
    );
    cpp.terminate();

    console.log('PASS: all browser runtime clients negotiate and restore transferable trace batches');
  } finally {
    Object.defineProperty(globalThis, 'Worker', {
      configurable: true,
      writable: true,
      value: originalWorker,
    });
    TraceTransportWorker.requests.length = 0;
  }
}

function workerTransferSummary(workerPath: string, endMarker: string, path: 'trace.events' | 'events') {
  const source = readFileSync(join(process.cwd(), workerPath), 'utf8');
  const start = source.indexOf("const TRACE_EVENT_TRANSFER_SCHEMA = 'tracecode.trace-events.transfer.v1';");
  const end = source.indexOf(endMarker, start);
  assertCondition(start >= 0 && end > start, `Unable to extract trace transfer helper from ${workerPath}`);
  const context = vm.createContext({ TextEncoder });
  vm.runInContext(source.slice(start, end), context, { filename: workerPath });
  return vm.runInContext(
    `(() => {
      const events = Array.from({ length: 1200 }, (_, index) => ({
        kind: 'snapshot',
        runId: 'test:run',
        line: index + 1,
        target: { variable: 'values', path: [index % 20] },
        value: { label: 'event-' + index, payload: 'x'.repeat(180) },
      }));
      const result = ${path === 'trace.events'
        ? "{ trace: { events, lineEventCount: events.length, traceStepCount: events.length } }"
        : '{ events }'};
      const prepared = prepareTraceEventTransfer(result, {
        schema: 'tracecode.trace-events.transfer.v1',
        encoding: 'json-utf8',
        maxChunkBytes: 64 * 1024,
        minTransferBytes: 64 * 1024,
        minEventCount: 128,
      }, '${path}');
      return {
        eventCount: prepared.payload.__traceEventTransport.eventCount,
        chunkLengths: prepared.transfer.map((chunk) => chunk.byteLength),
        placeholderLength: ${path === 'trace.events'
          ? 'prepared.payload.trace.events.length'
          : 'prepared.payload.events.length'},
        legacyWithoutNegotiation: prepareTraceEventTransfer(result, undefined, '${path}') === null,
        smallTraceBypass: prepareTraceEventTransfer(${path === 'trace.events'
          ? '{ trace: { events: events.slice(0, 8) } }'
          : '{ events: events.slice(0, 8) }'}, {
            schema: 'tracecode.trace-events.transfer.v1',
            encoding: 'json-utf8',
            maxChunkBytes: 64 * 1024,
            minTransferBytes: 0,
            minEventCount: 1,
          }, '${path}') === null,
      };
    })()`,
    context
  ) as {
    eventCount: number;
    chunkLengths: number[];
    placeholderLength: number;
    legacyWithoutNegotiation: boolean;
    smallTraceBypass: boolean;
  };
}

function testWorkerBatchingIsBoundedAndCompatible(): void {
  const cases = [
    ['workers/javascript/javascript-worker.js', 'function emitRuntimeDiagnostic', 'trace.events'],
    ['workers/python/python-worker.js', 'function projectUtf8Bytes', 'trace.events'],
    ['workers/java/java-worker.js', 'function javaHttpEncodeUtf8', 'events'],
  ] as const;

  for (const [workerPath, endMarker, path] of cases) {
    const summary = workerTransferSummary(workerPath, endMarker, path);
    assertCondition(summary.eventCount === 1200, `${workerPath} changed the trace event budget`);
    assertCondition(summary.chunkLengths.length > 1, `${workerPath} did not chunk a large trace`);
    assertCondition(
      summary.chunkLengths.every((length) => length > 0 && length <= 64 * 1024),
      `${workerPath} emitted an oversized trace chunk`
    );
    assertCondition(summary.placeholderLength === 0, `${workerPath} duplicated events in its structured payload`);
    assertCondition(summary.legacyWithoutNegotiation, `${workerPath} broke legacy-client response compatibility`);
    assertCondition(summary.smallTraceBypass, `${workerPath} serialized a trace too small to benefit`);
  }
  console.log('PASS: worker trace batches are ordered, bounded, negotiated, and bypass small traces');
}

function testPythonWorkerPreparedBatching(): void {
  const source = readFileSync(join(process.cwd(), 'workers/python/python-worker.js'), 'utf8');
  const start = source.indexOf("const TRACE_EVENT_TRANSFER_SCHEMA = 'tracecode.trace-events.transfer.v1';");
  const end = source.indexOf('function projectUtf8Bytes', start);
  assertCondition(start >= 0 && end > start, 'Unable to extract Python trace transfer helper');
  const context = vm.createContext({ TextEncoder });
  vm.runInContext(source.slice(start, end), context, { filename: 'python-worker.js' });
  const summary = vm.runInContext(
    `(() => {
      const makeEvents = (caseIndex) => Array.from({ length: 700 }, (_, index) => ({
        kind: 'snapshot', runId: 'python:run:' + caseIndex, line: index + 1,
        target: { variable: 'values', path: [index % 20] },
        value: { label: 'event-' + index, payload: 'x'.repeat(180) },
      }));
      const eventArrays = [makeEvents(0), makeEvents(1)];
      const result = {
        results: eventArrays.map((events, index) => ({
          success: true, output: index + 1, trace: { events },
        })),
      };
      const request = {
        schema: 'tracecode.trace-events.transfer.v1', encoding: 'json-utf8',
        maxChunkBytes: 64 * 1024, minTransferBytes: 64 * 1024, minEventCount: 128,
      };
      const prepared = prepareTraceEventTransfer(
        result,
        request,
        'results[].trace.events'
      );
      return {
        chunks: prepared.transfer.map((chunk) => chunk.byteLength),
        eventCount: prepared.payload.__traceEventTransport.eventCount,
        eventCounts: prepared.payload.__traceEventTransport.eventCounts,
        placeholders: prepared.payload.results.map((entry) => entry.trace.events.length),
        legacy: prepareTraceEventTransfer(
          result,
          undefined,
          'results[].trace.events'
        ) === null,
      };
    })()`,
    context
  ) as {
    chunks: number[];
    eventCount: number;
    eventCounts: number[];
    placeholders: number[];
    legacy: boolean;
  };
  assertCondition(summary.eventCount === 1400, 'Python batch transfer changed the total event count');
  assertCondition(
    JSON.stringify(summary.eventCounts) === '[700,700]',
    'Python batch transfer changed per-result event counts'
  );
  assertCondition(
    summary.chunks.length > 1 &&
      summary.chunks.every((size) => size > 0 && size <= 64 * 1024),
    'Python batch transfer emitted an oversized trace chunk'
  );
  assertCondition(
    summary.placeholders.every((count) => count === 0),
    'Python batch transfer duplicated events in its structured payload'
  );
  assertCondition(summary.legacy, 'Python batch transfer broke legacy-client response compatibility');
  console.log('PASS: Python prepared trace batches use bounded transferable event chunks');
}

function testCSharpAndCppWorkerBatching(): void {
  const csharpSource = readFileSync(join(process.cwd(), 'workers/csharp/csharp-worker.js'), 'utf8');
  const csharpStart = csharpSource.indexOf("const TRACE_EVENT_TRANSFER_SCHEMA = 'tracecode.trace-events.transfer.v1';");
  const csharpEnd = csharpSource.indexOf('function stdinPipeState', csharpStart);
  assertCondition(csharpStart >= 0 && csharpEnd > csharpStart, 'Unable to extract C# trace transfer helper');
  const csharpContext = vm.createContext({ TextEncoder });
  vm.runInContext(csharpSource.slice(csharpStart, csharpEnd), csharpContext, { filename: 'csharp-worker.js' });
  const csharpSummary = vm.runInContext(
    `(() => {
      const events = Array.from({ length: 1200 }, (_, index) => ({
        kind: 'snapshot', runId: 'csharp:run', line: index + 1,
        target: { variable: 'values', path: [index % 20] },
        value: { label: 'event-' + index, payload: 'x'.repeat(180) },
      }));
      const result = { events, trace: { events, lineEventCount: events.length, traceStepCount: events.length } };
      const prepared = prepareCSharpTraceEventTransfer(result, {
        schema: 'tracecode.trace-events.transfer.v1', encoding: 'json-utf8',
        maxChunkBytes: 64 * 1024, minTransferBytes: 64 * 1024, minEventCount: 128,
      });
      return {
        chunks: prepared.transfer.map((chunk) => chunk.byteLength),
        eventCount: prepared.payload.__traceEventTransport.eventCount,
        eventsPlaceholder: prepared.payload.events.length,
        tracePlaceholder: prepared.payload.trace.events.length,
        legacy: prepareCSharpTraceEventTransfer(result, undefined) === null,
      };
    })()`,
    csharpContext
  ) as { chunks: number[]; eventCount: number; eventsPlaceholder: number; tracePlaceholder: number; legacy: boolean };
  assertCondition(csharpSummary.eventCount === 1200, 'C# transfer changed the event budget');
  assertCondition(csharpSummary.chunks.length > 1 && csharpSummary.chunks.every((size) => size <= 64 * 1024), 'C# chunks were not bounded');
  assertCondition(csharpSummary.eventsPlaceholder === 0 && csharpSummary.tracePlaceholder === 0, 'C# duplicated transported trace arrays');
  assertCondition(csharpSummary.legacy, 'C# broke legacy trace responses');

  const cppSource = readFileSync(join(process.cwd(), 'workers/cpp/cpp-worker.js'), 'utf8');
  const cppStart = cppSource.indexOf("const TRACE_EVENT_TRANSFER_SCHEMA = 'tracecode.trace-events.transfer.v1';");
  const cppEnd = cppSource.indexOf('function postFailure', cppStart);
  assertCondition(cppStart >= 0 && cppEnd > cppStart, 'Unable to extract C++ trace transfer helper');
  const cppContext = vm.createContext({ TextEncoder, self: { location: { search: '' } } });
  vm.runInContext(cppSource.slice(cppStart, cppEnd), cppContext, { filename: 'cpp-worker.js' });
  const cppSummary = vm.runInContext(
    `(() => {
      const makeEvents = (caseIndex) => Array.from({ length: 700 }, (_, index) => ({
        kind: 'snapshot', runId: 'cpp:run:' + caseIndex, line: index + 1,
        target: { variable: 'values', path: [index % 20] },
        value: { label: 'event-' + index, payload: 'x'.repeat(180) },
      }));
      const request = {
        schema: 'tracecode.trace-events.transfer.v1', encoding: 'json-utf8',
        maxChunkBytes: 64 * 1024, minTransferBytes: 64 * 1024, minEventCount: 128,
      };
      const singleEvents = makeEvents(0);
      const single = prepareCppTraceEventTransfer({ trace: { events: singleEvents } }, request, 'single');
      const eventArrays = [makeEvents(0), makeEvents(1)];
      const batch = prepareCppTraceEventTransfer({
        results: eventArrays.map((events) => ({ trace: { events } })),
      }, request, 'batch');
      return {
        singleChunks: single.transfer.map((chunk) => chunk.byteLength),
        singleCount: single.payload.__traceEventTransport.eventCount,
        singlePlaceholder: single.payload.trace.events.length,
        batchChunks: batch.transfer.map((chunk) => chunk.byteLength),
        batchCounts: batch.payload.__traceEventTransport.eventCounts,
        batchPlaceholders: batch.payload.results.map((entry) => entry.trace.events.length),
        legacy: prepareCppTraceEventTransfer({ trace: { events: singleEvents } }, undefined, 'single') === null,
      };
    })()`,
    cppContext
  ) as {
    singleChunks: number[];
    singleCount: number;
    singlePlaceholder: number;
    batchChunks: number[];
    batchCounts: number[];
    batchPlaceholders: number[];
    legacy: boolean;
  };
  assertCondition(cppSummary.singleCount === 700 && cppSummary.singlePlaceholder === 0, 'C++ single transfer changed events');
  assertCondition(cppSummary.singleChunks.every((size) => size <= 64 * 1024), 'C++ single chunks were not bounded');
  assertCondition(JSON.stringify(cppSummary.batchCounts) === '[700,700]', 'C++ batch per-result counts changed');
  assertCondition(cppSummary.batchChunks.length > 1 && cppSummary.batchChunks.every((size) => size <= 64 * 1024), 'C++ batch chunks were not bounded');
  assertCondition(cppSummary.batchPlaceholders.every((count) => count === 0), 'C++ batch duplicated transported traces');
  assertCondition(cppSummary.legacy, 'C++ broke legacy trace responses');
  console.log('PASS: C# and C++ workers transfer bounded traces without duplicate structured-clone arrays');
}

function testMalformedTransferFailsClosed(): void {
  const encoded = new TextEncoder().encode(JSON.stringify([{ kind: 'line', line: 1 }]));
  let rejected = false;
  try {
    restoreTransferredTraceEvents({
      trace: { events: [] },
      __traceEventTransport: {
        schema: 'tracecode.trace-events.transfer.v1',
        encoding: 'json-utf8',
        path: 'trace.events',
        eventCount: 2,
        byteLength: encoded.byteLength,
        chunks: [encoded.buffer],
      },
    });
  } catch (error) {
    rejected = error instanceof Error && error.message.includes('event count');
  }
  assertCondition(rejected, 'Malformed transferred trace events should fail closed');
  console.log('PASS: malformed trace transfer metadata fails closed before public result resolution');
}

function testMalformedBatchTransferFailsClosed(): void {
  const encoded = new TextEncoder().encode(JSON.stringify([[{ kind: 'line', line: 1 }], []]));
  let rejected = false;
  try {
    restoreTransferredTraceEvents({
      results: [{ trace: { events: [] } }, { trace: { events: [] } }],
      __traceEventTransport: {
        schema: 'tracecode.trace-events.transfer.v1',
        encoding: 'json-utf8',
        path: 'results[].trace.events',
        eventCount: 2,
        eventCounts: [1, 1],
        byteLength: encoded.byteLength,
        chunks: [encoded.buffer],
      },
    });
  } catch (error) {
    rejected = error instanceof Error && error.message.includes('per-result event count');
  }
  assertCondition(rejected, 'Malformed transferred C++ trace batches should fail closed');
  console.log('PASS: malformed per-result trace batch metadata fails closed');
}

async function testPythonOptionalPackagesAreManifestDriven(): Promise<void> {
  const source = readFileSync(join(process.cwd(), 'workers/python/python-worker.js'), 'utf8');
  const selfObject: Record<string, unknown> = {
    location: { search: '' },
    postMessage() {},
    onmessage: null,
    __packageLoads: [],
  };
  const sharedPolicySource = readFileSync(
    join(process.cwd(), 'workers/shared/runtime-kernel-policy-classic.js'),
    'utf8'
  );
  let context: vm.Context;
  context = vm.createContext({
    console,
    self: selfObject,
    performance: { now: () => 0 },
    importScripts(...urls: string[]) {
      for (const url of urls) {
        if (String(url).includes('runtime-kernel-policy-classic.js')) {
          vm.runInContext(sharedPolicySource, context, { filename: 'runtime-kernel-policy-classic.js' });
        }
      }
    },
    URL,
    URLSearchParams,
    TextEncoder,
    TextDecoder,
    setTimeout,
    clearTimeout,
  });
  vm.runInContext(source, context, { filename: 'python-worker.js' });
  await vm.runInContext(
    `ensurePythonLibraryPackages({
      loadedPackages: {},
      loadPackage(packages) {
        self.__packageLoads.push(packages);
        return Promise.resolve();
      }
    })`,
    context
  );
  assertCondition(
    (selfObject.__packageLoads as unknown[]).length === 0,
    'Default Python startup should not preload optional packages'
  );

  vm.runInContext(
    `configurePythonRuntimeAssets({
      packageUrls: { sortedcontainers: 'https://cdn.consumer.test/python/sortedcontainers.whl' }
    })`,
    context
  );
  await vm.runInContext(
    `ensurePythonLibraryPackages({
      loadedPackages: { sortedcontainers: 'https://cdn.consumer.test/python/sortedcontainers.whl' },
      loadPackage(packages) {
        self.__packageLoads.push(packages);
        return Promise.resolve([{ fileName: 'sortedcontainers.whl' }]);
      }
    })`,
    context
  );
  const loads = selfObject.__packageLoads as string[][];
  assertCondition(
    loads.length === 1 && loads[0]?.[0] === 'https://cdn.consumer.test/python/sortedcontainers.whl',
    `Explicit Python package manifest was not honored: ${JSON.stringify(loads)}`
  );
  console.log('PASS: Python optional packages load only from explicit consumer runtime configuration');
}

async function main(): Promise<void> {
  testWorkerBatchingIsBoundedAndCompatible();
  testPythonWorkerPreparedBatching();
  testCSharpAndCppWorkerBatching();
  testMalformedTransferFailsClosed();
  testMalformedBatchTransferFailsClosed();
  await testClientsRestorePublicResults();
  await testPythonOptionalPackagesAreManifestDriven();
}

test('browser trace event transport', main);
