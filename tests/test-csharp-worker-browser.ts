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
  events?: Array<{ kind: string; line?: number; function?: string; method?: string; value?: unknown; args?: unknown[]; target?: { variable: string; path?: unknown[] } }>;
  traceLimitExceeded?: boolean;
  timeoutReason?: string;
}

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const FIXTURE_ROOT = join(ROOT, 'spikes', 'csharp-wasm-roslyn', 'fixtures');

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
  options: { timeoutMs?: number; maxTraceSteps?: number; executionStyle?: 'solution-method' | 'ops-class' } = {}
): Promise<CSharpWorkerResponse> {
  return page.evaluate(
    async ({ code, functionName, inputs, assetBaseUrl, trace, options }) => {
      const worker = new Worker('/workers/csharp/csharp-worker.js', { type: 'module' });
      let nextId = 0;

      function send(type, payload) {
        const id = String(++nextId);
        return new Promise((resolve, reject) => {
          const timeoutId = setTimeout(() => {
            worker.terminate();
            reject(new Error(`C# worker request timed out: ${type}`));
          }, 30_000);

          worker.addEventListener('message', function onMessage(event) {
            if (event.data?.id !== id) return;
            worker.removeEventListener('message', onMessage);
            clearTimeout(timeoutId);
            if (event.data.type === 'error') {
              reject(new Error(event.data.payload?.error ?? 'C# worker error'));
              return;
            }
            resolve(event.data.payload);
          });
          worker.postMessage({ id, type, payload });
        });
      }

      await send('init', { assetBaseUrl });
      const result = await send(trace ? 'execute-with-tracing' : 'execute-code', {
        code,
        functionName,
        inputs,
        executionStyle: options.executionStyle ?? 'solution-method',
        assetBaseUrl,
        ...options,
      });
      worker.terminate();
      return result;
    },
    { code, functionName, inputs, assetBaseUrl, trace, options }
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

    const traceLimited = await runWorkerCase(
      page,
      'public class Solution { public int Add(int a, int b) { int sum = a + b; return sum; } }',
      'Add',
      { a: 2, b: 3 },
      assetBaseUrl,
      true,
      { maxTraceSteps: 2 }
    );
    assertCondition(!traceLimited.success, 'C# worker trace-limited Add should fail');
    assertCondition(traceLimited.traceLimitExceeded === true, 'C# worker trace-limited Add should set traceLimitExceeded');
    assertCondition(traceLimited.timeoutReason === 'trace-limit', 'C# worker trace-limited Add should use trace-limit');

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
      compileError.diagnostics?.some((diagnostic) => diagnostic.file.endsWith('UserCode.cs') && diagnostic.line === 5) === true,
      `C# worker diagnostics should map to UserCode.cs line 5, received ${JSON.stringify(compileError.diagnostics)}`
    );
    assertCondition(
      compileError.diagnostics?.some((diagnostic) =>
        diagnostic.file.endsWith('UserCode.cs')
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
