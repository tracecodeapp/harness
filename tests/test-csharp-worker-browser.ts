#!/usr/bin/env npx tsx

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, extname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, type Browser, type Page } from 'playwright';

interface CSharpWorkerResponse {
  success: boolean;
  output?: unknown;
  error?: string;
  diagnostics?: Array<{ file: string; line: number; column: number; message: string }>;
  consoleOutput?: string[];
  events?: Array<{
    kind: string;
    line?: number;
    function?: string;
    method?: string;
    value?: unknown;
    args?: unknown[];
    reason?: string;
    callStack?: Array<{ function?: string; line?: number; args?: unknown[] }>;
    target?: { variable: string; path?: unknown[] };
  }>;
  traceLimitExceeded?: boolean;
  timeoutReason?: string;
  timings?: {
    compileCacheHit?: boolean;
    compileMs?: number;
    runMs?: number;
    totalMs?: number;
  };
}

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const FIXTURE_ROOT = join(ROOT, 'spikes', 'csharp-wasm-roslyn', 'fixtures');
const WORKER_REQUEST_TIMEOUT_MS = 60_000;

function assertCondition(condition: boolean, message: string): void {
  if (!condition) {
    throw new Error(message);
  }
}

function contentType(pathname: string): string {
  switch (extname(pathname)) {
    case '.html':
      return 'text/html; charset=utf-8';
    case '.js':
    case '.mjs':
      return 'text/javascript; charset=utf-8';
    case '.json':
      return 'application/json; charset=utf-8';
    case '.wasm':
      return 'application/wasm';
    default:
      return 'application/octet-stream';
  }
}

async function startStaticServer(root: string): Promise<{ origin: string; close(): Promise<void> }> {
  const server = createServer((request: IncomingMessage, response: ServerResponse) => {
    const requestUrl = new URL(request.url ?? '/', 'http://127.0.0.1');
    const decodedPath = decodeURIComponent(requestUrl.pathname);
    const candidate = normalize(join(root, decodedPath));
    if (!candidate.startsWith(root + sep) && candidate !== root) {
      response.writeHead(403);
      response.end('Forbidden');
      return;
    }

    const filePath = statSync(candidate, { throwIfNoEntry: false })?.isDirectory()
      ? join(candidate, 'index.html')
      : candidate;
    if (!filePath || !existsSync(filePath)) {
      response.writeHead(404);
      response.end('Not found');
      return;
    }

    response.writeHead(200, {
      'Content-Type': contentType(filePath),
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'require-corp',
    });
    response.end(readFileSync(filePath));
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });

  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('Unable to resolve test server address');
  }

  return {
    origin: `http://127.0.0.1:${address.port}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

async function runWorkerCase(
  page: Page,
  code: string,
  functionName: string,
  inputs: Record<string, unknown>,
  assetBaseUrl: string,
  trace = false,
  options: {
    timeoutMs?: number;
    maxTraceSteps?: number;
    executionStyle?: 'function' | 'solution-method' | 'ops-class';
    messageType?: 'execute-code' | 'execute-code-interview' | 'execute-with-tracing';
  } = {}
): Promise<CSharpWorkerResponse> {
  return page.evaluate(
    async ({ code, functionName, inputs, assetBaseUrl, trace, options, workerRequestTimeoutMs }) => {
      const harnessKey = '__tracecodeCSharpWorkerHarness';
      async function createHarness() {
        const worker = new Worker('/workers/csharp/csharp-worker.js', { type: 'module' });
        let nextId = 0;
        const pending = new Map();

        function terminate(error = new Error('C# worker terminated')) {
          worker.terminate();
          for (const { reject, timeoutId } of pending.values()) {
            clearTimeout(timeoutId);
            reject(error);
          }
          pending.clear();
          globalThis[harnessKey] = undefined;
        }

        worker.addEventListener('message', (event) => {
          const id = event.data?.id;
          if (!id || !pending.has(id)) return;
          const { resolve, reject, timeoutId } = pending.get(id);
          pending.delete(id);
          clearTimeout(timeoutId);
          if (event.data.type === 'error') {
            reject(new Error(event.data.payload?.error ?? 'C# worker error'));
            return;
          }
          resolve(event.data.payload);
        });

        worker.addEventListener('error', (event) => {
          terminate(new Error(event.message || 'C# worker failed'));
        });

        function send(type, payload) {
          const id = String(++nextId);
          return new Promise((resolve, reject) => {
            const timeoutId = setTimeout(() => {
              terminate(new Error(`C# worker request timed out: ${type}`));
            }, workerRequestTimeoutMs);
            pending.set(id, { resolve, reject, timeoutId });
            worker.postMessage({ id, type, payload });
          });
        }

        const harness = { assetBaseUrl, send, terminate };
        await send('init', { assetBaseUrl });
        return harness;
      }

      let harness = globalThis[harnessKey];
      if (!harness || harness.assetBaseUrl !== assetBaseUrl) {
        harness = await createHarness();
        globalThis[harnessKey] = harness;
      }

      const { messageType, ...requestOptions } = options;
      const result = await harness.send(messageType ?? (trace ? 'execute-with-tracing' : 'execute-code'), {
        code,
        functionName,
        inputs,
        executionStyle: requestOptions.executionStyle ?? 'solution-method',
        assetBaseUrl,
        ...requestOptions,
      });
      return result;
    },
    { code, functionName, inputs, assetBaseUrl, trace, options, workerRequestTimeoutMs: WORKER_REQUEST_TIMEOUT_MS }
  ) as Promise<CSharpWorkerResponse>;
}

function fixture(name: string): string {
  return readFileSync(join(FIXTURE_ROOT, name), 'utf8');
}

async function main(): Promise<void> {
  const csharpDotnetJs = join(ROOT, 'workers', 'vendor', 'csharp', '_framework', 'dotnet.js');
  assertCondition(existsSync(csharpDotnetJs), 'Expected vendored C# AppBundle at workers/vendor/csharp');

  const server = await startStaticServer(ROOT);
  let browser: Browser | null = null;

  try {
    browser = await chromium.launch();
    const page = await browser.newPage();
    await page.goto(`${server.origin}/spikes/csharp-wasm-roslyn/browser-worker/blank.html`);
    await page.evaluate('globalThis.__name = (fn) => fn');

    const assetBaseUrl = `${server.origin}/workers/vendor/csharp`;
    const add = await runWorkerCase(page, fixture('add.cs'), 'Add', { a: 2, b: 3 }, assetBaseUrl);
    assertCondition(add.success, `C# worker Add should succeed: ${add.error ?? 'unknown error'}`);
    assertCondition(add.output === 5, `C# worker Add should return 5, received ${JSON.stringify(add.output)}`);
    assertCondition(add.consoleOutput?.includes('adding 2 and 3') === true, 'C# worker should capture stdout');
    assertCondition(add.timings?.compileCacheHit === false, 'C# first Add execution should miss the compile cache');

    const cachedAdd = await runWorkerCase(page, fixture('add.cs'), 'Add', { a: 5, b: 6 }, assetBaseUrl);
    assertCondition(cachedAdd.success, `C# worker cached Add should succeed: ${cachedAdd.error ?? 'unknown error'}`);
    assertCondition(cachedAdd.output === 11, `C# worker cached Add should return 11, received ${JSON.stringify(cachedAdd.output)}`);
    assertCondition(
      cachedAdd.consoleOutput?.includes('adding 5 and 6') === true,
      'C# cached Add execution should read the new runtime inputs'
    );
    assertCondition(cachedAdd.timings?.compileCacheHit === true, 'C# repeated Add execution with new inputs should hit the compile cache');

    const scriptStyle = await runWorkerCase(
      page,
      [
        'using System.Collections.Generic;',
        'var values = new List<int> { 2, 3 };',
        'values.Add(4);',
        'var result = new[] { values[0], values[2], values.Count };',
        'Console.WriteLine($"script count {values.Count}");',
      ].join('\n'),
      '',
      {},
      assetBaseUrl,
      false,
      { executionStyle: 'function' }
    );
    assertCondition(scriptStyle.success, `C# worker script-style case should succeed: ${scriptStyle.error ?? 'unknown error'}`);
    assertCondition(
      JSON.stringify(scriptStyle.output) === JSON.stringify([2, 4, 3]),
      `C# worker script-style case should return top-level result, received ${JSON.stringify(scriptStyle.output)}`
    );
    assertCondition(
      scriptStyle.consoleOutput?.includes('script count 3') === true,
      `C# worker script-style case should capture stdout, received ${JSON.stringify(scriptStyle.consoleOutput)}`
    );

    const defaultUsings = await runWorkerCase(
      page,
      [
        'public class Solution {',
        '  public string DefaultImports(string value) {',
        '    var builder = new StringBuilder();',
        '    builder.Append(Regex.Replace(value, "[^a-z]", ""));',
        '    var big = BigInteger.Parse("9007199254740993") + 7;',
        '    var queue = new Queue<int>();',
        '    queue.Enqueue(2);',
        '    queue.Enqueue(3);',
        '    var stack = new Stack<int>();',
        '    stack.Push(5);',
        '    stack.Push(7);',
        '    var dict = new Dictionary<string, int> { ["a"] = queue.Dequeue(), ["b"] = stack.Pop() };',
        '    var set = new HashSet<int>(dict.Values);',
        '    var bag = new ArrayList { builder.Length, set.Count };',
        '    return $"{builder}:{big}:{dict.Values.Sum()}:{bag.Count}:{bag[0]}:{bag[1]}";',
        '  }',
        '}',
      ].join('\n'),
      'DefaultImports',
      { value: 'a1b2c' },
      assetBaseUrl
    );
    assertCondition(defaultUsings.success, `C# worker default usings case should succeed: ${defaultUsings.error ?? 'unknown error'}`);
    assertCondition(
      defaultUsings.output === 'abc:9007199254741000:9:2:3:2',
      `C# worker default usings case should return expected summary, received ${JSON.stringify(defaultUsings.output)}`
    );

    const interviewAdd = await runWorkerCase(
      page,
      fixture('add.cs'),
      'Add',
      { a: 2, b: 3 },
      assetBaseUrl,
      false,
      { messageType: 'execute-code-interview' }
    );
    assertCondition(interviewAdd.success, `C# worker interview Add should succeed: ${interviewAdd.error ?? 'unknown error'}`);
    assertCondition(interviewAdd.output === 5, `C# worker interview Add should return 5, received ${JSON.stringify(interviewAdd.output)}`);
    assertCondition(
      !interviewAdd.events?.some((event) => event.kind !== 'stdout'),
      `C# worker interview Add should return a non-trace execution result, received ${JSON.stringify(interviewAdd.events)}`
    );

    const tracedAdd = await runWorkerCase(
      page,
      'public class Solution { public int Add(int a, int b) { int sum = a + b; return sum; } }',
      'Add',
      { a: 2, b: 3 },
      assetBaseUrl,
      true
    );
    assertCondition(tracedAdd.success, `C# worker traced Add should succeed: ${tracedAdd.error ?? 'unknown error'}`);
    assertCondition(
      tracedAdd.events?.some((event) => event.kind === 'call' && event.function === 'Add') === true,
      `C# worker traced Add should include call event, received ${JSON.stringify(tracedAdd.events)}`
    );
    assertCondition(
      tracedAdd.events?.some((event) => event.kind === 'snapshot' && event.target?.variable === 'sum' && event.value === 5) === true,
      `C# worker traced Add should include post-line sum snapshot, received ${JSON.stringify(tracedAdd.events)}`
    );
    assertCondition(
      tracedAdd.events?.some((event) => event.kind === 'return' && event.function === 'Add' && event.value === 5) === true,
      `C# worker traced Add should include return event with value 5, received ${JSON.stringify(tracedAdd.events)}`
    );
    assertCondition(
      tracedAdd.events?.some((event) => event.kind === 'line' && event.callStack?.some((frame) => frame.function === 'Add')) === true,
      `C# worker traced Add should attach Add callStack frames to line events, received ${JSON.stringify(tracedAdd.events)}`
    );
    assertCondition(
      tracedAdd.events?.some((event) => event.kind === 'return' && event.function === 'Add' && event.callStack?.some((frame) => frame.function === 'Add')) === true,
      `C# worker traced Add should attach Add callStack frames to return events, received ${JSON.stringify(tracedAdd.events)}`
    );

    const tracedConditionalAssignment = await runWorkerCase(
      page,
      [
        'public class Solution {',
        '  public int DecodeFirst(string s) {',
        '    char first = s[0];',
        '    long single;',
        '    if (first == \'*\')',
        '      single = 9;',
        '    else if (first == \'0\')',
        '      single = 0;',
        '    else',
        '      single = 1;',
        '    long dpPrev = single;',
        '    return (int)dpPrev;',
        '  }',
        '}',
      ].join('\n'),
      'DecodeFirst',
      { s: '*' },
      assetBaseUrl,
      true
    );
    assertCondition(
      tracedConditionalAssignment.success,
      `C# worker traced conditional assignment case should compile: ${tracedConditionalAssignment.error ?? 'unknown error'}`
    );
    assertCondition(
      tracedConditionalAssignment.output === 9,
      `C# worker traced conditional assignment case should return 9, received ${JSON.stringify(tracedConditionalAssignment.output)}`
    );

    const tracedTargetTypedReturn = await runWorkerCase(
      page,
      [
        'public class Solution {',
        '  public int[] EmptyIfOdd(int n) {',
        '    if (n % 2 == 1) return [];',
        '    return [n];',
        '  }',
        '}',
      ].join('\n'),
      'EmptyIfOdd',
      { n: 3 },
      assetBaseUrl,
      true
    );
    assertCondition(
      tracedTargetTypedReturn.success,
      `C# worker traced target-typed return case should compile: ${tracedTargetTypedReturn.error ?? 'unknown error'}`
    );
    assertCondition(
      JSON.stringify(tracedTargetTypedReturn.output) === JSON.stringify([]),
      `C# worker traced target-typed return case should return [], received ${JSON.stringify(tracedTargetTypedReturn.output)}`
    );

    const tracedPrivateTrieObject = await runWorkerCase(
      page,
      [
        'public class Solution {',
        '  private class TrieNode {',
        '    public TrieNode[] Children = new TrieNode[2];',
        '  }',
        '  public int BuildTrie(int value) {',
        '    TrieNode root = new TrieNode();',
        '    Insert(root, value);',
        '    return 1;',
        '  }',
        '  private void Insert(TrieNode root, int value) {',
        '    TrieNode node = root;',
        '    for (int bit = 8; bit >= 0; bit--) {',
        '      int b = (value >> bit) & 1;',
        '      if (node.Children[b] == null) node.Children[b] = new TrieNode();',
        '      node = node.Children[b];',
        '    }',
        '  }',
        '}',
      ].join('\n'),
      'BuildTrie',
      { value: 5 },
      assetBaseUrl,
      true
    );
    assertCondition(
      tracedPrivateTrieObject.success,
      `C# worker traced private trie-object case should serialize: ${tracedPrivateTrieObject.error ?? 'unknown error'}`
    );
    assertCondition(
      tracedPrivateTrieObject.output === 1,
      `C# worker traced private trie-object case should return 1, received ${JSON.stringify(tracedPrivateTrieObject.output)}`
    );

    const tracedCharArrayUnaryWrite = await runWorkerCase(
      page,
      [
        'public class Solution {',
        '  public string AdjustDigits(int n) {',
        '    char[] digits = n.ToString().ToCharArray();',
        '    digits[0]--;',
        '    digits[1] = \'9\';',
        '    return new string(digits);',
        '  }',
        '}',
      ].join('\n'),
      'AdjustDigits',
      { n: 54 },
      assetBaseUrl,
      true
    );
    assertCondition(
      tracedCharArrayUnaryWrite.success,
      `C# worker traced char-array unary write case should compile: ${tracedCharArrayUnaryWrite.error ?? 'unknown error'}`
    );
    assertCondition(
      tracedCharArrayUnaryWrite.output === '49',
      `C# worker traced char-array unary write case should return 49, received ${JSON.stringify(tracedCharArrayUnaryWrite.output)}`
    );

    const tracedStringBuilderIndexedAccess = await runWorkerCase(
      page,
      [
        'using System.Text;',
        'public class Solution {',
        '  public string ShiftFirst(string value) {',
        '    var builder = new StringBuilder(value);',
        '    char first = builder[0];',
        '    builder[0]++;',
        '    return first + ":" + builder.ToString();',
        '  }',
        '}',
      ].join('\n'),
      'ShiftFirst',
      { value: 'abc' },
      assetBaseUrl,
      true
    );
    assertCondition(
      tracedStringBuilderIndexedAccess.success,
      `C# worker traced StringBuilder indexed access case should compile: ${tracedStringBuilderIndexedAccess.error ?? 'unknown error'}`
    );
    assertCondition(
      tracedStringBuilderIndexedAccess.output === 'a:bbc',
      `C# worker traced StringBuilder indexed access case should return a:bbc, received ${JSON.stringify(tracedStringBuilderIndexedAccess.output)}`
    );

    const tracedStringBuilderAppend = await runWorkerCase(
      page,
      [
        'using System.Text;',
        'public class Solution {',
        '  public string AppendBuilder(string value) {',
        '    var builder = new StringBuilder();',
        '    builder.Append(value);',
        '    builder.Append("!");',
        '    return builder.ToString();',
        '  }',
        '}',
      ].join('\n'),
      'AppendBuilder',
      { value: 'hi' },
      assetBaseUrl,
      true
    );
    assertCondition(
      tracedStringBuilderAppend.success,
      `C# worker traced StringBuilder append case should compile: ${tracedStringBuilderAppend.error ?? 'unknown error'}`
    );
    assertCondition(
      tracedStringBuilderAppend.output === 'hi!',
      `C# worker traced StringBuilder append case should return hi!, received ${JSON.stringify(tracedStringBuilderAppend.output)}`
    );
    assertCondition(
      tracedStringBuilderAppend.events?.filter((event) => event.kind === 'mutate' && event.target?.variable === 'builder' && event.method === 'Append').length === 2,
      `C# worker traced StringBuilder append case should include two builder Append mutates, received ${JSON.stringify(tracedStringBuilderAppend.events)}`
    );

    const tracedRectangular3d = await runWorkerCase(
      page,
      [
        'public class Solution {',
        '  public int Rectangular3d(int value) {',
        '    int[,,] dp = new int[2, 2, 2];',
        '    dp[1, 0, 1] = value;',
        '    dp[1, 0, 1]++;',
        '    return dp[1, 0, 1];',
        '  }',
        '}',
      ].join('\n'),
      'Rectangular3d',
      { value: 7 },
      assetBaseUrl,
      true
    );
    assertCondition(
      tracedRectangular3d.success,
      `C# worker traced rectangular 3D array case should compile: ${tracedRectangular3d.error ?? 'unknown error'}`
    );
    assertCondition(
      tracedRectangular3d.output === 8,
      `C# worker traced rectangular 3D array case should return 8, received ${JSON.stringify(tracedRectangular3d.output)}`
    );
    assertCondition(
      tracedRectangular3d.events?.some((event) => event.kind === 'write' && event.target?.variable === 'dp' && event.target.path?.length === 3) === true,
      `C# worker traced rectangular 3D array case should include a dp path-3 write, received ${JSON.stringify(tracedRectangular3d.events)}`
    );
    assertCondition(
      tracedRectangular3d.events?.some((event) => event.kind === 'read' && event.target?.variable === 'dp' && event.target.path?.length === 3) === true,
      `C# worker traced rectangular 3D array case should include a dp path-3 read, received ${JSON.stringify(tracedRectangular3d.events)}`
    );

    const tracedIndexedQueueReceiver = await runWorkerCase(
      page,
      [
        'using System.Collections.Generic;',
        'public class Solution {',
        '  public int IndexedQueue(int value) {',
        '    var queues = new Queue<int>[2];',
        '    queues[1] = new Queue<int>();',
        '    queues[1].Enqueue(value);',
        '    int peek = queues[1].Peek();',
        '    queues[1].Dequeue();',
        '    return peek;',
        '  }',
        '}',
      ].join('\n'),
      'IndexedQueue',
      { value: 9 },
      assetBaseUrl,
      true
    );
    assertCondition(
      tracedIndexedQueueReceiver.success,
      `C# worker traced indexed queue receiver case should compile: ${tracedIndexedQueueReceiver.error ?? 'unknown error'}`
    );
    assertCondition(
      tracedIndexedQueueReceiver.output === 9,
      `C# worker traced indexed queue receiver case should return 9, received ${JSON.stringify(tracedIndexedQueueReceiver.output)}`
    );
    assertCondition(
      tracedIndexedQueueReceiver.events?.some((event) => event.kind === 'mutate' && event.target?.variable === 'queues' && event.target.path?.length === 1 && event.method === 'Enqueue') === true,
      `C# worker traced indexed queue receiver case should include queues Enqueue mutate, received ${JSON.stringify(tracedIndexedQueueReceiver.events)}`
    );
    assertCondition(
      tracedIndexedQueueReceiver.events?.some((event) => event.kind === 'read' && event.target?.variable === 'queues' && event.target.path?.length === 2) === true,
      `C# worker traced indexed queue receiver case should include queues path-2 read, received ${JSON.stringify(tracedIndexedQueueReceiver.events)}`
    );

    const tracedCollectionField = await runWorkerCase(
      page,
      [
        'using System.Collections.Generic;',
        'public class Solution {',
        '  private HashSet<int> seen = new HashSet<int>();',
        '  public bool FieldHashSet(int value) {',
        '    seen.Clear();',
        '    seen.Add(value);',
        '    return seen.Contains(value);',
        '  }',
        '}',
      ].join('\n'),
      'FieldHashSet',
      { value: 5 },
      assetBaseUrl,
      true
    );
    assertCondition(
      tracedCollectionField.success,
      `C# worker traced collection field case should compile: ${tracedCollectionField.error ?? 'unknown error'}`
    );
    assertCondition(
      tracedCollectionField.output === true,
      `C# worker traced collection field case should return true, received ${JSON.stringify(tracedCollectionField.output)}`
    );
    assertCondition(
      tracedCollectionField.events?.some((event) => event.kind === 'mutate' && event.target?.variable === 'seen' && event.method === 'Add') === true,
      `C# worker traced collection field case should include seen Add mutate, received ${JSON.stringify(tracedCollectionField.events)}`
    );
    assertCondition(
      tracedCollectionField.events?.some((event) => event.kind === 'read' && event.target?.variable === 'seen') === true,
      `C# worker traced collection field case should include seen read, received ${JSON.stringify(tracedCollectionField.events)}`
    );

    const tracedCollectionReassignment = await runWorkerCase(
      page,
      [
        'using System.Collections.Generic;',
        'public class Solution {',
        '  public int ReassignPoppedDictionary(int value) {',
        '    var stack = new Stack<Dictionary<string, int>>();',
        '    var count = new Dictionary<string, int>();',
        '    count["a"] = value;',
        '    stack.Push(count);',
        '    count = new Dictionary<string, int>();',
        '    var previous = stack.Pop();',
        '    count = previous;',
        '    return count["a"];',
        '  }',
        '}',
      ].join('\n'),
      'ReassignPoppedDictionary',
      { value: 7 },
      assetBaseUrl,
      true
    );
    assertCondition(
      tracedCollectionReassignment.success,
      `C# worker traced collection reassignment case should compile: ${tracedCollectionReassignment.error ?? 'unknown error'}`
    );
    assertCondition(
      tracedCollectionReassignment.output === 7,
      `C# worker traced collection reassignment case should return 7, received ${JSON.stringify(tracedCollectionReassignment.output)}`
    );

    const tracedNestedDictionaryList = await runWorkerCase(
      page,
      [
        'using System.Collections.Generic;',
        'public class Solution {',
        '  public int NestedDictionaryList(int value) {',
        '    var scopes = new List<Dictionary<string, int>>();',
        '    scopes.Add(new Dictionary<string, int>());',
        '    scopes[scopes.Count - 1]["x"] = value;',
        '    return scopes[0].ContainsKey("x") ? scopes[0]["x"] : -1;',
        '  }',
        '}',
      ].join('\n'),
      'NestedDictionaryList',
      { value: 11 },
      assetBaseUrl,
      true
    );
    assertCondition(
      tracedNestedDictionaryList.success,
      `C# worker traced nested dictionary-list case should compile: ${tracedNestedDictionaryList.error ?? 'unknown error'}`
    );
    assertCondition(
      tracedNestedDictionaryList.output === 11,
      `C# worker traced nested dictionary-list case should return 11, received ${JSON.stringify(tracedNestedDictionaryList.output)}`
    );

    const tracedShadowedCollectionHelper = await runWorkerCase(
      page,
      [
        'using System.Collections.Generic;',
        'public class Solution {',
        '  public int ShadowedListHelper(int value) {',
        '    var positions = new List<List<int>>();',
        '    foreach (int seed in new int[] { value }) {',
        '      var pos = new List<int>();',
        '      pos.Add(seed);',
        '      positions.Add(pos);',
        '    }',
        '    foreach (var row in positions) {',
        '      var pos = row;',
        '      return First(pos);',
        '    }',
        '    return -1;',
        '  }',
        '  private int First(List<int> values) {',
        '    return values[0];',
        '  }',
        '}',
      ].join('\n'),
      'ShadowedListHelper',
      { value: 13 },
      assetBaseUrl,
      true
    );
    assertCondition(
      tracedShadowedCollectionHelper.success,
      `C# worker traced shadowed collection-helper case should compile: ${tracedShadowedCollectionHelper.error ?? 'unknown error'}`
    );
    assertCondition(
      tracedShadowedCollectionHelper.output === 13,
      `C# worker traced shadowed collection-helper case should return 13, received ${JSON.stringify(tracedShadowedCollectionHelper.output)}`
    );

    const tracedOutVarCondition = await runWorkerCase(
      page,
      [
        'using System.Collections.Generic;',
        'public class Solution {',
        '  public string ReadOutVar(Dictionary<string, List<string>> graph, string key) {',
        '    if (graph != null && graph.TryGetValue(key, out var urls) && urls != null) {',
        '      return urls[0];',
        '    }',
        '    return "";',
        '  }',
        '}',
      ].join('\n'),
      'ReadOutVar',
      { graph: { home: ['about'] }, key: 'home' },
      assetBaseUrl,
      true
    );
    assertCondition(
      tracedOutVarCondition.success,
      `C# worker traced out-var condition case should compile: ${tracedOutVarCondition.error ?? 'unknown error'}`
    );
    assertCondition(
      tracedOutVarCondition.output === 'about',
      `C# worker traced out-var condition case should return about, received ${JSON.stringify(tracedOutVarCondition.output)}`
    );

    const tracedExpressionBody = await runWorkerCase(
      page,
      'public class Solution { public int Add(int a, int b) => a + b; }',
      'Add',
      { a: 2, b: 3 },
      assetBaseUrl,
      true
    );
    assertCondition(
      tracedExpressionBody.success,
      `C# worker traced expression-bodied Add should succeed: ${tracedExpressionBody.error ?? 'unknown error'}`
    );
    assertCondition(
      tracedExpressionBody.output === 5,
      `C# worker traced expression-bodied Add should return 5, received ${JSON.stringify(tracedExpressionBody.output)}`
    );
    assertCondition(
      tracedExpressionBody.events?.some((event) => event.kind === 'return' && event.function === 'Add' && event.value === 5) === true,
      `C# worker traced expression-bodied Add should include return value 5, received ${JSON.stringify(tracedExpressionBody.events)}`
    );

    const tracedVoidExpressionBody = await runWorkerCase(
      page,
      'using System; public class Solution { public void Log(int value) => Console.WriteLine(value); }',
      'Log',
      { value: 7 },
      assetBaseUrl,
      true
    );
    assertCondition(
      tracedVoidExpressionBody.success,
      `C# worker traced expression-bodied void method should succeed: ${tracedVoidExpressionBody.error ?? 'unknown error'}`
    );
    assertCondition(
      tracedVoidExpressionBody.output === null,
      `C# worker traced expression-bodied void method should return null output, received ${JSON.stringify(tracedVoidExpressionBody.output)}`
    );
    assertCondition(
      tracedVoidExpressionBody.consoleOutput?.includes('7') === true,
      `C# worker traced expression-bodied void method should capture stdout, received ${JSON.stringify(tracedVoidExpressionBody.consoleOutput)}`
    );
    assertCondition(
      tracedVoidExpressionBody.events?.some((event) => event.kind === 'return' && event.function === 'Log') === true,
      `C# worker traced expression-bodied void method should include return event, received ${JSON.stringify(tracedVoidExpressionBody.events)}`
    );

    const tracedExpressionLambda = await runWorkerCase(
      page,
      [
        'using System;',
        'public class Solution {',
        '  public int UseLambda(int value) {',
        '    Func<int, int> bump = x => x + 1;',
        '    Action<int> log = x => Console.WriteLine(x);',
        '    int next = bump(value);',
        '    log(next);',
        '    return next;',
        '  }',
        '}',
      ].join('\n'),
      'UseLambda',
      { value: 4 },
      assetBaseUrl,
      true
    );
    assertCondition(
      tracedExpressionLambda.success,
      `C# worker traced expression-bodied lambda case should succeed: ${tracedExpressionLambda.error ?? 'unknown error'}`
    );
    assertCondition(
      tracedExpressionLambda.output === 5,
      `C# worker traced expression-bodied lambda case should return 5, received ${JSON.stringify(tracedExpressionLambda.output)}`
    );
    assertCondition(
      tracedExpressionLambda.events?.some((event) => event.kind === 'call' && event.function === 'bump' && event.args?.[0] === 4) === true,
      `C# worker traced expression-bodied lambda case should include bump call args, received ${JSON.stringify(tracedExpressionLambda.events)}`
    );
    assertCondition(
      tracedExpressionLambda.events?.some((event) => event.kind === 'return' && event.function === 'bump' && event.value === 5) === true,
      `C# worker traced expression-bodied lambda case should include bump return value, received ${JSON.stringify(tracedExpressionLambda.events)}`
    );
    assertCondition(
      tracedExpressionLambda.events?.some((event) => event.kind === 'return' && event.function === 'log') === true,
      `C# worker traced expression-bodied lambda case should include Action return event, received ${JSON.stringify(tracedExpressionLambda.events)}`
    );

    const traceLimited = await runWorkerCase(
      page,
      'public class Solution { public int Add(int a, int b) { int sum = a + b; return sum; } }',
      'Add',
      { a: 2, b: 3 },
      assetBaseUrl,
      true,
      { maxTraceSteps: 2 }
    );
    assertCondition(traceLimited.success, `C# worker trace-limited Add should preserve execution success: ${traceLimited.error ?? 'unknown error'}`);
    assertCondition(traceLimited.output === 5, `C# worker trace-limited Add should preserve output, received ${JSON.stringify(traceLimited.output)}`);
    assertCondition(traceLimited.traceLimitExceeded === true, 'C# worker trace-limited Add should set traceLimitExceeded');
    assertCondition(traceLimited.timeoutReason === 'trace-limit', 'C# worker trace-limited Add should use trace-limit');
    assertCondition((traceLimited.events?.length ?? 0) <= 2, `C# worker trace-limited Add should bound returned events, received ${traceLimited.events?.length ?? 0}`);

    const storedEventLimited = await runWorkerCase(
      page,
      'public class Solution { public int Add(int a, int b) { int sum = a + b; return sum; } }',
      'Add',
      { a: 2, b: 3 },
      assetBaseUrl,
      true,
      { maxStoredEvents: 2 }
    );
    assertCondition(storedEventLimited.success, `C# worker maxStoredEvents should preserve execution success: ${storedEventLimited.error ?? 'unknown error'}`);
    assertCondition(storedEventLimited.output === 5, `C# worker maxStoredEvents should preserve output, received ${JSON.stringify(storedEventLimited.output)}`);
    assertCondition(storedEventLimited.traceLimitExceeded === true, 'C# worker maxStoredEvents should set traceLimitExceeded');
    assertCondition(storedEventLimited.timeoutReason === 'trace-limit', 'C# worker maxStoredEvents should use trace-limit');
    assertCondition((storedEventLimited.events?.length ?? 0) <= 2, `C# worker maxStoredEvents should bound returned events, received ${storedEventLimited.events?.length ?? 0}`);

    const lineLimited = await runWorkerCase(
      page,
      'public class Solution { public int Spin() { int total = 0; for (int i = 0; i < 100; i++) { total += i; } return total; } }',
      'Spin',
      {},
      assetBaseUrl,
      true,
      { maxLineEvents: 4, maxTraceSteps: 1000 }
    );
    assertCondition(!lineLimited.success, 'C# worker maxLineEvents should hard-stop traced execution');
    assertCondition(lineLimited.traceLimitExceeded === true, 'C# worker maxLineEvents should set traceLimitExceeded');
    assertCondition(lineLimited.timeoutReason === 'line-limit', 'C# worker maxLineEvents should use line-limit');
    assertCondition(
      lineLimited.events?.some((event) => event.kind === 'timeout' && event.reason === 'line-limit') === true,
      `C# worker maxLineEvents should emit line-limit timeout event, received ${JSON.stringify(lineLimited.events)}`
    );

    const singleLineLimited = await runWorkerCase(
      page,
      'public class Solution { public int Spin() { int total = 0; for (int i = 0; i < 100; i++) { total += i; } return total; } }',
      'Spin',
      {},
      assetBaseUrl,
      true,
      { maxSingleLineHits: 2, maxTraceSteps: 1000 }
    );
    assertCondition(!singleLineLimited.success, 'C# worker maxSingleLineHits should hard-stop traced execution');
    assertCondition(singleLineLimited.traceLimitExceeded === true, 'C# worker maxSingleLineHits should set traceLimitExceeded');
    assertCondition(singleLineLimited.timeoutReason === 'single-line-limit', 'C# worker maxSingleLineHits should use single-line-limit');
    assertCondition(
      singleLineLimited.events?.some((event) => event.kind === 'timeout' && event.reason === 'single-line-limit') === true,
      `C# worker maxSingleLineHits should emit single-line-limit timeout event, received ${JSON.stringify(singleLineLimited.events)}`
    );

    const minimalTrace = await runWorkerCase(
      page,
      'public class Solution { public int Add(int a, int b) { int sum = a + b; return sum; } }',
      'Add',
      { a: 2, b: 3 },
      assetBaseUrl,
      true,
      { minimalTrace: true }
    );
    assertCondition(minimalTrace.success, `C# worker minimalTrace should succeed: ${minimalTrace.error ?? 'unknown error'}`);
    assertCondition(minimalTrace.output === 5, `C# worker minimalTrace should preserve output, received ${JSON.stringify(minimalTrace.output)}`);
    assertCondition(
      minimalTrace.events?.every((event) => !['snapshot', 'read', 'write', 'mutate', 'control'].includes(event.kind)) === true,
      `C# worker minimalTrace should suppress detail events, received ${JSON.stringify(minimalTrace.events)}`
    );

    const timedOut = await runWorkerCase(
      page,
      'public class Solution { public int Add(int a, int b) { while (true) { a++; } return a + b; } }',
      'Add',
      { a: 2, b: 3 },
      assetBaseUrl,
      false,
      { timeoutMs: 100 }
    );
    assertCondition(!timedOut.success, 'C# worker infinite loop should fail');
    assertCondition(timedOut.timeoutReason === 'client-timeout', 'C# worker infinite loop should use client-timeout');

    const runtimeError = await runWorkerCase(
      page,
      [
        'using System;',
        'public class Solution {',
        '  public int Crash(int value) {',
        '    Console.WriteLine("before crash " + value);',
        '    throw new InvalidOperationException("bad input");',
        '  }',
        '}',
      ].join('\n'),
      'Crash',
      { value: 7 },
      assetBaseUrl,
      true
    );
    assertCondition(!runtimeError.success, 'C# worker runtime-error case should fail');
    assertCondition(
      runtimeError.error?.includes('bad input') === true,
      `C# worker runtime-error case should preserve exception message, received ${runtimeError.error}`
    );
    assertCondition(
      runtimeError.consoleOutput?.includes('before crash 7') === true,
      `C# worker runtime-error case should preserve stdout, received ${JSON.stringify(runtimeError.consoleOutput)}`
    );
    assertCondition(
      runtimeError.events?.some((event) => event.kind === 'line' && event.line === 4) === true,
      `C# worker runtime-error case should preserve pre-exception line trace, received ${JSON.stringify(runtimeError.events)}`
    );

    const tracedArray = await runWorkerCase(
      page,
      [
        'public class Solution {',
        '  public int AddFirstTwo(int[] nums) {',
        '    int first = nums[0];',
        '    nums[1] = first + nums[1];',
        '    return nums[1];',
        '  }',
        '}',
      ].join('\n'),
      'AddFirstTwo',
      { nums: [2, 3] },
      assetBaseUrl,
      true
    );
    assertCondition(tracedArray.success, `C# worker traced array case should succeed: ${tracedArray.error ?? 'unknown error'}`);
    assertCondition(tracedArray.output === 5, `C# worker traced array case should return 5, received ${JSON.stringify(tracedArray.output)}`);
    assertCondition(
      tracedArray.events?.some((event) => event.kind === 'read' && event.target?.variable === 'nums' && event.target.path?.[0] === 0) === true,
      `C# worker traced array case should include nums[0] read, received ${JSON.stringify(tracedArray.events)}`
    );
    assertCondition(
      tracedArray.events?.some((event) => event.kind === 'write' && event.target?.variable === 'nums' && event.target.path?.[0] === 1) === true,
      `C# worker traced array case should include nums[1] write, received ${JSON.stringify(tracedArray.events)}`
    );

    const tracedCompoundArray = await runWorkerCase(
      page,
      [
        'public class Solution {',
        '  public int Mutate(int[] nums) {',
        '    nums[0] += 2;',
        '    nums[1]++;',
        '    --nums[1];',
        '    return nums[0] + nums[1];',
        '  }',
        '}',
      ].join('\n'),
      'Mutate',
      { nums: [3, 4] },
      assetBaseUrl,
      true
    );
    assertCondition(
      tracedCompoundArray.success,
      `C# worker traced compound array case should succeed: ${tracedCompoundArray.error ?? 'unknown error'}`
    );
    assertCondition(
      tracedCompoundArray.output === 9,
      `C# worker traced compound array case should return 9, received ${JSON.stringify(tracedCompoundArray.output)}`
    );
    assertCondition(
      tracedCompoundArray.events?.some((event) => event.kind === 'write' && event.target?.variable === 'nums' && event.target.path?.[0] === 0 && event.value === 5) === true,
      `C# worker traced compound array case should include nums[0] compound write, received ${JSON.stringify(tracedCompoundArray.events)}`
    );
    assertCondition(
      tracedCompoundArray.events?.some((event) => event.kind === 'write' && event.target?.variable === 'nums' && event.target.path?.[0] === 1 && event.value === 5) === true,
      `C# worker traced compound array case should include nums[1] increment write, received ${JSON.stringify(tracedCompoundArray.events)}`
    );

    const tracedCollections = await runWorkerCase(
      page,
      [
        'using System.Collections.Generic;',
        'public class Solution {',
        '  public int UseCollections(int value) {',
        '    var list = new List<int>();',
        '    list.Add(value);',
        '    list[0] = list[0] + 1;',
        '    var seen = new Dictionary<int, int>();',
        '    seen[value] = list[0];',
        '    return seen[value];',
        '  }',
        '}',
      ].join('\n'),
      'UseCollections',
      { value: 4 },
      assetBaseUrl,
      true
    );
    assertCondition(
      tracedCollections.success,
      `C# worker traced collections case should succeed: ${tracedCollections.error ?? 'unknown error'}`
    );
    assertCondition(
      tracedCollections.output === 5,
      `C# worker traced collections case should return 5, received ${JSON.stringify(tracedCollections.output)}`
    );
    assertCondition(
      tracedCollections.events?.some((event) => event.kind === 'mutate' && event.target?.variable === 'list') === true,
      `C# worker traced collections case should include list mutate, received ${JSON.stringify(tracedCollections.events)}`
    );
    assertCondition(
      tracedCollections.events?.some((event) => event.kind === 'snapshot' && event.target?.variable === 'list') === true,
      `C# worker traced collections case should include list snapshot, received ${JSON.stringify(tracedCollections.events)}`
    );
    assertCondition(
      tracedCollections.events?.some((event) => event.kind === 'write' && event.target?.variable === 'seen' && event.target.path?.[0] === 4) === true,
      `C# worker traced collections case should include dictionary keyed write, received ${JSON.stringify(tracedCollections.events)}`
    );

    const collectionOutput = await runWorkerCase(
      page,
      [
        'using System.Collections.Generic;',
        'public class Solution {',
        '  public object[] BuildCollections(int value) {',
        '    var counts = new Dictionary<string, int>();',
        '    counts["a"] = value;',
        '    counts["b"] = value + 1;',
        '    var seen = new HashSet<int>();',
        '    seen.Add(value);',
        '    seen.Add(value + 2);',
        '    var list = new List<int> { value, value + 1 };',
        '    int[][] matrix = new int[][] { new int[] { value, value + 1 }, new int[] { value + 2 } };',
        '    return new object[] { counts, seen, list, matrix };',
        '  }',
        '}',
      ].join('\n'),
      'BuildCollections',
      { value: 4 },
      assetBaseUrl
    );
    assertCondition(
      collectionOutput.success,
      `C# worker collection output case should succeed: ${collectionOutput.error ?? 'unknown error'}`
    );
    assertCondition(
      JSON.stringify(collectionOutput.output) === JSON.stringify([{ a: 4, b: 5 }, [4, 6], [4, 5], [[4, 5], [6]]]),
      `C# worker collection output case should serialize collections, received ${JSON.stringify(collectionOutput.output)}`
    );

    const tracedCollectionOutput = await runWorkerCase(
      page,
      [
        'using System.Collections.Generic;',
        'public class Solution {',
        '  public object[] BuildCollections(int value) {',
        '    var counts = new Dictionary<string, int>();',
        '    counts["a"] = value;',
        '    var seen = new HashSet<int>();',
        '    seen.Add(value);',
        '    return new object[] { counts, seen };',
        '  }',
        '}',
      ].join('\n'),
      'BuildCollections',
      { value: 4 },
      assetBaseUrl,
      true
    );
    assertCondition(
      tracedCollectionOutput.success,
      `C# worker traced collection output case should succeed: ${tracedCollectionOutput.error ?? 'unknown error'}`
    );
    assertCondition(
      JSON.stringify(tracedCollectionOutput.output) === JSON.stringify([{ a: 4 }, [4]]),
      `C# worker traced collection output case should serialize output collections, received ${JSON.stringify(tracedCollectionOutput.output)}`
    );
    assertCondition(
      tracedCollectionOutput.events?.some((event) => event.kind === 'snapshot' && event.target?.variable === 'counts') === true,
      `C# worker traced collection output case should include dictionary snapshots, received ${JSON.stringify(tracedCollectionOutput.events)}`
    );
    assertCondition(
      tracedCollectionOutput.events?.some((event) => event.kind === 'snapshot' && event.target?.variable === 'seen') === true,
      `C# worker traced collection output case should include set snapshots, received ${JSON.stringify(tracedCollectionOutput.events)}`
    );

    const polymorphicOutput = await runWorkerCase(
      page,
      [
        'using System.Collections.Generic;',
        'public class NestedInteger {',
        '  public string __type__ = "NestedInteger";',
        '  public List<NestedInteger> list = new List<NestedInteger>();',
        '}',
        'public class NestedIntegerInt : NestedInteger {',
        '  public int value;',
        '}',
        'public class Solution {',
        '  public NestedInteger BuildNested(int value) {',
        '    var root = new NestedInteger();',
        '    root.list.Add(new NestedIntegerInt { value = value });',
        '    var child = new NestedInteger();',
        '    child.list.Add(new NestedIntegerInt { value = value + 1 });',
        '    root.list.Add(child);',
        '    return root;',
        '  }',
        '}',
      ].join('\n'),
      'BuildNested',
      { value: 4 },
      assetBaseUrl
    );
    assertCondition(
      polymorphicOutput.success,
      `C# worker polymorphic output case should succeed: ${polymorphicOutput.error ?? 'unknown error'}`
    );
    assertCondition(
      JSON.stringify(polymorphicOutput.output) === JSON.stringify({
        __type__: 'NestedInteger',
        list: [
          { __type__: 'NestedInteger', value: 4, list: [] },
          { __type__: 'NestedInteger', list: [{ __type__: 'NestedInteger', value: 5, list: [] }] },
        ],
      }),
      `C# worker polymorphic output case should preserve derived fields, received ${JSON.stringify(polymorphicOutput.output)}`
    );

    const nestedNodeType = await runWorkerCase(
      page,
      [
        'public class Solution {',
        '  public class TreeNode {',
        '    public int val;',
        '    public TreeNode left;',
        '    public TreeNode right;',
        '    public TreeNode(int val = 0, TreeNode left = null, TreeNode right = null) {',
        '      this.val = val;',
        '      this.left = left;',
        '      this.right = right;',
        '    }',
        '  }',
        '  public int BuildNestedNode(int value) {',
        '    var root = new TreeNode(value, new TreeNode(value + 1), null);',
        '    return root.val + root.left.val;',
        '  }',
        '}',
      ].join('\n'),
      'BuildNestedNode',
      { value: 4 },
      assetBaseUrl
    );
    assertCondition(
      nestedNodeType.success,
      `C# worker nested TreeNode type case should compile: ${nestedNodeType.error ?? 'unknown error'}`
    );
    assertCondition(
      nestedNodeType.output === 9,
      `C# worker nested TreeNode type case should return 9, received ${JSON.stringify(nestedNodeType.output)}`
    );

    const nestedNodeInput = await runWorkerCase(
      page,
      [
        'using System.Collections.Generic;',
        'public class Solution {',
        '  public class Node {',
        '    public int val;',
        '    public List<Node> children;',
        '    public Node(int val) {',
        '      this.val = val;',
        '      this.children = new List<Node>();',
        '    }',
        '    public Node(int val, List<Node> children) {',
        '      this.val = val;',
        '      this.children = children;',
        '    }',
        '  }',
        '  public int SumNode(Node root) {',
        '    int total = root.val;',
        '    foreach (var child in root.children) total += child.val;',
        '    return total;',
        '  }',
        '}',
      ].join('\n'),
      'SumNode',
      { root: { __type__: 'Node', val: 1, children: [{ __type__: 'Node', val: 3, children: [] }] } },
      assetBaseUrl
    );
    assertCondition(
      nestedNodeInput.success,
      `C# worker nested Node input case should compile and hydrate: ${nestedNodeInput.error ?? 'unknown error'}`
    );
    assertCondition(
      nestedNodeInput.output === 4,
      `C# worker nested Node input case should return 4, received ${JSON.stringify(nestedNodeInput.output)}`
    );

    const customNodeOutput = await runWorkerCase(
      page,
      [
        'using System.Collections.Generic;',
        'public class Solution {',
        '  public class Node {',
        '    public int val;',
        '    public List<Node> children;',
        '    public Node(int val, List<Node> children) {',
        '      this.val = val;',
        '      this.children = children;',
        '    }',
        '  }',
        '  public Node BuildNode(int value) {',
        '    return new Node(value, new List<Node> { new Node(value + 1, new List<Node>()) });',
        '  }',
        '}',
      ].join('\n'),
      'BuildNode',
      { value: 4 },
      assetBaseUrl
    );
    assertCondition(
      customNodeOutput.success,
      `C# worker custom Node output case should succeed: ${customNodeOutput.error ?? 'unknown error'}`
    );
    assertCondition(
      JSON.stringify(customNodeOutput.output) === JSON.stringify({
        __type__: 'Node',
        val: 4,
        children: [{ __type__: 'Node', val: 5, children: [] }],
      }),
      `C# worker custom Node output case should include object type, received ${JSON.stringify(customNodeOutput.output)}`
    );

    const nestedObjectListInput = await runWorkerCase(
      page,
      [
        'using System.Collections.Generic;',
        'public class Solution {',
        '  public bool ReadNestedObjects(List<List<object>> rows) {',
        '    return (string)rows[0][0] == "USD" && System.Convert.ToDouble(rows[0][1]) == 0.9;',
        '  }',
        '}',
      ].join('\n'),
      'ReadNestedObjects',
      { rows: [['USD', 0.9]] },
      assetBaseUrl
    );
    assertCondition(
      nestedObjectListInput.success,
      `C# worker nested object-list input case should succeed: ${nestedObjectListInput.error ?? 'unknown error'}`
    );
    assertCondition(
      nestedObjectListInput.output === true,
      `C# worker nested object-list input case should return true, received ${JSON.stringify(nestedObjectListInput.output)}`
    );

    const objectArrayInput = await runWorkerCase(
      page,
      [
        'using System;',
        'using System.Collections.Generic;',
        'public class Solution {',
        '  public int SumObjectArray(object values) {',
        '    int total = 0;',
        '    foreach (object item in (IEnumerable<object>)values) total += Convert.ToInt32(item);',
        '    return total;',
        '  }',
        '}',
      ].join('\n'),
      'SumObjectArray',
      { values: [1, 2, 3] },
      assetBaseUrl
    );
    assertCondition(
      objectArrayInput.success,
      `C# worker object-array input case should hydrate arrays as object[]: ${objectArrayInput.error ?? 'unknown error'}`
    );
    assertCondition(
      objectArrayInput.output === 6,
      `C# worker object-array input case should return 6, received ${JSON.stringify(objectArrayInput.output)}`
    );

    const objectArrayIntegralInput = await runWorkerCase(
      page,
      [
        'public class Solution {',
        '  public bool ReadsIntegralObjectNumbers(object values) {',
        '    object?[] items = (object?[])values;',
        '    return items[0] is int && items[1] is int;',
        '  }',
        '}',
      ].join('\n'),
      'ReadsIntegralObjectNumbers',
      { values: [1, 2] },
      assetBaseUrl
    );
    assertCondition(
      objectArrayIntegralInput.success,
      `C# worker object-array integral input case should hydrate: ${objectArrayIntegralInput.error ?? 'unknown error'}`
    );
    assertCondition(
      objectArrayIntegralInput.output === true,
      `C# worker object-array integral input case should preserve ints, received ${JSON.stringify(objectArrayIntegralInput.output)}`
    );

    const dictionaryInput = await runWorkerCase(
      page,
      [
        'using System.Collections.Generic;',
        'public class Solution {',
        '  public string ReadDictionary(Dictionary<string, string> values) {',
        '    return values["user2"];',
        '  }',
        '}',
      ].join('\n'),
      'ReadDictionary',
      { values: { user1: 'variant_a', user2: 'variant_b' } },
      assetBaseUrl
    );
    assertCondition(
      dictionaryInput.success,
      `C# worker dictionary input case should hydrate values: ${dictionaryInput.error ?? 'unknown error'}`
    );
    assertCondition(
      dictionaryInput.output === 'variant_b',
      `C# worker dictionary input case should return variant_b, received ${JSON.stringify(dictionaryInput.output)}`
    );

    const objectValueDictionaryInput = await runWorkerCase(
      page,
      [
        'using System;',
        'using System.Collections.Generic;',
        'public class Solution {',
        '  public string ReadObjectValueDictionary(List<Dictionary<string, object>> users) {',
        '    string id = (string)users[0]["id"];',
        '    int priority = Convert.ToInt32(users[0]["priority"]);',
        '    return id + ":" + priority;',
        '  }',
        '}',
      ].join('\n'),
      'ReadObjectValueDictionary',
      { users: [{ id: 'alice', priority: 2 }] },
      assetBaseUrl
    );
    assertCondition(
      objectValueDictionaryInput.success,
      `C# worker object-value dictionary input case should hydrate: ${objectValueDictionaryInput.error ?? 'unknown error'}`
    );
    assertCondition(
      objectValueDictionaryInput.output === 'alice:2',
      `C# worker object-value dictionary input case should return alice:2, received ${JSON.stringify(objectValueDictionaryInput.output)}`
    );

    const tracedNestedInterfaceList = await runWorkerCase(
      page,
      [
        'using System.Collections.Generic;',
        'public class Solution {',
        '  public string ReadNestedInterface(IList<IList<string>> rows) {',
        '    return rows[0][0] + rows[0][1];',
        '  }',
        '}',
      ].join('\n'),
      'ReadNestedInterface',
      { rows: [['a', 'b']] },
      assetBaseUrl,
      true
    );
    assertCondition(
      tracedNestedInterfaceList.success,
      `C# worker traced nested interface-list case should compile: ${tracedNestedInterfaceList.error ?? 'unknown error'}`
    );
    assertCondition(
      tracedNestedInterfaceList.output === 'ab',
      `C# worker traced nested interface-list case should return "ab", received ${JSON.stringify(tracedNestedInterfaceList.output)}`
    );

    const tracedDictionaryArrayValue = await runWorkerCase(
      page,
      [
        'using System.Collections.Generic;',
        'public class Solution {',
        '  public int IncrementBucket(int value) {',
        '    var map = new Dictionary<int, int[]>();',
        '    map[value] = new int[] { 1, 2 };',
        '    map[value][0]++;',
        '    map[value][1] = value;',
        '    return map[value][0] + map[value][1];',
        '  }',
        '}',
      ].join('\n'),
      'IncrementBucket',
      { value: 4 },
      assetBaseUrl,
      true
    );
    assertCondition(
      tracedDictionaryArrayValue.success,
      `C# worker traced dictionary array-value case should compile: ${tracedDictionaryArrayValue.error ?? 'unknown error'}`
    );
    assertCondition(
      tracedDictionaryArrayValue.output === 6,
      `C# worker traced dictionary array-value case should return 6, received ${JSON.stringify(tracedDictionaryArrayValue.output)}`
    );

    const collectionReassignment = await runWorkerCase(
      page,
      [
        'using System.Collections.Generic;',
        'public class Solution {',
        '  public int[] ReassignList(int value) {',
        '    List<int> items = new List<int> { value };',
        '    items = new List<int>(2);',
        '    items.Add(value + 1);',
        '    items.Add(value + 2);',
        '    return items.ToArray();',
        '  }',
        '}',
      ].join('\n'),
      'ReassignList',
      { value: 4 },
      assetBaseUrl,
      true
    );
    assertCondition(
      collectionReassignment.success,
      `C# worker traced collection reassignment case should compile: ${collectionReassignment.error ?? 'unknown error'}`
    );
    assertCondition(
      JSON.stringify(collectionReassignment.output) === JSON.stringify([5, 6]),
      `C# worker traced collection reassignment case should return [5,6], received ${JSON.stringify(collectionReassignment.output)}`
    );

    const collectionFactoryAssignment = await runWorkerCase(
      page,
      [
        'using System.Collections.Generic;',
        'public class Solution {',
        '  public int[] SliceAndAppend(int value) {',
        '    var items = new List<int> { value, value + 1, value + 2 };',
        '    items = items.GetRange(0, 2);',
        '    items.Add(value + 3);',
        '    return items.ToArray();',
        '  }',
        '}',
      ].join('\n'),
      'SliceAndAppend',
      { value: 4 },
      assetBaseUrl,
      true
    );
    assertCondition(
      collectionFactoryAssignment.success,
      `C# worker traced collection factory assignment case should compile: ${collectionFactoryAssignment.error ?? 'unknown error'}`
    );
    assertCondition(
      JSON.stringify(collectionFactoryAssignment.output) === JSON.stringify([4, 5, 7]),
      `C# worker traced collection factory assignment case should return [4,5,7], received ${JSON.stringify(collectionFactoryAssignment.output)}`
    );

    const tracedExplicitCollections = await runWorkerCase(
      page,
      [
        'using System.Collections.Generic;',
        'public class Solution {',
        '  public int UseCollections(int value) {',
        '    List<int> list = new List<int>();',
        '    list.Add(value);',
        '    Dictionary<int, int> seen = new Dictionary<int, int>();',
        '    seen[value] = list[0] + 1;',
        '    return seen[value];',
        '  }',
        '}',
      ].join('\n'),
      'UseCollections',
      { value: 4 },
      assetBaseUrl,
      true
    );
    assertCondition(
      tracedExplicitCollections.success,
      `C# worker traced explicit collections case should succeed: ${tracedExplicitCollections.error ?? 'unknown error'}`
    );
    assertCondition(
      tracedExplicitCollections.output === 5,
      `C# worker traced explicit collections case should return 5, received ${JSON.stringify(tracedExplicitCollections.output)}`
    );
    assertCondition(
      tracedExplicitCollections.events?.some((event) => event.kind === 'mutate' && event.target?.variable === 'list') === true,
      `C# worker traced explicit collections case should include list mutate, received ${JSON.stringify(tracedExplicitCollections.events)}`
    );
    assertCondition(
      tracedExplicitCollections.events?.some((event) => event.kind === 'write' && event.target?.variable === 'seen' && event.target.path?.[0] === 4) === true,
      `C# worker traced explicit collections case should include dictionary keyed write, received ${JSON.stringify(tracedExplicitCollections.events)}`
    );

    const tracedInterviewCollections = await runWorkerCase(
      page,
      [
        'using System.Collections.Generic;',
        'public class Solution {',
        '  public int UseMoreCollections(int value) {',
        '    HashSet<int> set = new HashSet<int>();',
        '    set.Add(value);',
        '    var queue = new Queue<int>();',
        '    queue.Enqueue(value + 1);',
        '    int front = queue.Dequeue();',
        '    Stack<int> stack = new Stack<int>();',
        '    stack.Push(front + (set.Contains(value) ? 1 : 0));',
        '    return stack.Pop();',
        '  }',
        '}',
      ].join('\n'),
      'UseMoreCollections',
      { value: 4 },
      assetBaseUrl,
      true
    );
    assertCondition(
      tracedInterviewCollections.success,
      `C# worker traced interview collections case should succeed: ${tracedInterviewCollections.error ?? 'unknown error'}`
    );
    assertCondition(
      tracedInterviewCollections.output === 6,
      `C# worker traced interview collections case should return 6, received ${JSON.stringify(tracedInterviewCollections.output)}`
    );
    assertCondition(
      tracedInterviewCollections.events?.some((event) => event.kind === 'mutate' && event.target?.variable === 'set' && event.method === 'Add') === true,
      `C# worker traced interview collections case should include HashSet Add, received ${JSON.stringify(tracedInterviewCollections.events)}`
    );
    assertCondition(
      tracedInterviewCollections.events?.some((event) => event.kind === 'mutate' && event.target?.variable === 'queue' && event.method === 'Dequeue') === true,
      `C# worker traced interview collections case should include Queue Dequeue, received ${JSON.stringify(tracedInterviewCollections.events)}`
    );
    assertCondition(
      tracedInterviewCollections.events?.some((event) => event.kind === 'mutate' && event.target?.variable === 'stack' && event.method === 'Pop') === true,
      `C# worker traced interview collections case should include Stack Pop, received ${JSON.stringify(tracedInterviewCollections.events)}`
    );

    const tracedNestedContains = await runWorkerCase(
      page,
      [
        'using System.Collections.Generic;',
        'public class Solution {',
        '  public bool HasEdge(string from, string to) {',
        '    var adj = new Dictionary<string, HashSet<string>>();',
        '    adj[from] = new HashSet<string> { to };',
        '    return adj[from].Contains(to);',
        '  }',
        '}',
      ].join('\n'),
      'HasEdge',
      { from: 'a', to: 'b' },
      assetBaseUrl,
      true
    );
    assertCondition(
      tracedNestedContains.success,
      `C# worker traced nested Contains case should succeed: ${tracedNestedContains.error ?? 'unknown error'}`
    );
    assertCondition(
      tracedNestedContains.output === true,
      `C# worker traced nested Contains case should return true, received ${JSON.stringify(tracedNestedContains.output)}`
    );
    assertCondition(
      tracedNestedContains.events?.some((event) =>
        event.kind === 'read'
        && event.target?.variable === 'adj'
        && event.target.path?.[0] === 'a'
        && event.target.path?.[1] === 'b') === true,
      `C# worker traced nested Contains case should include adj[from].Contains(to) read, received ${JSON.stringify(tracedNestedContains.events)}`
    );

    const tracedFieldMapRemove = await runWorkerCase(
      page,
      [
        'using System.Collections.Generic;',
        'public class FieldMap {',
        '  public Dictionary<string, int> counts;',
        '  public FieldMap() {',
        '    this.counts = new Dictionary<string, int>();',
        '    this.counts["a"] = 1;',
        '    this.counts["b"] = 2;',
        '  }',
        '  public object RemoveKey(string key) {',
        '    this.counts.Remove(key);',
        '    return null;',
        '  }',
        '  public int Count() {',
        '    return this.counts.Count;',
        '  }',
        '}',
      ].join('\n'),
      'FieldMap',
      {
        operations: ['FieldMap', 'RemoveKey', 'Count'],
        arguments: [[], ['b'], []],
      },
      assetBaseUrl,
      true,
      { executionStyle: 'ops-class' }
    );
    assertCondition(
      tracedFieldMapRemove.success,
      `C# worker traced field map Remove case should succeed: ${tracedFieldMapRemove.error ?? 'unknown error'}`
    );
    assertCondition(
      JSON.stringify(tracedFieldMapRemove.output) === JSON.stringify([null, null, 1]),
      `C# worker traced field map Remove case should return operation outputs, received ${JSON.stringify(tracedFieldMapRemove.output)}`
    );
    assertCondition(
      tracedFieldMapRemove.events?.some((event) =>
        event.kind === 'mutate'
        && event.target?.variable === 'this'
        && event.target.path?.[0] === 'counts'
        && event.method === 'Remove') === true,
      `C# worker traced field map Remove case should include this.counts Remove mutation, received ${JSON.stringify(tracedFieldMapRemove.events)}`
    );

    const tracedCollectionInitializers = await runWorkerCase(
      page,
      [
        'using System.Collections.Generic;',
        'public class Solution {',
        '  public int UseInitializers(int value) {',
        '    List<int> list = new List<int> { value, value + 1 };',
        '    var seen = new Dictionary<int, int> { { value, list[0] }, { value + 1, list[1] } };',
        '    var set = new HashSet<int> { value, value + 2 };',
        '    return seen[value] + seen[value + 1] + (set.Contains(value + 2) ? 1 : 0);',
        '  }',
        '}',
      ].join('\n'),
      'UseInitializers',
      { value: 4 },
      assetBaseUrl,
      true
    );
    assertCondition(
      tracedCollectionInitializers.success,
      `C# worker traced collection initializers case should succeed: ${tracedCollectionInitializers.error ?? 'unknown error'}`
    );
    assertCondition(
      tracedCollectionInitializers.output === 10,
      `C# worker traced collection initializers case should return 10, received ${JSON.stringify(tracedCollectionInitializers.output)}`
    );
    assertCondition(
      tracedCollectionInitializers.events?.filter((event) => event.kind === 'mutate' && event.target?.variable === 'list' && event.method === 'Add').length === 2,
      `C# worker traced collection initializers case should include two list Add events, received ${JSON.stringify(tracedCollectionInitializers.events)}`
    );
    assertCondition(
      tracedCollectionInitializers.events?.filter((event) => event.kind === 'mutate' && event.target?.variable === 'seen' && event.method === 'Add').length === 2,
      `C# worker traced collection initializers case should include two dictionary Add events, received ${JSON.stringify(tracedCollectionInitializers.events)}`
    );
    assertCondition(
      tracedCollectionInitializers.events?.filter((event) => event.kind === 'mutate' && event.target?.variable === 'set' && event.method === 'Add').length === 2,
      `C# worker traced collection initializers case should include two HashSet Add events, received ${JSON.stringify(tracedCollectionInitializers.events)}`
    );

    const tracedTargetTypedCollections = await runWorkerCase(
      page,
      [
        'using System.Collections.Generic;',
        'public class Solution {',
        '  public int UseTargetTyped(int value) {',
        '    List<int> list = new() { value, value + 1 };',
        '    Dictionary<int, int> seen = new() { { value, list[0] }, { value + 1, list[1] } };',
        '    HashSet<int> set = new() { value + 2 };',
        '    Queue<int> queue = new();',
        '    queue.Enqueue(seen[value]);',
        '    Stack<int> stack = new();',
        '    stack.Push(queue.Dequeue() + seen[value + 1] + (set.Contains(value + 2) ? 1 : 0));',
        '    return stack.Pop();',
        '  }',
        '}',
      ].join('\n'),
      'UseTargetTyped',
      { value: 4 },
      assetBaseUrl,
      true
    );
    assertCondition(
      tracedTargetTypedCollections.success,
      `C# worker traced target-typed collections case should succeed: ${tracedTargetTypedCollections.error ?? 'unknown error'}`
    );
    assertCondition(
      tracedTargetTypedCollections.output === 10,
      `C# worker traced target-typed collections case should return 10, received ${JSON.stringify(tracedTargetTypedCollections.output)}`
    );
    assertCondition(
      tracedTargetTypedCollections.events?.filter((event) => event.kind === 'mutate' && event.target?.variable === 'list' && event.method === 'Add').length === 2,
      `C# worker traced target-typed collections case should include two list Add events, received ${JSON.stringify(tracedTargetTypedCollections.events)}`
    );
    assertCondition(
      tracedTargetTypedCollections.events?.some((event) => event.kind === 'mutate' && event.target?.variable === 'queue' && event.method === 'Enqueue') === true,
      `C# worker traced target-typed collections case should include Queue Enqueue, received ${JSON.stringify(tracedTargetTypedCollections.events)}`
    );
    assertCondition(
      tracedTargetTypedCollections.events?.some((event) => event.kind === 'mutate' && event.target?.variable === 'stack' && event.method === 'Pop') === true,
      `C# worker traced target-typed collections case should include Stack Pop, received ${JSON.stringify(tracedTargetTypedCollections.events)}`
    );

    const tracedCollectionConstructors = await runWorkerCase(
      page,
      [
        'using System.Collections.Generic;',
        'public class Solution {',
        '  public int UseConstructors(int[] nums) {',
        '    List<int> list = new List<int>(nums);',
        '    Dictionary<int, int> original = new Dictionary<int, int> { { nums[0], nums[1] } };',
        '    Dictionary<int, int> seen = new Dictionary<int, int>(original);',
        '    HashSet<int> set = new HashSet<int>(list);',
        '    Queue<int> queue = new Queue<int>(list);',
        '    Stack<int> stack = new Stack<int>(list);',
        '    List<int> capacityList = new List<int>(4);',
        '    capacityList.Add(stack.Pop());',
        '    return seen[nums[0]] + (set.Contains(nums[1]) ? 1 : 0) + queue.Dequeue() + capacityList[0];',
        '  }',
        '}',
      ].join('\n'),
      'UseConstructors',
      { nums: [2, 3] },
      assetBaseUrl,
      true
    );
    assertCondition(
      tracedCollectionConstructors.success,
      `C# worker traced collection constructors case should succeed: ${tracedCollectionConstructors.error ?? 'unknown error'}`
    );
    assertCondition(
      tracedCollectionConstructors.output === 9,
      `C# worker traced collection constructors case should return 9, received ${JSON.stringify(tracedCollectionConstructors.output)}`
    );
    assertCondition(
      tracedCollectionConstructors.events?.some((event) => event.kind === 'snapshot' && event.target?.variable === 'list') === true,
      `C# worker traced collection constructors case should include list constructor snapshot, received ${JSON.stringify(tracedCollectionConstructors.events)}`
    );
    assertCondition(
      tracedCollectionConstructors.events?.some((event) => event.kind === 'snapshot' && event.target?.variable === 'seen') === true,
      `C# worker traced collection constructors case should include dictionary copy snapshot, received ${JSON.stringify(tracedCollectionConstructors.events)}`
    );
    assertCondition(
      tracedCollectionConstructors.events?.some((event) => event.kind === 'mutate' && event.target?.variable === 'capacityList' && event.method === 'Add') === true,
      `C# worker traced collection constructors case should include capacity list Add, received ${JSON.stringify(tracedCollectionConstructors.events)}`
    );

    const tracedComparerConstructors = await runWorkerCase(
      page,
      [
        'using System;',
        'using System.Collections.Generic;',
        'public class Solution {',
        '  public int UseComparers(string key) {',
        '    Dictionary<string, int> seen = new Dictionary<string, int>(StringComparer.OrdinalIgnoreCase) { { "Hello", 4 } };',
        '    HashSet<string> set = new HashSet<string>(2, StringComparer.OrdinalIgnoreCase);',
        '    set.Add("World");',
        '    Dictionary<string, int> copy = new Dictionary<string, int>(seen, StringComparer.OrdinalIgnoreCase);',
        '    HashSet<string> setCopy = new HashSet<string>(set, StringComparer.OrdinalIgnoreCase);',
        '    return copy[key] + (setCopy.Contains("world") ? 1 : 0);',
        '  }',
        '}',
      ].join('\n'),
      'UseComparers',
      { key: 'hello' },
      assetBaseUrl,
      true
    );
    assertCondition(
      tracedComparerConstructors.success,
      `C# worker traced comparer constructors case should succeed: ${tracedComparerConstructors.error ?? 'unknown error'}`
    );
    assertCondition(
      tracedComparerConstructors.output === 5,
      `C# worker traced comparer constructors case should return 5, received ${JSON.stringify(tracedComparerConstructors.output)}`
    );
    assertCondition(
      tracedComparerConstructors.events?.some((event) => event.kind === 'mutate' && event.target?.variable === 'seen' && event.method === 'Add') === true,
      `C# worker traced comparer constructors case should include dictionary initializer Add, received ${JSON.stringify(tracedComparerConstructors.events)}`
    );
    assertCondition(
      tracedComparerConstructors.events?.some((event) => event.kind === 'mutate' && event.target?.variable === 'set' && event.method === 'Add') === true,
      `C# worker traced comparer constructors case should include HashSet Add, received ${JSON.stringify(tracedComparerConstructors.events)}`
    );

    const tracedPriorityQueueConstructors = await runWorkerCase(
      page,
      [
        'using System.Collections.Generic;',
        'public class Solution {',
        '  public int UsePriorityQueue(int value) {',
        '    var comparer = Comparer<int>.Create((left, right) => left.CompareTo(right));',
        '    PriorityQueue<int, int> heap = new PriorityQueue<int, int>(4, comparer);',
        '    heap.Enqueue(value + 1, value + 1);',
        '    heap.Enqueue(value, value);',
        '    return heap.Dequeue();',
        '  }',
        '}',
      ].join('\n'),
      'UsePriorityQueue',
      { value: 4 },
      assetBaseUrl,
      true
    );
    assertCondition(
      tracedPriorityQueueConstructors.success,
      `C# worker traced priority-queue constructor case should succeed: ${tracedPriorityQueueConstructors.error ?? 'unknown error'}`
    );
    assertCondition(
      tracedPriorityQueueConstructors.output === 4,
      `C# worker traced priority-queue constructor case should return 4, received ${JSON.stringify(tracedPriorityQueueConstructors.output)}`
    );
    assertCondition(
      tracedPriorityQueueConstructors.events?.some((event) => event.kind === 'snapshot' && event.target?.variable === 'heap') === true,
      `C# worker traced priority-queue constructor case should include heap constructor snapshot, received ${JSON.stringify(tracedPriorityQueueConstructors.events)}`
    );
    assertCondition(
      tracedPriorityQueueConstructors.events?.some((event) => event.kind === 'mutate' && event.target?.variable === 'heap' && event.method === 'Enqueue') === true,
      `C# worker traced priority-queue constructor case should include heap Enqueue mutate, received ${JSON.stringify(tracedPriorityQueueConstructors.events)}`
    );

    const twoSum = await runWorkerCase(page, fixture('two-sum.cs'), 'TwoSum', { nums: [2, 7, 11, 15], target: 9 }, assetBaseUrl);
    assertCondition(twoSum.success, `C# worker TwoSum should succeed: ${twoSum.error ?? 'unknown error'}`);
    assertCondition(JSON.stringify(twoSum.output) === JSON.stringify([0, 1]), 'C# worker TwoSum should return [0,1]');

    const opsClass = await runWorkerCase(
      page,
      [
        'public class Counter {',
        '  private int value;',
        '  public Counter(int start) { value = start; }',
        '  public int Inc(int delta) { value += delta; return value; }',
        '  public void Reset() { value = 0; }',
        '  public int Get() { return value; }',
        '}',
      ].join('\n'),
      'Counter',
      {
        operations: ['Counter', 'Inc', 'Inc', 'Reset', 'Get'],
        arguments: [[1], [2], [3], [], []],
      },
      assetBaseUrl,
      false,
      { executionStyle: 'ops-class' }
    );
    assertCondition(opsClass.success, `C# worker ops-class case should succeed: ${opsClass.error ?? 'unknown error'}`);
    assertCondition(
      JSON.stringify(opsClass.output) === JSON.stringify([null, 3, 6, null, 0]),
      `C# worker ops-class case should return operation outputs, received ${JSON.stringify(opsClass.output)}`
    );

    const opsClassTreeConstructor = await runWorkerCase(
      page,
      [
        'public class TreeNode {',
        '  public int val;',
        '  public TreeNode left;',
        '  public TreeNode right;',
        '  public TreeNode(int val = 0, TreeNode left = null, TreeNode right = null) {',
        '    this.val = val;',
        '    this.left = left;',
        '    this.right = right;',
        '  }',
        '}',
        'public class BSTIterator {',
        '  private readonly TreeNode root;',
        '  public BSTIterator(TreeNode root) { this.root = root; }',
        '  public int Next() { return root.left.val; }',
        '  public bool HasNext() { return root.right != null; }',
        '}',
      ].join('\n'),
      'BSTIterator',
      {
        operations: ['BSTIterator', 'Next', 'HasNext'],
        arguments: [
          [{ __type__: 'TreeNode', val: 7, left: { __type__: 'TreeNode', val: 3, left: null, right: null }, right: { __type__: 'TreeNode', val: 15, left: null, right: null } }],
          [],
          [],
        ],
      },
      assetBaseUrl,
      false,
      { executionStyle: 'ops-class' }
    );
    assertCondition(
      opsClassTreeConstructor.success,
      `C# worker ops-class TreeNode constructor case should succeed: ${opsClassTreeConstructor.error ?? 'unknown error'}`
    );
    assertCondition(
      JSON.stringify(opsClassTreeConstructor.output) === JSON.stringify([null, 3, true]),
      `C# worker ops-class TreeNode constructor case should return operation outputs, received ${JSON.stringify(opsClassTreeConstructor.output)}`
    );

    const listNodeInput = await runWorkerCase(
      page,
      [
        'public class Solution {',
        '  public int SumList(ListNode head) {',
        '    int total = 0;',
        '    while (head != null) {',
        '      total += head.val;',
        '      head = head.next;',
        '    }',
        '    return total;',
        '  }',
        '}',
      ].join('\n'),
      'SumList',
      { head: [1, 2, 3, 4] },
      assetBaseUrl
    );
    assertCondition(listNodeInput.success, `C# worker ListNode input case should succeed: ${listNodeInput.error ?? 'unknown error'}`);
    assertCondition(listNodeInput.output === 10, `C# worker ListNode input case should return 10, received ${JSON.stringify(listNodeInput.output)}`);

    const requiredConstructorListNodeInput = await runWorkerCase(
      page,
      [
        'public class ListNode {',
        '  public int val;',
        '  public ListNode next;',
        '  public ListNode(int val) {',
        '    this.val = val;',
        '    this.next = null;',
        '  }',
        '}',
        'public class Solution {',
        '  public int HeadValue(ListNode head) {',
        '    return head.val;',
        '  }',
        '}',
      ].join('\n'),
      'HeadValue',
      { head: [7, 8] },
      assetBaseUrl
    );
    assertCondition(
      requiredConstructorListNodeInput.success,
      `C# worker required-constructor ListNode input case should succeed: ${requiredConstructorListNodeInput.error ?? 'unknown error'}`
    );
    assertCondition(
      requiredConstructorListNodeInput.output === 7,
      `C# worker required-constructor ListNode input case should return 7, received ${JSON.stringify(requiredConstructorListNodeInput.output)}`
    );

    const nullableListNodeInput = await runWorkerCase(
      page,
      [
        'public class Solution {',
        '  public int HasList(ListNode? head) {',
        '    return head == null ? 0 : head.val;',
        '  }',
        '}',
      ].join('\n'),
      'HasList',
      { head: null },
      assetBaseUrl
    );
    assertCondition(
      nullableListNodeInput.success,
      `C# worker nullable ListNode input case should succeed: ${nullableListNodeInput.error ?? 'unknown error'}`
    );
    assertCondition(
      nullableListNodeInput.output === 0,
      `C# worker nullable ListNode input case should return 0, received ${JSON.stringify(nullableListNodeInput.output)}`
    );

    const treeNodeInput = await runWorkerCase(
      page,
      [
        'public class Solution {',
        '  public int SumTree(TreeNode root) {',
        '    if (root == null) return 0;',
        '    return root.val + SumTree(root.left) + SumTree(root.right);',
        '  }',
        '}',
      ].join('\n'),
      'SumTree',
      { root: [1, 2, 3, null, 4] },
      assetBaseUrl
    );
    assertCondition(treeNodeInput.success, `C# worker TreeNode input case should succeed: ${treeNodeInput.error ?? 'unknown error'}`);
    assertCondition(treeNodeInput.output === 10, `C# worker TreeNode input case should return 10, received ${JSON.stringify(treeNodeInput.output)}`);

    const nullableTreeNodeInput = await runWorkerCase(
      page,
      [
        'public class Solution {',
        '  public int HasTree(TreeNode? root) {',
        '    return root == null ? 0 : root.val;',
        '  }',
        '}',
      ].join('\n'),
      'HasTree',
      { root: null },
      assetBaseUrl
    );
    assertCondition(
      nullableTreeNodeInput.success,
      `C# worker nullable TreeNode input case should succeed: ${nullableTreeNodeInput.error ?? 'unknown error'}`
    );
    assertCondition(
      nullableTreeNodeInput.output === 0,
      `C# worker nullable TreeNode input case should return 0, received ${JSON.stringify(nullableTreeNodeInput.output)}`
    );

    const objectNodeInput = await runWorkerCase(
      page,
      [
        'public class Solution {',
        '  public int SumBoth(ListNode head, TreeNode root) {',
        '    return head.val + head.next.val + root.val + root.left.val;',
        '  }',
        '}',
      ].join('\n'),
      'SumBoth',
      {
        head: { val: 5, next: { value: 6, next: null } },
        root: { value: 7, left: { val: 8 }, right: null },
      },
      assetBaseUrl
    );
    assertCondition(objectNodeInput.success, `C# worker object node input case should succeed: ${objectNodeInput.error ?? 'unknown error'}`);
    assertCondition(objectNodeInput.output === 26, `C# worker object node input case should return 26, received ${JSON.stringify(objectNodeInput.output)}`);

    const listNodeOutput = await runWorkerCase(
      page,
      [
        'public class Solution {',
        '  public ListNode BuildList(int value) {',
        '    return new ListNode(value, new ListNode(value + 1));',
        '  }',
        '}',
      ].join('\n'),
      'BuildList',
      { value: 4 },
      assetBaseUrl
    );
    assertCondition(listNodeOutput.success, `C# worker ListNode output case should succeed: ${listNodeOutput.error ?? 'unknown error'}`);
    assertCondition(
      JSON.stringify(listNodeOutput.output) === JSON.stringify({ val: 4, next: { val: 5, next: null } }),
      `C# worker ListNode output case should serialize node fields, received ${JSON.stringify(listNodeOutput.output)}`
    );

    const treeNodeOutput = await runWorkerCase(
      page,
      [
        'public class Solution {',
        '  public TreeNode BuildTree(int value) {',
        '    return new TreeNode(value, new TreeNode(value + 1), new TreeNode(value + 2));',
        '  }',
        '}',
      ].join('\n'),
      'BuildTree',
      { value: 4 },
      assetBaseUrl
    );
    assertCondition(treeNodeOutput.success, `C# worker TreeNode output case should succeed: ${treeNodeOutput.error ?? 'unknown error'}`);
    assertCondition(
      JSON.stringify(treeNodeOutput.output) === JSON.stringify({
        val: 4,
        left: { val: 5, left: null, right: null },
        right: { val: 6, left: null, right: null },
      }),
      `C# worker TreeNode output case should serialize node fields, received ${JSON.stringify(treeNodeOutput.output)}`
    );

    const listNodeCycleOutput = await runWorkerCase(
      page,
      [
        'public class Solution {',
        '  public ListNode BuildCycle() {',
        '    ListNode head = new ListNode(1);',
        '    head.next = new ListNode(2);',
        '    head.next.next = head;',
        '    return head;',
        '  }',
        '}',
      ].join('\n'),
      'BuildCycle',
      {},
      assetBaseUrl
    );
    assertCondition(listNodeCycleOutput.success, `C# worker ListNode cycle output case should succeed: ${listNodeCycleOutput.error ?? 'unknown error'}`);
    {
      const output = listNodeCycleOutput.output as { val?: number; next?: { val?: number; next?: { __ref__?: string } }; __id__?: string } | undefined;
      assertCondition(
        output?.val === 1
          && output.next?.val === 2
          && typeof output.__id__ === 'string'
          && output.next.next?.__ref__ === output.__id__,
        `C# worker ListNode cycle output case should serialize linked id/ref markers, received ${JSON.stringify(listNodeCycleOutput.output)}`
      );
    }

    const treeNodeAliasOutput = await runWorkerCase(
      page,
      [
        'public class Solution {',
        '  public TreeNode BuildAliasedTree() {',
        '    TreeNode root = new TreeNode(1);',
        '    root.left = new TreeNode(2);',
        '    root.right = root.left;',
        '    return root;',
        '  }',
        '}',
      ].join('\n'),
      'BuildAliasedTree',
      {},
      assetBaseUrl
    );
    assertCondition(treeNodeAliasOutput.success, `C# worker TreeNode alias output case should succeed: ${treeNodeAliasOutput.error ?? 'unknown error'}`);
    {
      const output = treeNodeAliasOutput.output as {
        val?: number;
        left?: { val?: number; __id__?: string };
        right?: { __ref__?: string };
      } | undefined;
      assertCondition(
        output?.val === 1
          && output.left?.val === 2
          && typeof output.left.__id__ === 'string'
          && output.right?.__ref__ === output.left.__id__,
        `C# worker TreeNode alias output case should serialize linked id/ref markers, received ${JSON.stringify(treeNodeAliasOutput.output)}`
      );
    }

    const tracedListNodeValues = await runWorkerCase(
      page,
      [
        'public class Solution {',
        '  public int HeadValue(ListNode head) {',
        '    ListNode curr = head;',
        '    return curr.val;',
        '  }',
        '}',
      ].join('\n'),
      'HeadValue',
      { head: [7, 8] },
      assetBaseUrl,
      true
    );
    assertCondition(
      tracedListNodeValues.success,
      `C# worker traced ListNode values case should succeed: ${tracedListNodeValues.error ?? 'unknown error'}`
    );
    assertCondition(
      tracedListNodeValues.events?.some((event) =>
        event.kind === 'snapshot'
        && event.target?.variable === 'curr'
        && (event.value as { __type__?: string; val?: number } | undefined)?.__type__ === 'ListNode'
        && (event.value as { val?: number } | undefined)?.val === 7) === true,
      `C# worker traced ListNode values case should include normalized ListNode snapshot, received ${JSON.stringify(tracedListNodeValues.events)}`
    );
    assertCondition(
      tracedListNodeValues.events?.some((event) =>
        event.kind === 'call'
        && event.function === 'HeadValue'
        && Array.isArray(event.args)
        && (event.args[0] as { __type__?: string; val?: number } | undefined)?.__type__ === 'ListNode') === true,
      `C# worker traced ListNode values case should include normalized call args, received ${JSON.stringify(tracedListNodeValues.events)}`
    );
    assertCondition(
      tracedListNodeValues.events?.some((event) =>
        event.kind === 'read'
        && event.target?.variable === 'curr'
        && event.target.path?.[0] === 'val'
        && event.value === 7) === true,
      `C# worker traced ListNode values case should include curr.val read, received ${JSON.stringify(tracedListNodeValues.events)}`
    );

    const tracedListNodeFieldWrites = await runWorkerCase(
      page,
      [
        'public class Solution {',
        '  public ListNode Reverse(ListNode head) {',
        '    ListNode prev = null;',
        '    ListNode curr = head;',
        '    while (curr != null) {',
        '      ListNode next = curr.next;',
        '      curr.next = prev;',
        '      prev = curr;',
        '      curr = next;',
        '    }',
        '    return prev;',
        '  }',
        '}',
      ].join('\n'),
      'Reverse',
      { head: [1, 2] },
      assetBaseUrl,
      true
    );
    assertCondition(
      tracedListNodeFieldWrites.success,
      `C# worker traced ListNode field writes case should succeed: ${tracedListNodeFieldWrites.error ?? 'unknown error'}`
    );
    assertCondition(
      tracedListNodeFieldWrites.events?.some((event) =>
        event.kind === 'read'
        && event.target?.variable === 'curr'
        && event.target.path?.[0] === 'next'
        && (event.value as { __type__?: string; val?: number } | undefined)?.__type__ === 'ListNode'
        && (event.value as { val?: number } | undefined)?.val === 2) === true,
      `C# worker traced ListNode field writes case should include curr.next read, received ${JSON.stringify(tracedListNodeFieldWrites.events)}`
    );
    assertCondition(
      tracedListNodeFieldWrites.events?.some((event) =>
        event.kind === 'write'
        && event.target?.variable === 'curr'
        && event.target.path?.[0] === 'next') === true,
      `C# worker traced ListNode field writes case should include curr.next write, received ${JSON.stringify(tracedListNodeFieldWrites.events)}`
    );

    const tracedTreeNodeValues = await runWorkerCase(
      page,
      [
        'public class Solution {',
        '  public int SumTree(TreeNode root) {',
        '    if (root == null) return 0;',
        '    return root.val + SumTree(root.left) + SumTree(root.right);',
        '  }',
        '}',
      ].join('\n'),
      'SumTree',
      { root: [1, 2, 3] },
      assetBaseUrl,
      true
    );
    assertCondition(
      tracedTreeNodeValues.success,
      `C# worker traced TreeNode values case should succeed: ${tracedTreeNodeValues.error ?? 'unknown error'}`
    );
    assertCondition(
      tracedTreeNodeValues.events?.some((event) =>
        event.kind === 'call'
        && event.function === 'SumTree'
        && Array.isArray(event.args)
        && (event.args[0] as { __type__?: string; val?: number } | undefined)?.__type__ === 'TreeNode'
        && (event.args[0] as { val?: number } | undefined)?.val === 1) === true,
      `C# worker traced TreeNode values case should include normalized recursive call args, received ${JSON.stringify(tracedTreeNodeValues.events)}`
    );
    assertCondition(
      tracedTreeNodeValues.events?.some((event) =>
        event.kind === 'return'
        && event.function === 'SumTree'
        && event.value === 6) === true,
      `C# worker traced TreeNode values case should include final return value, received ${JSON.stringify(tracedTreeNodeValues.events)}`
    );
    assertCondition(
      tracedTreeNodeValues.events?.some((event) =>
        event.kind === 'read'
        && event.target?.variable === 'root'
        && event.target.path?.[0] === 'left'
        && (event.value as { __type__?: string; val?: number } | undefined)?.__type__ === 'TreeNode'
        && (event.value as { val?: number } | undefined)?.val === 2) === true,
      `C# worker traced TreeNode values case should include root.left read, received ${JSON.stringify(tracedTreeNodeValues.events)}`
    );
    assertCondition(
      tracedTreeNodeValues.events?.some((event) =>
        event.kind === 'read'
        && event.target?.variable === 'root'
        && event.target.path?.[0] === 'val'
        && event.value === 1) === true,
      `C# worker traced TreeNode values case should include root.val read, received ${JSON.stringify(tracedTreeNodeValues.events)}`
    );

    const tracedNestedTreeNodeFields = await runWorkerCase(
      page,
      [
        'public class Solution {',
        '  public int LeftValue(TreeNode root) {',
        '    return root.left.val;',
        '  }',
        '}',
      ].join('\n'),
      'LeftValue',
      { root: [1, 9, 3] },
      assetBaseUrl,
      true
    );
    assertCondition(
      tracedNestedTreeNodeFields.success,
      `C# worker traced nested TreeNode field case should succeed: ${tracedNestedTreeNodeFields.error ?? 'unknown error'}`
    );
    assertCondition(
      tracedNestedTreeNodeFields.events?.some((event) =>
        event.kind === 'read'
        && event.target?.variable === 'root'
        && event.target.path?.[0] === 'left'
        && event.value === 9) === true,
      `C# worker traced nested TreeNode field case should include root.left read, received ${JSON.stringify(tracedNestedTreeNodeFields.events)}`
    );

    const tracedNestedTreeNodeFieldWrites = await runWorkerCase(
      page,
      [
        'public class Solution {',
        '  public int SetLeftValue(TreeNode root, int value) {',
        '    root.left.val = value;',
        '    return root.left.val;',
        '  }',
        '}',
      ].join('\n'),
      'SetLeftValue',
      { root: [1, 2, 3], value: 11 },
      assetBaseUrl,
      true
    );
    assertCondition(
      tracedNestedTreeNodeFieldWrites.success,
      `C# worker traced nested TreeNode field write case should succeed: ${tracedNestedTreeNodeFieldWrites.error ?? 'unknown error'}`
    );
    assertCondition(
      tracedNestedTreeNodeFieldWrites.output === 11,
      `C# worker traced nested TreeNode field write case should return 11, received ${JSON.stringify(tracedNestedTreeNodeFieldWrites.output)}`
    );
    assertCondition(
      tracedNestedTreeNodeFieldWrites.events?.some((event) =>
        event.kind === 'write'
        && event.target?.variable === 'root'
        && event.target.path?.[0] === 'left'
        && event.target.path?.[1] === 'val'
        && event.value === 11) === true,
      `C# worker traced nested TreeNode field write case should include root.left.val write, received ${JSON.stringify(tracedNestedTreeNodeFieldWrites.events)}`
    );

    const renamedParams = await runWorkerCase(
      page,
      'public class Solution { public int Add(int left, int right) { return left + right; } }',
      'Add',
      { a: 2, b: 3 },
      assetBaseUrl
    );
    assertCondition(renamedParams.success, `C# worker renamed-parameter Add should succeed: ${renamedParams.error ?? 'unknown error'}`);
    assertCondition(renamedParams.output === 5, 'C# worker generated driver should map renamed parameters by input order');

    const compileError = await runWorkerCase(page, fixture('compile-error.cs'), 'Add', { a: 2, b: 3 }, assetBaseUrl);
    assertCondition(!compileError.success, 'C# worker compile-error fixture should fail');
    assertCondition(
      compileError.error?.includes("Cannot implicitly convert type 'string' to 'int'") === true,
      `C# worker compile-error fixture should preserve Roslyn diagnostic text, received ${compileError.error}`
    );
    assertCondition(
      compileError.diagnostics?.some((diagnostic) => diagnostic.file.endsWith('solution.cs') && diagnostic.line === 5) === true,
      `C# worker diagnostics should map to solution.cs line 5, received ${JSON.stringify(compileError.diagnostics)}`
    );
    assertCondition(
      compileError.diagnostics?.some((diagnostic) =>
        diagnostic.file.endsWith('solution.cs')
        && diagnostic.line === 5
        && diagnostic.column > 0
        && diagnostic.message.includes("Cannot implicitly convert type 'string' to 'int'")) === true,
      `C# worker diagnostics should include mapped line/column/message, received ${JSON.stringify(compileError.diagnostics)}`
    );

    const voidReturn = await runWorkerCase(page, fixture('void-return.cs'), 'Add', { a: 2, b: 3 }, assetBaseUrl);
    assertCondition(voidReturn.success, `C# worker void-return fixture should succeed: ${voidReturn.error ?? 'unknown error'}`);
    assertCondition(
      voidReturn.output === null,
      `C# worker void-return fixture should return null output, received ${JSON.stringify(voidReturn.output)}`
    );

    console.log('PASS: browser C# worker compiles and runs through vendored harness assets');
  } finally {
    await browser?.close();
    await server.close();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
