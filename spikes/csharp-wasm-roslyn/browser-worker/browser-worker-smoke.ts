#!/usr/bin/env npx tsx

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, extname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, type Browser, type Page } from 'playwright';

interface WorkerResponse {
  success: boolean;
  output?: unknown;
  error?: string;
  diagnostics?: Array<{ file: string; line: number; column: number; message: string }>;
  consoleOutput?: string[];
  events?: Array<{ kind: string; line?: number; function?: string; method?: string; value?: unknown; args?: unknown[]; target?: { variable: string; path?: unknown[] } }>;
}

const __dirname = dirname(fileURLToPath(import.meta.url));
const spikeRoot = resolve(__dirname, '..');
const repoRoot = resolve(spikeRoot, '..', '..');
const projectRoot = resolve(spikeRoot, 'TraceCode.CSharpHost');
const fixtureRoot = resolve(spikeRoot, 'fixtures');

function assertCondition(condition: boolean, message: string): void {
  if (!condition) {
    throw new Error(message);
  }
}

function findPublishedAssetDir(): string {
  const explicitDir = process.env.CSHARP_WASM_PUBLISH_DIR;
  const candidates = [
    explicitDir,
    join(projectRoot, 'bin', 'Release', 'net8.0', 'browser-wasm', 'AppBundle'),
  ].filter(Boolean) as string[];

  const match = candidates.find((candidate) => existsSync(join(candidate, '_framework', 'dotnet.js')));
  if (!match) {
    throw new Error('Unable to find published C# WASM assets. Run `pnpm run spike:csharp:publish` first.');
  }
  return resolve(match);
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
    case '.dll':
      return 'application/octet-stream';
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
    throw new Error('Unable to resolve smoke server address');
  }

  return {
    origin: `http://127.0.0.1:${address.port}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

async function runWorkerCase(
  page: Page,
  source: string,
  functionName: string,
  inputs: Record<string, unknown>,
  assetBaseUrl: string,
  trace = false
): Promise<WorkerResponse> {
  return page.evaluate(
    async ({ source, functionName, inputs, assetBaseUrl, trace }) => {
      const worker = new Worker('/spikes/csharp-wasm-roslyn/browser-worker/csharp-worker.js', { type: 'module' });
      let nextId = 0;

      function send(type, payload) {
        const id = String(++nextId);
        return new Promise((resolve, reject) => {
          const timeoutId = setTimeout(() => {
            worker.terminate();
            reject(new Error(`C# worker request timed out: ${type}`));
          }, 30_000);

          worker.addEventListener(
            'message',
            (event) => {
              if (event.data?.id !== id) return;
              clearTimeout(timeoutId);
              if (event.data.type === 'error') {
                reject(new Error(event.data.payload?.error ?? 'C# worker error'));
                return;
              }
              resolve(event.data.payload);
            },
            { once: false }
          );
          worker.postMessage({ id, type, payload });
        });
      }

      await send('init', { assetBaseUrl });
      const result = await send(trace ? 'execute-with-tracing' : 'execute-code', { source, functionName, inputs, assetBaseUrl });
      worker.terminate();
      return result;
    },
    { source, functionName, inputs, assetBaseUrl, trace }
  ) as Promise<WorkerResponse>;
}

function fixture(name: string): string {
  return readFileSync(join(fixtureRoot, name), 'utf8');
}

async function main(): Promise<void> {
  const assetDir = findPublishedAssetDir();
  const server = await startStaticServer(repoRoot);
  let browser: Browser | null = null;

  try {
    const assetBaseUrl = `${server.origin}/${assetDir.slice(repoRoot.length + 1).replaceAll(sep, '/')}`;
    browser = await chromium.launch();
    const page = await browser.newPage();
    await page.goto(`${server.origin}/spikes/csharp-wasm-roslyn/browser-worker/blank.html`);
    await page.evaluate('globalThis.__name = (fn) => fn');

    const add = await runWorkerCase(page, fixture('add.cs'), 'Add', { a: 2, b: 3 }, assetBaseUrl);
    assertCondition(add.success, `Browser worker Add should succeed: ${add.error ?? 'unknown error'}`);
    assertCondition(add.output === 5, `Browser worker Add should return 5, received ${JSON.stringify(add.output)}`);
    assertCondition(
      add.consoleOutput?.includes('adding 2 and 3') === true,
      `Browser worker should capture stdout, received ${JSON.stringify(add.consoleOutput)}`
    );
    console.log('PASS: browser worker compiled and ran C# Add');

    const tracedAdd = await runWorkerCase(
      page,
      'public class Solution { public int Add(int a, int b) { int sum = a + b; return sum; } }',
      'Add',
      { a: 2, b: 3 },
      assetBaseUrl,
      true
    );
    assertCondition(tracedAdd.success, `Browser worker traced Add should succeed: ${tracedAdd.error ?? 'unknown error'}`);
    assertCondition(
      tracedAdd.events?.some((event) => event.kind === 'call' && event.function === 'Add') === true,
      `Browser worker traced Add should include call event, received ${JSON.stringify(tracedAdd.events)}`
    );
    assertCondition(
      tracedAdd.events?.some((event) => event.kind === 'write' && event.target?.variable === 'sum') === true,
      `Browser worker traced Add should include local write event, received ${JSON.stringify(tracedAdd.events)}`
    );
    assertCondition(
      tracedAdd.events?.some((event) => event.kind === 'return' && event.function === 'Add' && event.value === 5) === true,
      `Browser worker traced Add should include return event with value 5, received ${JSON.stringify(tracedAdd.events)}`
    );
    console.log('PASS: browser worker returned C# trace events');

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
      `Browser worker traced expression-bodied Add should succeed: ${tracedExpressionBody.error ?? 'unknown error'}`
    );
    assertCondition(
      tracedExpressionBody.output === 5,
      `Browser worker traced expression-bodied Add should return 5, received ${JSON.stringify(tracedExpressionBody.output)}`
    );
    assertCondition(
      tracedExpressionBody.events?.some((event) => event.kind === 'return' && event.function === 'Add' && event.value === 5) === true,
      `Browser worker traced expression-bodied Add should include return value 5, received ${JSON.stringify(tracedExpressionBody.events)}`
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
      `Browser worker traced expression-bodied void method should succeed: ${tracedVoidExpressionBody.error ?? 'unknown error'}`
    );
    assertCondition(
      tracedVoidExpressionBody.output === null,
      `Browser worker traced expression-bodied void method should return null output, received ${JSON.stringify(tracedVoidExpressionBody.output)}`
    );
    assertCondition(
      tracedVoidExpressionBody.consoleOutput?.includes('7') === true,
      `Browser worker traced expression-bodied void method should capture stdout, received ${JSON.stringify(tracedVoidExpressionBody.consoleOutput)}`
    );
    assertCondition(
      tracedVoidExpressionBody.events?.some((event) => event.kind === 'return' && event.function === 'Log') === true,
      `Browser worker traced expression-bodied void method should include return event, received ${JSON.stringify(tracedVoidExpressionBody.events)}`
    );
    console.log('PASS: browser worker returned C# expression-bodied method trace events');

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
    assertCondition(tracedArray.success, `Browser worker traced array case should succeed: ${tracedArray.error ?? 'unknown error'}`);
    assertCondition(tracedArray.output === 5, `Browser worker traced array case should return 5, received ${JSON.stringify(tracedArray.output)}`);
    assertCondition(
      tracedArray.events?.some((event) => event.kind === 'read' && event.target?.variable === 'nums' && event.target.path?.[0] === 0) === true,
      `Browser worker traced array case should include nums[0] read, received ${JSON.stringify(tracedArray.events)}`
    );
    assertCondition(
      tracedArray.events?.some((event) => event.kind === 'write' && event.target?.variable === 'nums' && event.target.path?.[0] === 1) === true,
      `Browser worker traced array case should include nums[1] write, received ${JSON.stringify(tracedArray.events)}`
    );
    console.log('PASS: browser worker returned C# array indexed trace events');

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
      `Browser worker traced compound array case should succeed: ${tracedCompoundArray.error ?? 'unknown error'}`
    );
    assertCondition(
      tracedCompoundArray.output === 9,
      `Browser worker traced compound array case should return 9, received ${JSON.stringify(tracedCompoundArray.output)}`
    );
    assertCondition(
      tracedCompoundArray.events?.some((event) => event.kind === 'write' && event.target?.variable === 'nums' && event.target.path?.[0] === 0 && event.value === 5) === true,
      `Browser worker traced compound array case should include nums[0] compound write, received ${JSON.stringify(tracedCompoundArray.events)}`
    );
    assertCondition(
      tracedCompoundArray.events?.some((event) => event.kind === 'write' && event.target?.variable === 'nums' && event.target.path?.[0] === 1 && event.value === 5) === true,
      `Browser worker traced compound array case should include nums[1] increment write, received ${JSON.stringify(tracedCompoundArray.events)}`
    );
    console.log('PASS: browser worker returned C# compound array indexed write events');

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
      `Browser worker traced collections case should succeed: ${tracedCollections.error ?? 'unknown error'}`
    );
    assertCondition(
      tracedCollections.output === 5,
      `Browser worker traced collections case should return 5, received ${JSON.stringify(tracedCollections.output)}`
    );
    assertCondition(
      tracedCollections.events?.some((event) => event.kind === 'mutate' && event.target?.variable === 'list') === true,
      `Browser worker traced collections case should include list mutate, received ${JSON.stringify(tracedCollections.events)}`
    );
    assertCondition(
      tracedCollections.events?.some((event) => event.kind === 'write' && event.target?.variable === 'seen' && event.target.path?.[0] === 4) === true,
      `Browser worker traced collections case should include dictionary keyed write, received ${JSON.stringify(tracedCollections.events)}`
    );
    console.log('PASS: browser worker returned C# List and Dictionary wrapper events');

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
      `Browser worker traced explicit collections case should succeed: ${tracedExplicitCollections.error ?? 'unknown error'}`
    );
    assertCondition(
      tracedExplicitCollections.output === 5,
      `Browser worker traced explicit collections case should return 5, received ${JSON.stringify(tracedExplicitCollections.output)}`
    );
    assertCondition(
      tracedExplicitCollections.events?.some((event) => event.kind === 'mutate' && event.target?.variable === 'list') === true,
      `Browser worker traced explicit collections case should include list mutate, received ${JSON.stringify(tracedExplicitCollections.events)}`
    );
    assertCondition(
      tracedExplicitCollections.events?.some((event) => event.kind === 'write' && event.target?.variable === 'seen' && event.target.path?.[0] === 4) === true,
      `Browser worker traced explicit collections case should include dictionary keyed write, received ${JSON.stringify(tracedExplicitCollections.events)}`
    );
    console.log('PASS: browser worker returned explicit C# List and Dictionary wrapper events');

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
      `Browser worker traced interview collections case should succeed: ${tracedInterviewCollections.error ?? 'unknown error'}`
    );
    assertCondition(
      tracedInterviewCollections.output === 6,
      `Browser worker traced interview collections case should return 6, received ${JSON.stringify(tracedInterviewCollections.output)}`
    );
    assertCondition(
      tracedInterviewCollections.events?.some((event) => event.kind === 'mutate' && event.target?.variable === 'set' && event.method === 'Add') === true,
      `Browser worker traced interview collections case should include HashSet Add, received ${JSON.stringify(tracedInterviewCollections.events)}`
    );
    assertCondition(
      tracedInterviewCollections.events?.some((event) => event.kind === 'mutate' && event.target?.variable === 'queue' && event.method === 'Dequeue') === true,
      `Browser worker traced interview collections case should include Queue Dequeue, received ${JSON.stringify(tracedInterviewCollections.events)}`
    );
    assertCondition(
      tracedInterviewCollections.events?.some((event) => event.kind === 'mutate' && event.target?.variable === 'stack' && event.method === 'Pop') === true,
      `Browser worker traced interview collections case should include Stack Pop, received ${JSON.stringify(tracedInterviewCollections.events)}`
    );
    console.log('PASS: browser worker returned C# HashSet, Queue, and Stack wrapper events');

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
      `Browser worker traced collection initializers case should succeed: ${tracedCollectionInitializers.error ?? 'unknown error'}`
    );
    assertCondition(
      tracedCollectionInitializers.output === 10,
      `Browser worker traced collection initializers case should return 10, received ${JSON.stringify(tracedCollectionInitializers.output)}`
    );
    assertCondition(
      tracedCollectionInitializers.events?.filter((event) => event.kind === 'mutate' && event.target?.variable === 'list' && event.method === 'Add').length === 2,
      `Browser worker traced collection initializers case should include two list Add events, received ${JSON.stringify(tracedCollectionInitializers.events)}`
    );
    assertCondition(
      tracedCollectionInitializers.events?.filter((event) => event.kind === 'mutate' && event.target?.variable === 'seen' && event.method === 'Add').length === 2,
      `Browser worker traced collection initializers case should include two dictionary Add events, received ${JSON.stringify(tracedCollectionInitializers.events)}`
    );
    assertCondition(
      tracedCollectionInitializers.events?.filter((event) => event.kind === 'mutate' && event.target?.variable === 'set' && event.method === 'Add').length === 2,
      `Browser worker traced collection initializers case should include two HashSet Add events, received ${JSON.stringify(tracedCollectionInitializers.events)}`
    );
    console.log('PASS: browser worker returned C# collection initializer wrapper events');

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
      `Browser worker traced target-typed collections case should succeed: ${tracedTargetTypedCollections.error ?? 'unknown error'}`
    );
    assertCondition(
      tracedTargetTypedCollections.output === 10,
      `Browser worker traced target-typed collections case should return 10, received ${JSON.stringify(tracedTargetTypedCollections.output)}`
    );
    assertCondition(
      tracedTargetTypedCollections.events?.filter((event) => event.kind === 'mutate' && event.target?.variable === 'list' && event.method === 'Add').length === 2,
      `Browser worker traced target-typed collections case should include two list Add events, received ${JSON.stringify(tracedTargetTypedCollections.events)}`
    );
    assertCondition(
      tracedTargetTypedCollections.events?.some((event) => event.kind === 'mutate' && event.target?.variable === 'queue' && event.method === 'Enqueue') === true,
      `Browser worker traced target-typed collections case should include Queue Enqueue, received ${JSON.stringify(tracedTargetTypedCollections.events)}`
    );
    assertCondition(
      tracedTargetTypedCollections.events?.some((event) => event.kind === 'mutate' && event.target?.variable === 'stack' && event.method === 'Pop') === true,
      `Browser worker traced target-typed collections case should include Stack Pop, received ${JSON.stringify(tracedTargetTypedCollections.events)}`
    );
    console.log('PASS: browser worker returned C# target-typed collection wrapper events');

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
      `Browser worker traced collection constructors case should succeed: ${tracedCollectionConstructors.error ?? 'unknown error'}`
    );
    assertCondition(
      tracedCollectionConstructors.output === 9,
      `Browser worker traced collection constructors case should return 9, received ${JSON.stringify(tracedCollectionConstructors.output)}`
    );
    assertCondition(
      tracedCollectionConstructors.events?.some((event) => event.kind === 'snapshot' && event.target?.variable === 'list') === true,
      `Browser worker traced collection constructors case should include list constructor snapshot, received ${JSON.stringify(tracedCollectionConstructors.events)}`
    );
    assertCondition(
      tracedCollectionConstructors.events?.some((event) => event.kind === 'snapshot' && event.target?.variable === 'seen') === true,
      `Browser worker traced collection constructors case should include dictionary copy snapshot, received ${JSON.stringify(tracedCollectionConstructors.events)}`
    );
    assertCondition(
      tracedCollectionConstructors.events?.some((event) => event.kind === 'mutate' && event.target?.variable === 'capacityList' && event.method === 'Add') === true,
      `Browser worker traced collection constructors case should include capacity list Add, received ${JSON.stringify(tracedCollectionConstructors.events)}`
    );
    console.log('PASS: browser worker returned C# collection constructor wrapper events');

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
      `Browser worker traced comparer constructors case should succeed: ${tracedComparerConstructors.error ?? 'unknown error'}`
    );
    assertCondition(
      tracedComparerConstructors.output === 5,
      `Browser worker traced comparer constructors case should return 5, received ${JSON.stringify(tracedComparerConstructors.output)}`
    );
    assertCondition(
      tracedComparerConstructors.events?.some((event) => event.kind === 'mutate' && event.target?.variable === 'seen' && event.method === 'Add') === true,
      `Browser worker traced comparer constructors case should include dictionary initializer Add, received ${JSON.stringify(tracedComparerConstructors.events)}`
    );
    assertCondition(
      tracedComparerConstructors.events?.some((event) => event.kind === 'mutate' && event.target?.variable === 'set' && event.method === 'Add') === true,
      `Browser worker traced comparer constructors case should include HashSet Add, received ${JSON.stringify(tracedComparerConstructors.events)}`
    );
    console.log('PASS: browser worker returned C# comparer constructor wrapper events');

    const twoSum = await runWorkerCase(page, fixture('two-sum.cs'), 'TwoSum', { nums: [2, 7, 11, 15], target: 9 }, assetBaseUrl);
    assertCondition(twoSum.success, `Browser worker TwoSum should succeed: ${twoSum.error ?? 'unknown error'}`);
    assertCondition(
      JSON.stringify(twoSum.output) === JSON.stringify([0, 1]),
      `Browser worker TwoSum should return [0,1], received ${JSON.stringify(twoSum.output)}`
    );
    console.log('PASS: browser worker compiled and ran C# TwoSum');

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
    assertCondition(listNodeInput.success, `Browser worker ListNode input case should succeed: ${listNodeInput.error ?? 'unknown error'}`);
    assertCondition(listNodeInput.output === 10, `Browser worker ListNode input case should return 10, received ${JSON.stringify(listNodeInput.output)}`);
    console.log('PASS: browser worker hydrated C# ListNode array inputs');

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
      `Browser worker nullable ListNode input case should succeed: ${nullableListNodeInput.error ?? 'unknown error'}`
    );
    assertCondition(
      nullableListNodeInput.output === 0,
      `Browser worker nullable ListNode input case should return 0, received ${JSON.stringify(nullableListNodeInput.output)}`
    );
    console.log('PASS: browser worker hydrated nullable C# ListNode inputs');

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
    assertCondition(treeNodeInput.success, `Browser worker TreeNode input case should succeed: ${treeNodeInput.error ?? 'unknown error'}`);
    assertCondition(treeNodeInput.output === 10, `Browser worker TreeNode input case should return 10, received ${JSON.stringify(treeNodeInput.output)}`);
    console.log('PASS: browser worker hydrated C# TreeNode level-order inputs');

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
      `Browser worker nullable TreeNode input case should succeed: ${nullableTreeNodeInput.error ?? 'unknown error'}`
    );
    assertCondition(
      nullableTreeNodeInput.output === 0,
      `Browser worker nullable TreeNode input case should return 0, received ${JSON.stringify(nullableTreeNodeInput.output)}`
    );
    console.log('PASS: browser worker hydrated nullable C# TreeNode inputs');

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
    assertCondition(objectNodeInput.success, `Browser worker object node input case should succeed: ${objectNodeInput.error ?? 'unknown error'}`);
    assertCondition(objectNodeInput.output === 26, `Browser worker object node input case should return 26, received ${JSON.stringify(objectNodeInput.output)}`);
    console.log('PASS: browser worker hydrated object-shaped C# ListNode and TreeNode inputs');

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
    assertCondition(listNodeOutput.success, `Browser worker ListNode output case should succeed: ${listNodeOutput.error ?? 'unknown error'}`);
    assertCondition(
      JSON.stringify(listNodeOutput.output) === JSON.stringify({ val: 4, next: { val: 5, next: null } }),
      `Browser worker ListNode output case should serialize node fields, received ${JSON.stringify(listNodeOutput.output)}`
    );
    console.log('PASS: browser worker serialized C# ListNode outputs');

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
    assertCondition(treeNodeOutput.success, `Browser worker TreeNode output case should succeed: ${treeNodeOutput.error ?? 'unknown error'}`);
    assertCondition(
      JSON.stringify(treeNodeOutput.output) === JSON.stringify({
        val: 4,
        left: { val: 5, left: null, right: null },
        right: { val: 6, left: null, right: null },
      }),
      `Browser worker TreeNode output case should serialize node fields, received ${JSON.stringify(treeNodeOutput.output)}`
    );
    console.log('PASS: browser worker serialized C# TreeNode outputs');

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
      `Browser worker traced ListNode values case should succeed: ${tracedListNodeValues.error ?? 'unknown error'}`
    );
    assertCondition(
      tracedListNodeValues.events?.some((event) =>
        event.kind === 'write'
        && event.target?.variable === 'curr'
        && (event.value as { __type__?: string; val?: number } | undefined)?.__type__ === 'ListNode'
        && (event.value as { val?: number } | undefined)?.val === 7) === true,
      `Browser worker traced ListNode values case should include normalized ListNode write, received ${JSON.stringify(tracedListNodeValues.events)}`
    );
    assertCondition(
      tracedListNodeValues.events?.some((event) =>
        event.kind === 'call'
        && event.function === 'HeadValue'
        && Array.isArray(event.args)
        && (event.args[0] as { __type__?: string; val?: number } | undefined)?.__type__ === 'ListNode') === true,
      `Browser worker traced ListNode values case should include normalized call args, received ${JSON.stringify(tracedListNodeValues.events)}`
    );
    assertCondition(
      tracedListNodeValues.events?.some((event) =>
        event.kind === 'read'
        && event.target?.variable === 'curr'
        && event.target.path?.[0] === 'val'
        && event.value === 7) === true,
      `Browser worker traced ListNode values case should include curr.val read, received ${JSON.stringify(tracedListNodeValues.events)}`
    );
    console.log('PASS: browser worker normalized C# ListNode trace values and field reads');

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
      `Browser worker traced ListNode field writes case should succeed: ${tracedListNodeFieldWrites.error ?? 'unknown error'}`
    );
    assertCondition(
      tracedListNodeFieldWrites.events?.some((event) =>
        event.kind === 'read'
        && event.target?.variable === 'curr'
        && event.target.path?.[0] === 'next'
        && (event.value as { __type__?: string; val?: number } | undefined)?.__type__ === 'ListNode'
        && (event.value as { val?: number } | undefined)?.val === 2) === true,
      `Browser worker traced ListNode field writes case should include curr.next read, received ${JSON.stringify(tracedListNodeFieldWrites.events)}`
    );
    assertCondition(
      tracedListNodeFieldWrites.events?.some((event) =>
        event.kind === 'write'
        && event.target?.variable === 'curr'
        && event.target.path?.[0] === 'next') === true,
      `Browser worker traced ListNode field writes case should include curr.next write, received ${JSON.stringify(tracedListNodeFieldWrites.events)}`
    );
    console.log('PASS: browser worker emitted C# ListNode next read/write trace events');

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
      `Browser worker traced TreeNode values case should succeed: ${tracedTreeNodeValues.error ?? 'unknown error'}`
    );
    assertCondition(
      tracedTreeNodeValues.events?.some((event) =>
        event.kind === 'call'
        && event.function === 'SumTree'
        && Array.isArray(event.args)
        && (event.args[0] as { __type__?: string; val?: number } | undefined)?.__type__ === 'TreeNode'
        && (event.args[0] as { val?: number } | undefined)?.val === 1) === true,
      `Browser worker traced TreeNode values case should include normalized recursive call args, received ${JSON.stringify(tracedTreeNodeValues.events)}`
    );
    assertCondition(
      tracedTreeNodeValues.events?.some((event) =>
        event.kind === 'return'
        && event.function === 'SumTree'
        && event.value === 6) === true,
      `Browser worker traced TreeNode values case should include final return value, received ${JSON.stringify(tracedTreeNodeValues.events)}`
    );
    assertCondition(
      tracedTreeNodeValues.events?.some((event) =>
        event.kind === 'read'
        && event.target?.variable === 'root'
        && event.target.path?.[0] === 'left'
        && (event.value as { __type__?: string; val?: number } | undefined)?.__type__ === 'TreeNode'
        && (event.value as { val?: number } | undefined)?.val === 2) === true,
      `Browser worker traced TreeNode values case should include root.left read, received ${JSON.stringify(tracedTreeNodeValues.events)}`
    );
    assertCondition(
      tracedTreeNodeValues.events?.some((event) =>
        event.kind === 'read'
        && event.target?.variable === 'root'
        && event.target.path?.[0] === 'val'
        && event.value === 1) === true,
      `Browser worker traced TreeNode values case should include root.val read, received ${JSON.stringify(tracedTreeNodeValues.events)}`
    );
    console.log('PASS: browser worker normalized C# TreeNode trace values and field reads');

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
      `Browser worker traced nested TreeNode field case should succeed: ${tracedNestedTreeNodeFields.error ?? 'unknown error'}`
    );
    assertCondition(
      tracedNestedTreeNodeFields.events?.some((event) =>
        event.kind === 'read'
        && event.target?.variable === 'root'
        && event.target.path?.[0] === 'left'
        && event.target.path?.[1] === 'val'
        && event.value === 9) === true,
      `Browser worker traced nested TreeNode field case should include root.left.val read, received ${JSON.stringify(tracedNestedTreeNodeFields.events)}`
    );
    console.log('PASS: browser worker emitted nested C# TreeNode field paths');

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
      `Browser worker traced nested TreeNode field write case should succeed: ${tracedNestedTreeNodeFieldWrites.error ?? 'unknown error'}`
    );
    assertCondition(
      tracedNestedTreeNodeFieldWrites.output === 11,
      `Browser worker traced nested TreeNode field write case should return 11, received ${JSON.stringify(tracedNestedTreeNodeFieldWrites.output)}`
    );
    assertCondition(
      tracedNestedTreeNodeFieldWrites.events?.some((event) =>
        event.kind === 'write'
        && event.target?.variable === 'root'
        && event.target.path?.[0] === 'left'
        && event.target.path?.[1] === 'val'
        && event.value === 11) === true,
      `Browser worker traced nested TreeNode field write case should include root.left.val write, received ${JSON.stringify(tracedNestedTreeNodeFieldWrites.events)}`
    );
    console.log('PASS: browser worker emitted nested C# TreeNode field write paths');

    const renamedParams = await runWorkerCase(
      page,
      'public class Solution { public int Add(int left, int right) { return left + right; } }',
      'Add',
      { a: 2, b: 3 },
      assetBaseUrl
    );
    assertCondition(
      renamedParams.success,
      `Browser worker renamed-parameter Add should succeed: ${renamedParams.error ?? 'unknown error'}`
    );
    assertCondition(renamedParams.output === 5, 'Browser worker generated driver should map renamed parameters by input order');
    console.log('PASS: browser worker generated driver maps renamed parameters by input order');

    const compileError = await runWorkerCase(page, fixture('compile-error.cs'), 'Add', { a: 2, b: 3 }, assetBaseUrl);
    assertCondition(!compileError.success, 'Browser worker compile-error fixture should fail');
    assertCondition(
      compileError.diagnostics?.some((diagnostic) => diagnostic.file.endsWith('UserCode.cs') && diagnostic.line === 5) === true,
      `Browser worker diagnostics should map to UserCode.cs line 5, received ${JSON.stringify(compileError.diagnostics)}`
    );
    console.log(`PASS: browser worker returned mapped compile diagnostic "${compileError.error}"`);

    const voidReturn = await runWorkerCase(page, fixture('void-return.cs'), 'Add', { a: 2, b: 3 }, assetBaseUrl);
    assertCondition(voidReturn.success, `Browser worker void-return fixture should succeed: ${voidReturn.error ?? 'unknown error'}`);
    assertCondition(
      voidReturn.output === null,
      `Browser worker void-return fixture should return null output, received ${JSON.stringify(voidReturn.output)}`
    );
    console.log('PASS: browser worker generated driver supports void Solution methods');
  } finally {
    await browser?.close();
    await server.close();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
