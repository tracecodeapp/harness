import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import vm from 'node:vm';
import type {
  Language,
  RuntimeClient,
  RuntimeExecuteCase,
  RuntimeExecuteCodeRequest,
  RuntimeExecuteProjectRequest,
  RuntimeExecuteRequest,
  RuntimeExecuteResponse,
  RuntimeExecuteResult,
  RuntimeExecutionStyle,
  TraceExecutionOptions,
} from '../../harness-core/src/runtime-types';
import type { RuntimeCommandResult } from '../../harness-core/src/runtime-project';
import type { CodeExecutionBatchResult, CodeExecutionResult, ExecutionResult } from '../../harness-core/src/types';
import {
  createEmptyRuntimeTrace,
  type RuntimeTrace,
} from '../../harness-core/src/runtime-trace';
import { javaTraceHooksEventsToRuntimeTrace } from '../../harness-core/src/trace-adapters/java';
import {
  PYTHON_CLASS_DEFINITIONS,
  PYTHON_CONVERSION_HELPERS,
  PYTHON_EXECUTE_SERIALIZE_FUNCTION,
  PYTHON_TRACE_SERIALIZE_FUNCTION,
  toPythonLiteral,
} from '../../harness-python/src/python-harness';
import {
  createNativeProjectWorkspace,
  type CreateNativeProjectWorkspaceOptions,
} from '../../../src/project-node';
import {
  getLanguageRuntimeInfo,
  getSupportedLanguageRuntimeInfos,
} from '../../harness-core/src/runtime-language-info';
import {
  getLanguageRuntimeProfile,
  getSupportedLanguageProfiles,
  isLanguageSupported,
  SUPPORTED_LANGUAGES,
} from '../../harness-browser/src/runtime-profiles';

export { createNativeProjectWorkspace, type CreateNativeProjectWorkspaceOptions };
export {
  getLanguageRuntimeInfo,
  getSupportedLanguageRuntimeInfos,
  getLanguageRuntimeProfile,
  getSupportedLanguageProfiles,
  isLanguageSupported,
  SUPPORTED_LANGUAGES,
};

type NativeCodeLanguage = Language;
type NativeWorkerMessage = {
  id?: string;
  type: string;
  payload?: unknown;
  protocolToken?: string;
};

interface NativePythonRuntimeCore {
  generateTracingCode: (
    deps: {
      PYTHON_CLASS_DEFINITIONS_SNIPPET: string;
      PYTHON_CONVERSION_HELPERS_SNIPPET: string;
      PYTHON_TRACE_SERIALIZE_FUNCTION_SNIPPET: string;
      PYTHON_EXECUTE_SERIALIZE_FUNCTION_SNIPPET: string;
      toPythonLiteral: (value: unknown) => string;
    },
    code: string,
    functionName: string,
    inputs: Record<string, unknown>,
    executionStyle?: string,
    options?: Record<string, unknown>
  ) => { code: string };
  executeCode: (
    deps: {
      PYTHON_CLASS_DEFINITIONS_SNIPPET: string;
      PYTHON_CONVERSION_HELPERS_SNIPPET: string;
      PYTHON_EXECUTE_SERIALIZE_FUNCTION_SNIPPET: string;
      PYTHON_TRACE_SERIALIZE_FUNCTION_SNIPPET: string;
      PYTHON_DEFAULT_IMPORT_PRELUDE?: string;
      INTERVIEW_GUARD_DEFAULTS: Record<string, number>;
      loadPyodideInstance: () => Promise<void>;
      getPyodide: () => { runPythonAsync: (code: string) => Promise<string> };
      toPythonLiteral: (value: unknown) => string;
    },
    code: string,
    functionName: string,
    inputs: Record<string, unknown>,
    executionStyle?: string,
    options?: Record<string, unknown>
  ) => Promise<CodeExecutionResult>;
}

export interface NativeHarnessOptions {
  jobs?: number;
  pythonCommand?: string;
  nodeCommand?: string;
  javacCommand?: string;
  javaCommand?: string;
  dotnetCommand?: string;
  cppCompilerCommand?: string;
  pythonTimeoutMs?: number;
  javaTimeoutMs?: number;
  csharpTimeoutMs?: number;
  cppTimeoutMs?: number;
  csharpTargetFramework?: string;
  javascriptWorkerSourcePath?: string;
  javaWorkerSourcePath?: string;
  cppWorkerSourcePath?: string;
  pythonRuntimeCorePath?: string;
  keepNativeTempDirs?: boolean;
}

export interface NativeHarnessQueueOptions {
  workers?: number;
}

export interface NativeHarnessJob {
  id?: string;
  language: Language;
  request: RuntimeExecuteCodeRequest;
}

export interface NativeHarnessJobResult {
  id?: string;
  language: Language;
  success: boolean;
  result?: RuntimeExecuteResult;
  error?: string;
  durationMs: number;
}

export type NativeHarnessJobResultHandler = (
  result: NativeHarnessJobResult,
  index: number
) => void | Promise<void>;

export interface NativeHarnessQueue {
  enqueue(job: NativeHarnessJob): Promise<NativeHarnessJobResult>;
  run(jobs: Iterable<NativeHarnessJob> | AsyncIterable<NativeHarnessJob>): Promise<NativeHarnessJobResult[]>;
  runEach(jobs: Iterable<NativeHarnessJob> | AsyncIterable<NativeHarnessJob>, onResult: NativeHarnessJobResultHandler): Promise<void>;
  drain(): Promise<void>;
  dispose(): void;
}

export interface NativeLanguageSupport {
  language: Language;
  code: {
    supported: boolean;
    batching: boolean;
    tracing: boolean;
  };
  project: {
    supported: boolean;
  };
  notes: string[];
}

export interface NativeHarness {
  getClient(language: NativeCodeLanguage): RuntimeClient;
  getClient(language: Language): RuntimeClient;
  createQueue(options?: NativeHarnessQueueOptions): NativeHarnessQueue;
  runJobs(jobs: Iterable<NativeHarnessJob> | AsyncIterable<NativeHarnessJob>, options?: NativeHarnessQueueOptions): Promise<NativeHarnessJobResult[]>;
  runJobsEach(
    jobs: Iterable<NativeHarnessJob> | AsyncIterable<NativeHarnessJob>,
    onResult: NativeHarnessJobResultHandler,
    options?: NativeHarnessQueueOptions
  ): Promise<void>;
  getNativeLanguageSupport(language: Language): NativeLanguageSupport;
  getNativeLanguageSupport(): NativeLanguageSupport[];
  isNativeCodeLanguageSupported(language: Language): boolean;
  getProfile(language: Language): ReturnType<typeof getLanguageRuntimeProfile>;
  getSupportedLanguageProfiles(): ReturnType<typeof getSupportedLanguageProfiles>;
  getLanguageInfo(language: Language): ReturnType<typeof getLanguageRuntimeInfo>;
  getSupportedLanguageInfos(): ReturnType<typeof getSupportedLanguageRuntimeInfos>;
  isLanguageSupported(language: Language): boolean;
  warmLanguage(language: Language): Promise<void>;
  disposeLanguage(language: Language): void;
  dispose(): void;
}

interface NativeRuntimeClientHandlers {
  defaultExecutionStyle: RuntimeExecutionStyle;
  executeCode(
    code: string,
    functionName: string,
    inputs: Record<string, unknown>,
    executionStyle?: RuntimeExecutionStyle
  ): Promise<CodeExecutionResult>;
  executeWithTracing(
    code: string,
    functionName: string | null,
    inputs: Record<string, unknown>,
    options?: TraceExecutionOptions,
    executionStyle?: RuntimeExecutionStyle
  ): Promise<ExecutionResult>;
  executeCodeInterviewMode(
    code: string,
    functionName: string,
    inputs: Record<string, unknown>,
    executionStyle?: RuntimeExecutionStyle
  ): Promise<CodeExecutionResult>;
  executeBatch?(request: RuntimeExecuteCodeRequest): Promise<RuntimeExecuteResult>;
}

const NATIVE_CODE_LANGUAGES = new Set<Language>(['python', 'javascript', 'typescript', 'java', 'csharp', 'cpp']);
const NATIVE_TRACE_LANGUAGES = new Set<Language>(['python', 'javascript', 'typescript', 'cpp']);

function isNativeCodeLanguage(language: Language): language is NativeCodeLanguage {
  return NATIVE_CODE_LANGUAGES.has(language);
}

function getNativeLanguageSupport(language: Language): NativeLanguageSupport {
  const codeSupported = isNativeCodeLanguage(language);
  return {
    language,
    code: {
      supported: codeSupported,
      batching: codeSupported,
      tracing: NATIVE_TRACE_LANGUAGES.has(language),
    },
    project: {
      supported: true,
    },
    notes: codeSupported
      ? [
          'Native code execution uses trusted host-side runners and is not a sandbox.',
          ...(language === 'csharp'
            ? ['C# native execution and batching use dotnet; native tracing currently returns a minimal trace until host-side instrumentation is added.']
            : []),
          ...(language === 'java'
            ? ['Java native execution and batching use javac/java; host-side Java trace rewriting is not wired into native code clients yet.']
            : []),
        ]
      : ['Native project execution is available through createNativeProjectWorkspace.'],
  };
}

function runtimeDeepEqual(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function codeResultToExecuteCase(
  testCase: RuntimeExecuteCase,
  result: CodeExecutionResult
): RuntimeExecuteResult['cases'][number] {
  const hasExpected = Object.prototype.hasOwnProperty.call(testCase, 'expected');
  return {
    id: testCase.id,
    success: result.success,
    output: result.output,
    expected: testCase.expected,
    passed: hasExpected ? result.success && runtimeDeepEqual(result.output, testCase.expected) : undefined,
    error: result.error,
    errorLine: result.errorLine,
    consoleOutput: result.consoleOutput,
    timeoutReason: result.timeoutReason,
    diagnosticStage: result.diagnosticStage,
    diagnostic: result.diagnostic,
    timings: result.timings,
  };
}

function traceResultToExecuteCase(
  testCase: RuntimeExecuteCase,
  result: ExecutionResult
): RuntimeExecuteResult['cases'][number] {
  const hasExpected = Object.prototype.hasOwnProperty.call(testCase, 'expected');
  return {
    id: testCase.id,
    success: result.success,
    output: result.output,
    expected: testCase.expected,
    passed: hasExpected ? result.success && runtimeDeepEqual(result.output, testCase.expected) : undefined,
    error: result.error,
    errorLine: result.errorLine,
    consoleOutput: result.consoleOutput,
    trace: result.trace,
    traceLimitExceeded: result.traceLimitExceeded,
    timeoutReason: result.timeoutReason,
    diagnostic: result.diagnostic,
    timings: result.timings,
  };
}

function batchCodeResultToExecuteResult(
  request: RuntimeExecuteCodeRequest,
  result: CodeExecutionBatchResult
): RuntimeExecuteResult {
  const cases = request.cases.map((testCase, index) =>
    codeResultToExecuteCase(
      testCase,
      result.results[index] ?? {
        success: false,
        output: null,
        error: result.error ?? 'Batch execution did not return a result for this case',
        consoleOutput: result.consoleOutput,
      }
    )
  );
  return {
    success: result.success && cases.every((testCase) => testCase.success),
    cases,
    timings: result.timings,
  };
}

async function executeNativeRuntimeRequest(
  request: RuntimeExecuteRequest,
  handlers: NativeRuntimeClientHandlers
): Promise<RuntimeExecuteResponse> {
  if (request.kind === 'project') {
    throw new Error('Native harness code clients do not execute project requests. Use createNativeProjectWorkspace for shell/project mode.');
  }

  if (request.trace && request.interview) {
    throw new Error('Runtime execute request cannot enable both trace and interview modes.');
  }
  if (!Array.isArray(request.cases) || request.cases.length === 0) {
    throw new Error('Runtime execute request requires at least one case.');
  }
  if (!request.trace && !request.interview && handlers.executeBatch && request.cases.length > 1) {
    return handlers.executeBatch(request);
  }

  const functionName = request.functionName ?? '';
  const executionStyle = request.executionStyle ?? handlers.defaultExecutionStyle;
  const cases = [];
  for (const testCase of request.cases) {
    if (request.trace) {
      cases.push(traceResultToExecuteCase(
        testCase,
        await handlers.executeWithTracing(
          request.code,
          request.functionName ?? null,
          testCase.inputs,
          request.traceOptions,
          executionStyle
        )
      ));
    } else if (request.interview) {
      cases.push(codeResultToExecuteCase(
        testCase,
        await handlers.executeCodeInterviewMode(request.code, functionName, testCase.inputs, executionStyle)
      ));
    } else {
      cases.push(codeResultToExecuteCase(
        testCase,
        await handlers.executeCode(request.code, functionName, testCase.inputs, executionStyle)
      ));
    }
  }

  return {
    success: cases.every((testCase) => testCase.success),
    cases,
  };
}

function packageRootCandidates(): string[] {
  const resolver = createRequire(join(process.cwd(), 'tracecode-native-resolver.cjs'));
  const candidates = new Set<string>([process.cwd()]);
  for (const packageName of ['@tracecode/harness-native', '@tracecode/harness']) {
    try {
      candidates.add(dirname(resolver.resolve(`${packageName}/package.json`)));
    } catch {
      // The package may be running from source or through the other published package.
    }
  }
  return [...candidates];
}

function firstExistingPath(paths: readonly string[]): string {
  const found = paths.find((path) => existsSync(path));
  if (!found) {
    throw new Error(`Unable to locate native harness asset. Tried:\n${paths.join('\n')}`);
  }
  return found;
}

function resolveNativeAsset(explicitPath: string | undefined, candidates: (root: string) => string[]): string {
  if (explicitPath) return explicitPath;
  return firstExistingPath(packageRootCandidates().flatMap(candidates));
}

async function runProcess(
  command: string,
  args: string[],
  options: { input?: string; timeoutMs?: number; timeoutLabel?: string; cwd?: string } = {}
): Promise<{ exitCode: number | null; stdout: string; stderr: string; timedOut: boolean }> {
  return await new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: options.cwd, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const timeoutId = options.timeoutMs
      ? setTimeout(() => {
          timedOut = true;
          child.kill('SIGTERM');
          setTimeout(() => {
            if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
          }, 2_000).unref();
        }, options.timeoutMs)
      : null;
    timeoutId?.unref();
    child.stdout.on('data', (chunk) => { stdout += String(chunk); });
    child.stderr.on('data', (chunk) => { stderr += String(chunk); });
    child.stdin.on('error', () => {});
    child.on('error', (error) => {
      if (timeoutId) clearTimeout(timeoutId);
      reject(error);
    });
    child.on('close', (exitCode) => {
      if (timeoutId) clearTimeout(timeoutId);
      resolve({ exitCode, stdout, stderr, timedOut });
    });
    child.stdin.end(options.input ?? '');
  });
}

function parseLastJsonLine<T>(stdout: string): T {
  const line = stdout
    .trim()
    .split(/\r?\n/)
    .reverse()
    .find((candidate) => candidate.trim().startsWith('{') || candidate.trim().startsWith('['));
  if (!line) throw new Error(`Native runtime did not emit a JSON result.\n${stdout}`);
  return JSON.parse(line) as T;
}

async function runPythonScript(pythonCommand: string, script: string, timeoutMs?: number): Promise<string> {
  const tempDir = await mkdtemp(join(tmpdir(), 'tracecode-native-python-'));
  const scriptPath = join(tempDir, 'run.py');
  await writeFile(scriptPath, script, 'utf8');
  try {
    const result = await runProcess(pythonCommand, [scriptPath], { timeoutMs, timeoutLabel: pythonCommand });
    if (result.exitCode !== 0 || result.timedOut) {
      const timeout = result.timedOut ? `${pythonCommand}: execution timed out after ${timeoutMs}ms\n` : '';
      throw new Error(`${pythonCommand} exited with ${result.exitCode ?? 'signal'}\n${timeout}${result.stderr || result.stdout}`);
    }
    return result.stdout;
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

async function loadTypeScriptCompiler(): Promise<unknown | undefined> {
  try {
    return await import('typescript');
  } catch {
    // Fall back to the package-managed browser compiler asset below.
  }

  try {
    const compilerPath = resolveNativeAsset(undefined, (root) => [
      join(root, 'workers', 'vendor', 'typescript.js'),
      join(root, '..', 'workers', 'vendor', 'typescript.js'),
    ]);
    const source = await readFile(compilerPath, 'utf8');
    const moduleObject = { exports: {} as unknown };
    const context = vm.createContext({
      module: moduleObject,
      exports: moduleObject.exports,
      ts: {},
    });
    vm.runInContext(source, context, { filename: 'typescript.js' });
    return moduleObject.exports && Object.keys(moduleObject.exports as Record<string, unknown>).length > 0
      ? moduleObject.exports
      : (context as { ts?: unknown }).ts;
  } catch {
    return undefined;
  }
}

class NativePythonRuntimeClient implements RuntimeClient {
  private runtimePromise: Promise<NativePythonRuntimeCore> | null = null;

  constructor(
    private readonly options: {
      pythonCommand: string;
      timeoutMs?: number;
      runtimeCorePath?: string;
    }
  ) {}

  async init(): Promise<{ success: boolean; loadTimeMs: number }> {
    const startedAt = Date.now();
    await this.loadRuntime();
    return { success: true, loadTimeMs: Date.now() - startedAt };
  }

  async execute(request: RuntimeExecuteCodeRequest): Promise<RuntimeExecuteResult>;
  async execute(request: RuntimeExecuteProjectRequest): Promise<RuntimeCommandResult>;
  async execute(request: RuntimeExecuteRequest): Promise<RuntimeExecuteResponse> {
    return executeNativeRuntimeRequest(request, {
      defaultExecutionStyle: 'function',
      executeCode: this.executeCode.bind(this),
      executeWithTracing: this.executeWithTracing.bind(this),
      executeCodeInterviewMode: this.executeCodeInterviewMode.bind(this),
      executeBatch: this.executeBatch.bind(this),
    });
  }

  async executeCode(
    code: string,
    functionName: string,
    inputs: Record<string, unknown>,
    executionStyle: RuntimeExecutionStyle = 'function'
  ): Promise<CodeExecutionResult> {
    const runtime = await this.loadRuntime();
    try {
      return await runtime.executeCode(
        {
          PYTHON_CLASS_DEFINITIONS_SNIPPET: PYTHON_CLASS_DEFINITIONS,
          PYTHON_CONVERSION_HELPERS_SNIPPET: PYTHON_CONVERSION_HELPERS,
          PYTHON_TRACE_SERIALIZE_FUNCTION_SNIPPET: PYTHON_TRACE_SERIALIZE_FUNCTION,
          PYTHON_EXECUTE_SERIALIZE_FUNCTION_SNIPPET: PYTHON_EXECUTE_SERIALIZE_FUNCTION,
          INTERVIEW_GUARD_DEFAULTS: {
            maxLineEvents: 20_000,
            maxSingleLineHits: 10_000,
            maxCallDepth: 1_000,
            maxMemoryBytes: 256 * 1024 * 1024,
            memoryCheckEvery: 100,
          },
          loadPyodideInstance: async () => {},
          getPyodide: () => ({
            runPythonAsync: async (script: string) => {
              const runnable = script
                .replace('import string\n', 'import string\nfrom typing import *\nfrom math import *\nfrom copy import *\nfrom re import *\n')
                .replace(
                  /\njson\.dumps\(\{\n    "output": _serialize\(_result\),\n    "console": _console_output,\n\}\)\n?$/,
                  '\n_tracecode_result_json = json.dumps({\n    "output": _serialize(_result),\n    "console": _console_output,\n})\nprint(_tracecode_result_json)\n'
                );
              return (await runPythonScript(this.options.pythonCommand, runnable, this.options.timeoutMs)).trim();
            },
          }),
          toPythonLiteral,
        },
        code,
        functionName,
        inputs,
        executionStyle
      );
    } catch (error) {
      return {
        success: false,
        output: null,
        error: error instanceof Error ? error.message : String(error),
        consoleOutput: [],
      };
    }
  }

  async executeCodeInterviewMode(
    code: string,
    functionName: string,
    inputs: Record<string, unknown>,
    executionStyle: RuntimeExecutionStyle = 'function'
  ): Promise<CodeExecutionResult> {
    return this.executeCode(code, functionName, inputs, executionStyle);
  }

  async executeBatch(request: RuntimeExecuteCodeRequest): Promise<RuntimeExecuteResult> {
    const startedAt = Date.now();
    try {
      const stdout = await runPythonScript(
        this.options.pythonCommand,
        this.batchScript(
          request.code,
          request.functionName ?? '',
          request.cases.map((testCase) => testCase.inputs && typeof testCase.inputs === 'object' ? testCase.inputs : {}),
          request.executionStyle ?? 'function'
        ),
        this.options.timeoutMs
      );
      const parsed = parseLastJsonLine<CodeExecutionBatchResult>(stdout);
      return batchCodeResultToExecuteResult(request, {
        ...parsed,
        timings: {
          ...(parsed.timings ?? {}),
          totalMs: Date.now() - startedAt,
        },
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return batchCodeResultToExecuteResult(request, {
        success: false,
        results: request.cases.map(() => ({
          success: false,
          output: null,
          error: message,
          consoleOutput: [],
        })),
        error: message,
        consoleOutput: [],
        timings: { totalMs: Date.now() - startedAt },
      });
    }
  }

  private batchScript(
    code: string,
    functionName: string,
    inputBatch: Record<string, unknown>[],
    executionStyle: RuntimeExecutionStyle
  ): string {
    return `
import builtins as _builtins
import copy as _copy
import inspect as _inspect
import json
import math
import sys
from typing import *
from collections import *
from functools import *
from itertools import *
from heapq import *
from bisect import *

${PYTHON_CLASS_DEFINITIONS}
${PYTHON_CONVERSION_HELPERS}
${PYTHON_EXECUTE_SERIALIZE_FUNCTION}

_USER_CODE = ${JSON.stringify(code)}
_FUNCTION_NAME = ${JSON.stringify(functionName)}
_EXECUTION_STYLE = ${JSON.stringify(executionStyle)}
_INPUT_BATCH = json.loads(${JSON.stringify(JSON.stringify(inputBatch))})

def _tracecode_materialize_custom_input(obj):
    if isinstance(obj, list):
        return [_tracecode_materialize_custom_input(item) for item in obj]
    if isinstance(obj, tuple):
        return tuple(_tracecode_materialize_custom_input(item) for item in obj)
    if isinstance(obj, dict):
        if obj.get('__type__') == 'TreeNode' or 'left' in obj or 'right' in obj:
            return _dict_to_tree(obj)
        if obj.get('__type__') == 'ListNode' or 'next' in obj:
            return _dict_to_list(obj)
        return {key: _tracecode_materialize_custom_input(value) for key, value in obj.items() if key not in ('__id__',)}
    return obj

def _tracecode_entry_callable(env, function_name, execution_style):
    if execution_style == 'solution-method' and 'Solution' in env and hasattr(env['Solution'], function_name):
        return getattr(env['Solution'](), function_name)
    if function_name in env and callable(env[function_name]):
        return env[function_name]
    if 'Solution' in env and hasattr(env['Solution'], function_name):
        return getattr(env['Solution'](), function_name)
    raise NameError(f"Implement {function_name}(...) or Solution.{function_name}(...)")

def _tracecode_call_function(env, inputs):
    callable_obj = _tracecode_entry_callable(env, _FUNCTION_NAME, _EXECUTION_STYLE)
    values = {name: env[name] for name in inputs.keys() if name in env}
    try:
        signature = _inspect.signature(callable_obj)
        args = []
        kwargs = {}
        has_varargs = any(parameter.kind is _inspect.Parameter.VAR_POSITIONAL for parameter in signature.parameters.values())
        for parameter in signature.parameters.values():
            if parameter.name in ('self', 'cls'):
                continue
            if parameter.kind is _inspect.Parameter.VAR_POSITIONAL:
                if parameter.name in values:
                    raw = values[parameter.name]
                    args.extend(raw if isinstance(raw, (list, tuple)) else [raw])
                continue
            if parameter.kind is _inspect.Parameter.VAR_KEYWORD:
                if parameter.name in values and isinstance(values[parameter.name], dict):
                    kwargs.update(values[parameter.name])
                continue
            if parameter.name not in values:
                continue
            if parameter.kind is _inspect.Parameter.POSITIONAL_ONLY:
                args.append(values[parameter.name])
            elif parameter.kind is _inspect.Parameter.POSITIONAL_OR_KEYWORD and has_varargs:
                args.append(values[parameter.name])
            else:
                kwargs[parameter.name] = values[parameter.name]
        return callable_obj(*args, **kwargs)
    except (TypeError, ValueError):
        return callable_obj(**values)

def _tracecode_call_ops_class(env):
    ops = env.get('operations', env.get('ops'))
    args = env.get('arguments', env.get('args'))
    if ops is None or args is None:
        raise ValueError('ops-class execution requires inputs.operations and inputs.arguments (or ops/args)')
    cls = env[_FUNCTION_NAME]
    instance = None
    out = []
    for index, op in enumerate(ops):
        call_args = args[index] if index < len(args) else []
        if call_args is None:
            call_args = []
        if not isinstance(call_args, (list, tuple)):
            call_args = [call_args]
        if index == 0:
            instance = cls(*call_args)
            out.append(None)
        else:
            out.append(getattr(instance, op)(*call_args))
    return out

def _tracecode_run_case(raw_inputs):
    console_output = []
    def _custom_print(*args, **kwargs):
        console_output.append(' '.join(str(arg) for arg in args))
    env = {
        '__builtins__': _builtins.__dict__,
        'json': json,
        'math': math,
        'sys': sys,
        'List': List,
        'Dict': Dict,
        'Set': Set,
        'Tuple': Tuple,
        'Optional': Optional,
        'defaultdict': defaultdict,
        'deque': deque,
        'Counter': Counter,
        'print': _custom_print,
        'TreeNode': TreeNode,
        'ListNode': ListNode,
        '_dict_to_tree': _dict_to_tree,
        '_dict_to_list': _dict_to_list,
    }
    try:
        exec(_USER_CODE, env)
        inputs = {key: _tracecode_materialize_custom_input(_copy.deepcopy(value)) for key, value in raw_inputs.items()}
        for key, value in inputs.items():
            env[key] = value
        if _EXECUTION_STYLE == 'ops-class':
            result = _tracecode_call_ops_class(env)
        else:
            result = _tracecode_call_function(env, inputs)
            if result is None:
                for name in ('nums1', 'nums', 'arr', 'array', 'matrix', 'board', 'grid'):
                    if name in env:
                        result = env[name]
                        break
        return {'success': True, 'output': _serialize(result), 'consoleOutput': console_output}
    except Exception as error:
        return {'success': False, 'output': None, 'error': str(error), 'consoleOutput': console_output}

_started = None
_results = [_tracecode_run_case(case if isinstance(case, dict) else {}) for case in _INPUT_BATCH]
print(json.dumps({
    'success': all(result.get('success') is True for result in _results),
    'results': _results,
    'consoleOutput': [line for result in _results for line in result.get('consoleOutput', [])],
}))
`;
  }

  async executeWithTracing(
    code: string,
    functionName: string | null,
    inputs: Record<string, unknown>,
    options: TraceExecutionOptions = {},
    executionStyle: RuntimeExecutionStyle = 'function'
  ): Promise<ExecutionResult> {
    const startedAt = Date.now();
    const runtime = await this.loadRuntime();
    const traceFunctionName = functionName ?? '';
    try {
      const tracingPayload = runtime.generateTracingCode(
        {
          PYTHON_CLASS_DEFINITIONS_SNIPPET: PYTHON_CLASS_DEFINITIONS,
          PYTHON_CONVERSION_HELPERS_SNIPPET: PYTHON_CONVERSION_HELPERS,
          PYTHON_TRACE_SERIALIZE_FUNCTION_SNIPPET: PYTHON_TRACE_SERIALIZE_FUNCTION,
          PYTHON_EXECUTE_SERIALIZE_FUNCTION_SNIPPET: PYTHON_EXECUTE_SERIALIZE_FUNCTION,
          toPythonLiteral,
        },
        code,
        traceFunctionName,
        inputs,
        executionStyle,
        options as Record<string, unknown>
      );
      const stdout = await runPythonScript(
        this.options.pythonCommand,
        `${tracingPayload.code}
print(json.dumps({
    'runtimeTrace': {
        'schemaVersion': 'runtime-trace-2026-04-28',
        'language': 'python',
        'runId': 'python:run',
        'events': _trace_events,
        'lineEventCount': len([event for event in _trace_events if event.get('kind') == 'line']),
        'traceStepCount': len(_trace_events)
    },
    'result': _serialize_output(_result),
    'consoleOutput': _console_output,
    'lineEventCount': _total_line_events,
    'traceStepCount': len(_trace_events),
    'traceLimitExceeded': bool(globals().get('_trace_limit_exceeded', False)),
    'timeoutReason': globals().get('_timeout_reason', None)
}))
`,
        this.options.timeoutMs
      );
      const parsed = parseLastJsonLine<{
        runtimeTrace: RuntimeTrace;
        result: unknown;
        consoleOutput?: string[];
        lineEventCount?: number;
        traceStepCount?: number;
        traceLimitExceeded?: boolean;
        timeoutReason?: ExecutionResult['timeoutReason'] | null;
      }>(stdout);
      const trace = parsed.runtimeTrace ?? createEmptyRuntimeTrace('python');
      return {
        success: !parsed.traceLimitExceeded || parsed.timeoutReason === 'trace-limit',
        output: parsed.result,
        trace,
        executionTimeMs: Date.now() - startedAt,
        consoleOutput: parsed.consoleOutput ?? [],
        traceLimitExceeded: parsed.traceLimitExceeded,
        timeoutReason: parsed.timeoutReason ?? undefined,
        lineEventCount: parsed.lineEventCount,
        traceStepCount: parsed.traceStepCount,
      };
    } catch (error) {
      return {
        success: false,
        output: null,
        error: error instanceof Error ? error.message : String(error),
        trace: createEmptyRuntimeTrace('python'),
        executionTimeMs: Date.now() - startedAt,
        consoleOutput: [],
      };
    }
  }

  private async loadRuntime(): Promise<NativePythonRuntimeCore> {
    if (this.runtimePromise) return this.runtimePromise;
    this.runtimePromise = (async () => {
      const runtimeCorePath = resolveNativeAsset(this.options.runtimeCorePath, (root) => [
        join(root, 'workers', 'python', 'runtime-core.js'),
        join(root, 'workers', 'pyodide', 'runtime-core.js'),
        join(root, '..', 'workers', 'python', 'runtime-core.js'),
      ]);
      const source = await readFile(runtimeCorePath, 'utf8');
      const selfObject: Record<string, unknown> = {};
      const context = vm.createContext({ console, self: selfObject, globalThis: {} });
      vm.runInContext(source, context, { filename: 'runtime-core.js' });
      const runtime = selfObject.__TRACECODE_PYODIDE_RUNTIME__;
      if (!runtime || typeof runtime !== 'object') {
        throw new Error('Unable to load native Python runtime core.');
      }
      return runtime as NativePythonRuntimeCore;
    })();
    return this.runtimePromise;
  }
}

class NativeJavaScriptWorkerHarness {
  private pending = new Map<
    string,
    { protocolToken: string; resolve: (value: unknown) => void; reject: (error: Error) => void; timeoutId: ReturnType<typeof setTimeout> }
  >();
  private onmessage: ((event: { data: NativeWorkerMessage }) => void) | null = null;
  private nextId = 0;
  private ready = false;

  constructor(private readonly workerSourcePath?: string) {}

  async init(): Promise<void> {
    if (this.onmessage) return;
    const workerPath = resolveNativeAsset(this.workerSourcePath, (root) => [
      join(root, 'workers', 'javascript', 'javascript-worker.js'),
      join(root, 'workers', 'javascript-worker.js'),
      join(root, '..', 'workers', 'javascript', 'javascript-worker.js'),
    ]);
    const workerSource = await readFile(workerPath, 'utf8');
    const selfObject: {
      location: { search: string };
      postMessage: (message: NativeWorkerMessage) => void;
      onmessage: ((event: { data: NativeWorkerMessage }) => void) | null;
      ts?: unknown;
    } = {
      location: { search: '' },
      postMessage: (message) => {
        if (message.type === 'worker-ready') {
          this.ready = true;
          return;
        }
        const id = message.id;
        if (!id) return;
        const entry = this.pending.get(id);
        if (!entry || message.protocolToken !== entry.protocolToken) return;
        this.pending.delete(id);
        clearTimeout(entry.timeoutId);
        if (message.type === 'error') {
          const payload = message.payload as { error?: unknown } | undefined;
          entry.reject(new Error(String(payload?.error ?? 'Worker error')));
          return;
        }
        entry.resolve(message.payload);
      },
      onmessage: null,
      ts: await loadTypeScriptCompiler(),
    };
    const context = vm.createContext({
      console,
      self: selfObject,
      performance: { now: () => Date.now() },
      setTimeout,
      clearTimeout,
    });
    vm.runInContext(workerSource, context, { filename: 'javascript-worker.js' });
    if (typeof selfObject.onmessage !== 'function') {
      throw new Error('JavaScript worker did not register onmessage.');
    }
    if (!this.ready) {
      throw new Error('JavaScript worker did not emit worker-ready.');
    }
    this.onmessage = selfObject.onmessage;
    await this.sendMessage('init');
  }

  async sendMessage<T>(type: string, payload?: unknown, timeoutMs = 60_000): Promise<T> {
    await this.init();
    if (!this.onmessage) throw new Error('Native JavaScript worker is not initialized.');
    const id = String(++this.nextId);
    const protocolToken = `tracecode-native-js-${id}`;
    const responsePromise = new Promise<T>((resolve, reject) => {
      const timeoutId = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Timed out waiting for native JavaScript response: ${type}`));
      }, timeoutMs);
      this.pending.set(id, { protocolToken, resolve: resolve as (value: unknown) => void, reject, timeoutId });
    });
    this.onmessage({ data: { id, type, payload, protocolToken } });
    return responsePromise;
  }

  dispose(): void {
    for (const [id, entry] of this.pending) {
      clearTimeout(entry.timeoutId);
      entry.reject(new Error('Native JavaScript worker disposed.'));
      this.pending.delete(id);
    }
    this.onmessage = null;
    this.ready = false;
  }
}

class NativeJavaScriptRuntimeClient implements RuntimeClient {
  private readonly worker: NativeJavaScriptWorkerHarness;

  constructor(
    private readonly language: Extract<Language, 'javascript' | 'typescript'>,
    options: Pick<NativeHarnessOptions, 'javascriptWorkerSourcePath'>
  ) {
    this.worker = new NativeJavaScriptWorkerHarness(options.javascriptWorkerSourcePath);
  }

  async init(): Promise<{ success: boolean; loadTimeMs: number }> {
    const startedAt = Date.now();
    await this.worker.init();
    return { success: true, loadTimeMs: Date.now() - startedAt };
  }

  async execute(request: RuntimeExecuteCodeRequest): Promise<RuntimeExecuteResult>;
  async execute(request: RuntimeExecuteProjectRequest): Promise<RuntimeCommandResult>;
  async execute(request: RuntimeExecuteRequest): Promise<RuntimeExecuteResponse> {
    return executeNativeRuntimeRequest(request, {
      defaultExecutionStyle: 'function',
      executeCode: this.executeCode.bind(this),
      executeWithTracing: this.executeWithTracing.bind(this),
      executeCodeInterviewMode: this.executeCodeInterviewMode.bind(this),
      executeBatch: async (codeRequest) => {
        const result = await this.worker.sendMessage<CodeExecutionBatchResult>('execute-code-batch', {
          code: codeRequest.code,
          functionName: codeRequest.functionName ?? '',
          inputBatch: codeRequest.cases.map((testCase) => testCase.inputs),
          executionStyle: codeRequest.executionStyle ?? 'function',
          language: this.language,
        });
        return batchCodeResultToExecuteResult(codeRequest, result);
      },
    });
  }

  async executeCode(
    code: string,
    functionName: string,
    inputs: Record<string, unknown>,
    executionStyle: RuntimeExecutionStyle = 'function'
  ): Promise<CodeExecutionResult> {
    return this.worker.sendMessage<CodeExecutionResult>('execute-code', {
      code,
      functionName,
      inputs,
      executionStyle,
      language: this.language,
    });
  }

  async executeCodeInterviewMode(
    code: string,
    functionName: string,
    inputs: Record<string, unknown>,
    executionStyle: RuntimeExecutionStyle = 'function'
  ): Promise<CodeExecutionResult> {
    return this.worker.sendMessage<CodeExecutionResult>('execute-code-interview', {
      code,
      functionName,
      inputs,
      executionStyle,
      language: this.language,
    });
  }

  async executeWithTracing(
    code: string,
    functionName: string | null,
    inputs: Record<string, unknown>,
    options: TraceExecutionOptions = {},
    executionStyle: RuntimeExecutionStyle = 'function'
  ): Promise<ExecutionResult> {
    return this.worker.sendMessage<ExecutionResult>('execute-with-tracing', {
      code,
      functionName,
      inputs,
      executionStyle,
      language: this.language,
      options,
    });
  }

  dispose(): void {
    this.worker.dispose();
  }
}

interface NativeJavaWorkerApi {
  normalizeJavaExecutionPayload(payload: Record<string, unknown>): Record<string, unknown>;
  buildJavaCompileId(payload: Record<string, unknown>, compileMode?: string): string;
  buildJavaBatchCompileId(payload: Record<string, unknown>, inputBatch: Record<string, unknown>[]): string;
  buildPlainRunnableSource(payload: Record<string, unknown>, compileId: string, dynamicInputs: unknown[]): string;
  buildBatchRunnableSource(
    payload: Record<string, unknown>,
    compileId: string,
    inputBatch: Record<string, unknown>[],
    dynamicInputBatch: unknown[][]
  ): { source: string; entryClasses: string[] };
  buildExportsClassName(compileId: string): string;
  buildPackageName(compileId: string): string;
  parseJavaReportOutput(output?: string): unknown;
  javaReportConsoleOutput(report: Record<string, unknown>): string[];
  javaReportFailureMessage(report: Record<string, unknown>, fallback: string): string;
}

interface NativeCppWorkerApi {
  buildNativeBatchDriverSource(source: string, functionName: string, inputBatch: Record<string, unknown>[], options?: Record<string, unknown>): string;
  buildNativeOpsClassBatchDriverSource(source: string, functionName: string, inputBatch: Record<string, unknown>[], options?: Record<string, unknown>): string;
  buildDriverSource(source: string, functionName: string, inputs: Record<string, unknown>, options?: Record<string, unknown>): string;
  buildScriptDriverSource(source: string, options?: Record<string, unknown>): string;
  buildOpsClassDriverSource(source: string, functionName: string, inputs: Record<string, unknown>, options?: Record<string, unknown>): string;
  parseMethodSignature(source: string, functionName: string, options?: Record<string, unknown>): { line?: number };
  parseProgramStdout(stdout: string, options?: Record<string, unknown>): {
    output: unknown;
    consoleOutput: string[];
    events: Record<string, unknown>[];
    traceStatus?: { traceLimitExceeded?: boolean; droppedEventCount?: number; timeoutReason?: string };
  };
  finalizeRuntimeTrace(events: Record<string, unknown>[], options?: Record<string, unknown>): {
    trace: RuntimeTrace;
    traceLimitExceeded?: boolean;
    droppedEventCount?: number;
  };
}

let nativeJavaApiPromise: Promise<NativeJavaWorkerApi> | null = null;
let nativeCppApiPromise: Promise<NativeCppWorkerApi> | null = null;

async function loadNativeJavaWorkerApi(workerSourcePath?: string): Promise<NativeJavaWorkerApi> {
  if (nativeJavaApiPromise) return nativeJavaApiPromise;
  nativeJavaApiPromise = (async () => {
    const workerPath = resolveNativeAsset(workerSourcePath, (root) => [
      join(root, 'workers', 'java', 'java-worker.js'),
      join(root, 'workers', 'java-worker.js'),
      join(root, '..', 'workers', 'java', 'java-worker.js'),
    ]);
    const rawSource = await readFile(workerPath, 'utf8');
    const source = rawSource.replace(/^import\s+\{[\s\S]*?\}\s+from\s+['"][^'"]+['"];\s*/, '');
    const selfObject: Record<string, unknown> = {
      location: { search: '' },
      postMessage: () => {},
      addEventListener: () => {},
      TraceCodeJavaSourceAugmentations: {},
    };
    const context = vm.createContext({
      console,
      self: selfObject,
      globalThis: selfObject,
      postMessage: () => {},
      queueMicrotask,
      performance: { now: () => Date.now() },
      crypto: { getRandomValues: (array: Uint32Array) => array.fill(Date.now() >>> 0) },
      TextEncoder,
      TextDecoder,
    });
    vm.runInContext(`${source}
self.__TRACECODE_NATIVE_JAVA__ = {
  normalizeJavaExecutionPayload,
  buildJavaCompileId,
  buildJavaBatchCompileId,
  buildPlainRunnableSource,
  buildBatchRunnableSource,
  buildExportsClassName,
  buildPackageName,
  parseJavaReportOutput,
  javaReportConsoleOutput,
  javaReportFailureMessage,
};`, context, { filename: 'java-worker.js' });
    const api = selfObject.__TRACECODE_NATIVE_JAVA__;
    if (!api || typeof api !== 'object') {
      throw new Error('Unable to load native Java worker helpers.');
    }
    return api as NativeJavaWorkerApi;
  })();
  return nativeJavaApiPromise;
}

async function loadNativeCppWorkerApi(workerSourcePath?: string): Promise<NativeCppWorkerApi> {
  if (nativeCppApiPromise) return nativeCppApiPromise;
  nativeCppApiPromise = (async () => {
    const workerPath = resolveNativeAsset(workerSourcePath, (root) => [
      join(root, 'workers', 'cpp', 'cpp-worker.js'),
      join(root, 'workers', 'cpp-worker.js'),
      join(root, '..', 'workers', 'cpp', 'cpp-worker.js'),
    ]);
    const rawSource = await readFile(workerPath, 'utf8');
    const source = rawSource.replace(/^import\s+\{[\s\S]*?\}\s+from\s+['"][^'"]+['"];\s*/, '');
    const selfObject: Record<string, unknown> = {
      location: { search: '' },
      postMessage: () => {},
      addEventListener: () => {},
    };
    const context = vm.createContext({
      console,
      self: selfObject,
      globalThis: selfObject,
      postMessage: () => {},
      queueMicrotask,
      performance: { now: () => Date.now() },
      TextEncoder,
      TextDecoder,
      isRuntimeDeviceDirectory: () => false,
      isRuntimeDeviceNamespacePath: () => false,
      isRuntimeProcPath: () => false,
      normalizeRuntimeKernelDeviceReference: (value: unknown) => value,
      runtimeKernelVirtualMutationTarget: () => null,
      runtimeKernelVirtualPathTarget: () => null,
      fetch: async () => {
        throw new Error('Native C++ helper loading does not fetch browser assets.');
      },
    });
    vm.runInContext(`${source}
function buildNativeBatchDriverSource(userCode, functionName, inputBatch, options = {}) {
  userCode = normalizeCppUserSource(userCode, options);
  const tracecodeNamespace = 'tracecode' + '::';
  const firstInputs = Array.isArray(inputBatch) && inputBatch.length > 0 && inputBatch[0] && typeof inputBatch[0] === 'object'
    ? inputBatch[0]
    : {};
  const aliases = collectCppTypeAliases(userCode);
  const signature = parseMethodSignature(userCode, functionName, {
    parameterCount: Object.keys(firstInputs || {}).length,
    inputNames: Object.keys(firstInputs || {}),
  });
  const typeContext = sourceDeclaresSolutionClass(userCode)
    ? buildCppDriverTypeContext(userCode, 'Solution', signature, aliases)
    : buildCppDriverTypeContext(userCode, functionName, signature, aliases);
  const driverSignature = qualifyCppSignatureForDriver(signature, typeContext, aliases);
  const usesSolutionClass = options.executionStyle !== 'function' || sourceDeclaresSolutionClass(userCode);
  const declarations = [];
  const argumentNames = [];
  driverSignature.parameters.forEach((parameter, index) => {
    const localName = \`__tc_arg_\${index}\`;
    const type = materializedCppType(parameter.type, aliases);
    declarations.push(\`    \${type} \${localName} = \${tracecodeNamespace}read_json_input<\${type}>(__tc_case, \${cppStringLiteral(parameter.name)}, \${index});\`);
    argumentNames.push(localName);
  });
  const returnsNull = isNullCppReturnType(driverSignature.returnType, aliases);
  const returnsVoid = normalizeCppType(localCppType(driverSignature.returnType), aliases) === 'void';
  const noStoredResult = returnsVoid || returnsNull;
  const voidOutputParameter = returnsVoid && driverSignature.parameters.length > 0 && isSnapshotSerializableCppType(driverSignature.parameters[0].type, aliases)
    ? driverSignature.parameters[0]
    : null;
  const resultJsonExpression = noStoredResult
    ? returnsNull
      ? '"null"'
      : voidOutputParameter
      ? cppJsonExpressionForValue('__tc_arg_0', voidOutputParameter.type, userCode)
      : '"null"'
    : cppJsonExpressionForValue('__tc_result', driverSignature.returnType, userCode);
  const callExpression = \`\${usesSolutionClass ? \`solution.\${functionName}\` : functionName}(\${argumentNames.join(', ')})\`;
  const invokeAndStore = noStoredResult ? \`    \${callExpression};\` : \`    auto __tc_result = \${callExpression};\`;

return \`\${buildGeneratedIncludes(userCode, driverSignature)}
using namespace std;
\${buildTracecodeFallbackAliases(userCode)}

#line 1 "\${CPP_USER_SOURCE_FILE}"
\${userCode}
\${buildCppJsonObjectAdapters(typeContext, aliases)}

#line 1 "TraceCodeDriver.cpp"
int main() {
  \${tracecodeNamespace}JsonValue __tc_cases = \${tracecodeNamespace}parse_json(\${tracecodeNamespace}read_stdin_all());
  std::string __tc_results = "[";
  if (__tc_cases.kind != \${tracecodeNamespace}JsonValue::Kind::Array) {
    std::fputs("C++ batch input must be a JSON array.\\\\n", stderr);
    return 1;
  }
  for (std::size_t __tc_case_index = 0; __tc_case_index < __tc_cases.array_values.size(); ++__tc_case_index) {
    const \${tracecodeNamespace}JsonValue& __tc_case = __tc_cases.array_values[__tc_case_index];
    if (__tc_case_index > 0) __tc_results += ",";
\${usesSolutionClass ? '    Solution solution;\\n' : ''}\${declarations.join('\\n')}
\${invokeAndStore}
    __tc_results += \${resultJsonExpression};
  }
  __tc_results += "]";
  \${tracecodeNamespace}write_result_json_raw(__tc_results);
  return 0;
}
\`;
}
function buildNativeOpsClassBatchDriverSource(userCode, className, inputBatch, options = {}) {
  userCode = normalizeCppUserSource(userCode, options);
  const tracecodeNamespace = 'tracecode' + '::';
  const firstInputs = Array.isArray(inputBatch) && inputBatch.length > 0 && inputBatch[0] && typeof inputBatch[0] === 'object'
    ? inputBatch[0]
    : {};
  const aliases = collectCppTypeAliases(userCode);
  const { operations, argumentsList } = getOpsClassInputs(firstInputs || {});
  let firstOperationIndex = 1;
  let constructorArgumentIndex = 0;
  if (operations[0] === '__init__') {
    firstOperationIndex = 1;
    constructorArgumentIndex = 0;
  } else if (operations[0] === className) {
    firstOperationIndex = 1;
    constructorArgumentIndex = 0;
  } else if (operations.length > 0) {
    firstOperationIndex = 0;
    constructorArgumentIndex = -1;
  } else {
    throw new Error(\`C++ ops-class inputs must start with constructor operation "\${className}".\`);
  }

  const lines = [];
  const constructorArgs = constructorArgumentIndex >= 0 ? normalizeOpsArguments(argumentsList[constructorArgumentIndex]) : [];
  const constructorSignature = parseConstructorSignature(userCode, className, aliases, {
    parameterCount: constructorArgs.length,
  });
  if (constructorArgs.length !== constructorSignature.parameters.length) {
    throw new Error(\`C++ ops-class constructor "\${className}" expected \${constructorSignature.parameters.length} args, received \${constructorArgs.length}.\`);
  }
  const constructorArgNames = constructorArgs.map((_value, index) => {
    const localName = \`__tc_ctor_arg_\${index}\`;
    const type = localCppType(constructorSignature.parameters[index].type);
    lines.push(\`    \${type} \${localName} = \${tracecodeNamespace}json_to<\${type}>(__tc_ops_arg_at(__tc_ops_item_at(*__tc_arguments, \${constructorArgumentIndex}), \${index}));\`);
    return localName;
  });
  lines.push(constructorArgs.length === 0
    ? \`    \${className} __tc_instance;\`
    : \`    \${className} __tc_instance(\${constructorArgNames.join(', ')});\`);
  lines.push('    std::vector<std::string> __tc_case_outputs;');
  if (constructorArgumentIndex >= 0) {
    lines.push('    __tc_case_outputs.push_back("null");');
  }

  for (let index = firstOperationIndex; index < operations.length; index += 1) {
    const operation = operations[index];
    if (typeof operation !== 'string' || !operation.trim()) {
      throw new Error(\`C++ ops-class operation at index \${index} must be a method name.\`);
    }
    const signatureOperation = resolveCppObjectMethodMacro(userCode, operation);
    const signature = parseMethodSignature(userCode, signatureOperation);
    const args = normalizeOpsArguments(argumentsList[index]);
    if (args.length !== signature.parameters.length) {
      throw new Error(\`C++ ops-class method "\${operation}" expected \${signature.parameters.length} args, received \${args.length}.\`);
    }
    const argNames = [];
    signature.parameters.forEach((parameter, argIndex) => {
      const localName = \`__tc_op_\${index}_arg_\${argIndex}\`;
      const type = localCppType(parameter.type);
      lines.push(\`    \${type} \${localName} = \${tracecodeNamespace}json_to<\${type}>(__tc_ops_arg_at(__tc_ops_item_at(*__tc_arguments, \${index}), \${argIndex}));\`);
      argNames.push(localName);
    });
    if (normalizeCppType(signature.returnType, aliases) === 'void' || isNullCppReturnType(signature.returnType, aliases)) {
      lines.push(\`    __tc_instance.\${signatureOperation}(\${argNames.join(', ')});\`);
      lines.push('    __tc_case_outputs.push_back("null");');
    } else {
      lines.push(\`    auto __tc_op_\${index}_result = __tc_instance.\${signatureOperation}(\${argNames.join(', ')});\`);
      lines.push(\`    __tc_case_outputs.push_back(\${tracecodeNamespace}to_json(__tc_op_\${index}_result));\`);
    }
  }
  const operationChecks = operations.map((operation, index) => \`    if (__tc_operations && __tc_operations->kind == \${tracecodeNamespace}JsonValue::Kind::Array && __tc_operations->array_values.size() > \${index} && __tc_operations->array_values[\${index}].kind == \${tracecodeNamespace}JsonValue::Kind::String && __tc_operations->array_values[\${index}].string_value != \${cppStringLiteral(String(operation))}) {
      std::fputs("C++ ops-class case operation name differs from the first case.\\\\n", stderr);
      return 1;
    }\`);

return \`\${buildGeneratedIncludes(userCode, { parameters: [] })}
using namespace std;
\${buildTracecodeFallbackAliases(userCode)}

#line 1 "\${CPP_USER_SOURCE_FILE}"
\${userCode}

#line 1 "TraceCodeDriver.cpp"
int main() {
  \${tracecodeNamespace}JsonValue __tc_cases = \${tracecodeNamespace}parse_json(\${tracecodeNamespace}read_stdin_all());
  if (__tc_cases.kind != \${tracecodeNamespace}JsonValue::Kind::Array) {
    std::fputs("C++ ops-class batch input must be a JSON array.\\\\n", stderr);
    return 1;
  }
  const \${tracecodeNamespace}JsonValue __tc_null_value;
  auto __tc_ops_item_at = [&__tc_null_value](const \${tracecodeNamespace}JsonValue& values, std::size_t index) -> const \${tracecodeNamespace}JsonValue& {
    if (values.kind == \${tracecodeNamespace}JsonValue::Kind::Array && index < values.array_values.size()) return values.array_values[index];
    return __tc_null_value;
  };
  auto __tc_ops_arg_at = [&__tc_ops_item_at](const \${tracecodeNamespace}JsonValue& values, std::size_t index) -> const \${tracecodeNamespace}JsonValue& {
    if (values.kind == \${tracecodeNamespace}JsonValue::Kind::Array) return __tc_ops_item_at(values, index);
    return values;
  };
  std::string __tc_results = "[";
  for (std::size_t __tc_case_index = 0; __tc_case_index < __tc_cases.array_values.size(); ++__tc_case_index) {
    const \${tracecodeNamespace}JsonValue& __tc_case = __tc_cases.array_values[__tc_case_index];
    const \${tracecodeNamespace}JsonValue* __tc_operations = \${tracecodeNamespace}object_get(__tc_case, "operations");
    if (!__tc_operations) __tc_operations = \${tracecodeNamespace}object_get(__tc_case, "ops");
    const \${tracecodeNamespace}JsonValue* __tc_arguments = \${tracecodeNamespace}object_get(__tc_case, "arguments");
    if (!__tc_arguments) __tc_arguments = \${tracecodeNamespace}object_get(__tc_case, "args");
    if (!__tc_arguments || __tc_arguments->kind != \${tracecodeNamespace}JsonValue::Kind::Array) {
      std::fputs("C++ ops-class case must include arguments or args array.\\\\n", stderr);
      return 1;
    }
    if (__tc_operations && __tc_operations->kind == \${tracecodeNamespace}JsonValue::Kind::Array && __tc_operations->array_values.size() != \${operations.length}) {
      std::fputs("C++ ops-class case operations length differs from the first case.\\\\n", stderr);
      return 1;
    }
\${operationChecks.join('\\n')}
    if (__tc_case_index > 0) __tc_results += ",";
\${lines.join('\\n')}
    std::string __tc_case_json = "[";
    for (std::size_t __tc_i = 0; __tc_i < __tc_case_outputs.size(); ++__tc_i) {
      if (__tc_i > 0) __tc_case_json += ",";
      __tc_case_json += __tc_case_outputs[__tc_i];
    }
    __tc_case_json += "]";
    __tc_results += __tc_case_json;
  }
  __tc_results += "]";
  \${tracecodeNamespace}write_result_json_raw(__tc_results);
  return 0;
}
\`;
}
self.__TRACECODE_NATIVE_CPP__ = {
  buildNativeBatchDriverSource,
  buildNativeOpsClassBatchDriverSource,
  buildDriverSource,
  buildScriptDriverSource,
  buildOpsClassDriverSource,
  parseMethodSignature,
  parseProgramStdout,
  finalizeRuntimeTrace,
};`, context, { filename: 'cpp-worker.js' });
    const api = selfObject.__TRACECODE_NATIVE_CPP__;
    if (!api || typeof api !== 'object') {
      throw new Error('Unable to load native C++ worker helpers.');
    }
    return api as NativeCppWorkerApi;
  })();
  return nativeCppApiPromise;
}

function stableNativeHash(value: unknown): string {
  const source = JSON.stringify(value);
  let hash = 0x811c9dc5;
  for (let index = 0; index < source.length; index += 1) {
    hash ^= source.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(36);
}

function javaAssetPath(fileName: string): string {
  return resolveNativeAsset(undefined, (root) => [
    join(root, 'workers', 'vendor', fileName),
    join(root, 'workers', 'java', fileName),
    join(root, '..', 'workers', 'vendor', fileName),
  ]);
}

function cppRuntimeHeaderPath(): string {
  return resolveNativeAsset(undefined, (root) => [
    join(root, 'workers', 'cpp', 'tracecode_runtime.hpp'),
    join(root, 'workers', 'tracecode_runtime.hpp'),
    join(root, '..', 'workers', 'cpp', 'tracecode_runtime.hpp'),
  ]);
}

async function removeTempDir(path: string, keep?: boolean): Promise<void> {
  if (!keep) await rm(path, { recursive: true, force: true });
}

function javaNativeHostSource(): string {
  return `
import tracecode.browser.BrowserCompileAndTraceLibrary;

public final class TraceCodeNativeJavaHost {
  public static void main(String[] args) throws Exception {
    if (args.length < 6) {
      throw new IllegalArgumentException("Usage: <mode> <sourcePath> <classesDir> <entryOrEntries> <classpath> <compilerProfile> [maxStoredEvents]");
    }
    String mode = args[0];
    String sourcePath = args[1];
    String classesDir = args[2];
    String entry = args[3];
    String classpath = args[4];
    String compilerProfile = args[5];
    String report;
    if ("batch".equals(mode)) {
      report = BrowserCompileAndTraceLibrary.compileAndRunBatch(sourcePath, classesDir, entry, classpath, compilerProfile);
    } else if ("trace".equals(mode)) {
      int maxStoredEvents = args.length >= 7 ? Integer.parseInt(args[6]) : 50000;
      report = BrowserCompileAndTraceLibrary.compileAndTrace(sourcePath, classesDir, entry, classpath, compilerProfile, maxStoredEvents);
    } else {
      report = BrowserCompileAndTraceLibrary.compileAndRun(sourcePath, classesDir, entry, classpath, compilerProfile);
    }
    System.out.println(report);
  }
}
`;
}

class NativeJavaRuntimeClient implements RuntimeClient {
  private hostPromise: Promise<{ hostDir: string; helperJar: string }> | null = null;

  constructor(
    private readonly options: {
      javacCommand: string;
      javaCommand: string;
      timeoutMs: number;
      workerSourcePath?: string;
      keepTempDirs?: boolean;
    }
  ) {}

  async init(): Promise<{ success: boolean; loadTimeMs: number }> {
    const startedAt = Date.now();
    await loadNativeJavaWorkerApi(this.options.workerSourcePath);
    return { success: true, loadTimeMs: Date.now() - startedAt };
  }

  async execute(request: RuntimeExecuteCodeRequest): Promise<RuntimeExecuteResult>;
  async execute(request: RuntimeExecuteProjectRequest): Promise<RuntimeCommandResult>;
  async execute(request: RuntimeExecuteRequest): Promise<RuntimeExecuteResponse> {
    return executeNativeRuntimeRequest(request, {
      defaultExecutionStyle: 'function',
      executeCode: this.executeCode.bind(this),
      executeWithTracing: this.executeWithTracing.bind(this),
      executeCodeInterviewMode: this.executeCodeInterviewMode.bind(this),
      executeBatch: this.executeBatch.bind(this),
    });
  }

  async executeCode(
    code: string,
    functionName: string,
    inputs: Record<string, unknown>,
    executionStyle: RuntimeExecutionStyle = 'function'
  ): Promise<CodeExecutionResult> {
    const request: RuntimeExecuteCodeRequest = {
      kind: 'code',
      code,
      functionName,
      executionStyle,
      cases: [{ inputs }],
    };
    const result = await this.executeBatch(request);
    const first = result.cases[0];
    return first
      ? {
          success: first.success,
          output: first.output ?? null,
          error: first.error,
          errorLine: first.errorLine,
          consoleOutput: first.consoleOutput,
          timeoutReason: first.timeoutReason,
          diagnosticStage: first.diagnosticStage,
          diagnostic: first.diagnostic,
          timings: first.timings,
        }
      : { success: false, output: null, error: 'Java execution did not return a result.', consoleOutput: [] };
  }

  async executeCodeInterviewMode(
    code: string,
    functionName: string,
    inputs: Record<string, unknown>,
    executionStyle: RuntimeExecutionStyle = 'function'
  ): Promise<CodeExecutionResult> {
    return this.executeCode(code, functionName, inputs, executionStyle);
  }

  async executeBatch(request: RuntimeExecuteCodeRequest): Promise<RuntimeExecuteResult> {
    const startedAt = Date.now();
    const api = await loadNativeJavaWorkerApi(this.options.workerSourcePath);
    const inputBatch = request.cases.map((testCase) => testCase.inputs && typeof testCase.inputs === 'object' ? testCase.inputs : {});
    const normalizedPayload = api.normalizeJavaExecutionPayload({
      code: request.code,
      functionName: request.functionName ?? '',
      inputs: inputBatch[0] ?? {},
      executionStyle: request.executionStyle ?? 'function',
    });
    const compileId = stableNativeHash({
      language: 'java',
      code: request.code,
      functionName: request.functionName ?? '',
      executionStyle: request.executionStyle ?? 'function',
      inputBatch,
    });
    const source = api.buildBatchRunnableSource(normalizedPayload, compileId, inputBatch, inputBatch.map(() => [])).source;
    const entryClasses = api.buildBatchRunnableSource(normalizedPayload, compileId, inputBatch, inputBatch.map(() => [])).entryClasses;
    const tempDir = await mkdtemp(join(tmpdir(), 'tracecode-native-java-'));
    try {
      const sourcePath = join(tempDir, `${api.buildExportsClassName(compileId)}.java`);
      const classesDir = join(tempDir, 'classes');
      await mkdir(classesDir, { recursive: true });
      await writeFile(sourcePath, source, 'utf8');
      const { hostDir, helperJar } = await this.ensureHost();
      const classpath = [hostDir, helperJar].join(':');
      const run = await runProcess(
        this.options.javaCommand,
        [
          '-cp',
          classpath,
          'TraceCodeNativeJavaHost',
          'batch',
          sourcePath,
          classesDir,
          entryClasses.join('\n'),
          helperJar,
          'none',
        ],
        { timeoutMs: this.options.timeoutMs }
      );
      if (run.exitCode !== 0 || run.timedOut) {
        throw new Error(run.stderr || run.stdout || 'Native Java execution failed.');
      }
      const report = parseLastJsonLine<Record<string, unknown>>(run.stdout);
      const rawResults = Array.isArray(report.results) ? report.results as Record<string, unknown>[] : [];
      const cases = request.cases.map((testCase, index) => {
        const entry = rawResults[index] ?? {};
        const success = entry.success === true;
        return codeResultToExecuteCase(testCase, {
          success,
          output: success ? api.parseJavaReportOutput(entry.output as string | undefined) : null,
          consoleOutput: api.javaReportConsoleOutput(report),
          ...(success ? {} : { error: api.javaReportFailureMessage({ ...report, ...entry }, 'Java batch item failed without compiler/runtime diagnostics') }),
          timings: {
            compileMs: index === 0 ? Number(report.compileTimeMs ?? 0) : 0,
            classLoadMs: Number(entry.classLoadTimeMs ?? 0),
            runMs: Number(entry.runTimeMs ?? 0),
            totalMs: index === 0 ? Date.now() - startedAt : Number(entry.runTimeMs ?? 0),
            compileCacheHit: Boolean(report.compileCacheHit),
          },
        });
      });
      return {
        success: report.success === true && cases.every((testCase) => testCase.success),
        cases,
        timings: {
          compileMs: Number(report.compileTimeMs ?? 0),
          totalMs: Date.now() - startedAt,
          compileCacheHit: Boolean(report.compileCacheHit),
        },
      };
    } catch (error) {
      return {
        success: false,
        cases: request.cases.map((testCase) => codeResultToExecuteCase(testCase, {
          success: false,
          output: null,
          error: error instanceof Error ? error.message : String(error),
          consoleOutput: [],
        })),
      };
    } finally {
      await removeTempDir(tempDir, this.options.keepTempDirs);
    }
  }

  async executeWithTracing(
    code: string,
    functionName: string | null,
    inputs: Record<string, unknown>,
    options: TraceExecutionOptions = {},
    executionStyle: RuntimeExecutionStyle = 'function'
  ): Promise<ExecutionResult> {
    const startedAt = Date.now();
    const api = await loadNativeJavaWorkerApi(this.options.workerSourcePath);
    const normalizedPayload = api.normalizeJavaExecutionPayload({
      code,
      functionName: functionName ?? '',
      inputs,
      executionStyle,
    });
    const compileId = stableNativeHash({ language: 'java-trace', code, functionName, inputs, executionStyle, options });
    const source = api.buildPlainRunnableSource(normalizedPayload, compileId, []);
    const tempDir = await mkdtemp(join(tmpdir(), 'tracecode-native-java-trace-'));
    try {
      const sourcePath = join(tempDir, `${api.buildExportsClassName(compileId)}.java`);
      const classesDir = join(tempDir, 'classes');
      await mkdir(classesDir, { recursive: true });
      await writeFile(sourcePath, source, 'utf8');
      const { hostDir, helperJar } = await this.ensureHost();
      const classpath = [hostDir, helperJar].join(':');
      const run = await runProcess(
        this.options.javaCommand,
        [
          '-cp',
          classpath,
          'TraceCodeNativeJavaHost',
          'trace',
          sourcePath,
          classesDir,
          `${api.buildPackageName(compileId)}.${api.buildExportsClassName(compileId)}`,
          helperJar,
          'full',
          String(options.maxStoredEvents ?? options.maxTraceSteps ?? 50_000),
        ],
        { timeoutMs: this.options.timeoutMs }
      );
      if (run.exitCode !== 0 || run.timedOut) {
        throw new Error(run.stderr || run.stdout || 'Native Java trace execution failed.');
      }
      const report = parseLastJsonLine<Record<string, unknown>>(run.stdout);
      const rawEvents = Array.isArray(report.events)
        ? (report.events as unknown[]).flatMap((event) => {
            try {
              return [typeof event === 'string' ? JSON.parse(event) : event];
            } catch {
              return [];
            }
          })
        : [];
      const trace = javaTraceHooksEventsToRuntimeTrace(rawEvents, code, {
        runId: 'java:run',
        file: 'solution.java',
        maxPathDepth: options.maxPathDepth,
      });
      const success = report.success === true;
      return {
        success,
        output: success ? api.parseJavaReportOutput(report.output as string | undefined) : null,
        ...(success ? {} : { error: api.javaReportFailureMessage(report, 'Java trace failed without compiler/runtime diagnostics') }),
        trace,
        executionTimeMs: Date.now() - startedAt,
        consoleOutput: api.javaReportConsoleOutput(report),
        traceLimitExceeded: Boolean(report.traceLimitExceeded),
        timeoutReason: report.traceLimitExceeded ? 'trace-limit' : undefined,
        lineEventCount: trace.lineEventCount,
        traceStepCount: trace.traceStepCount,
        timings: {
          compileMs: Number(report.compileTimeMs ?? 0),
          classLoadMs: Number(report.classLoadTimeMs ?? 0),
          runMs: Number(report.runTimeMs ?? 0),
          totalMs: Date.now() - startedAt,
          compileCacheHit: Boolean(report.compileCacheHit),
        },
      };
    } catch (error) {
      return {
        success: false,
        output: null,
        error: error instanceof Error ? error.message : String(error),
        trace: createEmptyRuntimeTrace('java', { runId: 'java:run', file: 'solution.java' }),
        executionTimeMs: Date.now() - startedAt,
        consoleOutput: [],
      };
    } finally {
      await removeTempDir(tempDir, this.options.keepTempDirs);
    }
  }

  private async ensureHost(): Promise<{ hostDir: string; helperJar: string }> {
    if (this.hostPromise) return this.hostPromise;
    this.hostPromise = (async () => {
      const helperJar = javaAssetPath('java-browser-helper.jar');
      const hostRoot = join(tmpdir(), `tracecode-native-java-host-${stableNativeHash({
        helperJar,
        javacCommand: this.options.javacCommand,
        source: javaNativeHostSource(),
      })}`);
      const hostDir = join(hostRoot, 'classes');
      const hostClass = join(hostDir, 'TraceCodeNativeJavaHost.class');
      if (!existsSync(hostClass)) {
        await mkdir(hostDir, { recursive: true });
        const hostSourcePath = join(hostRoot, 'TraceCodeNativeJavaHost.java');
        await writeFile(hostSourcePath, javaNativeHostSource(), 'utf8');
        const hostCompile = await runProcess(this.options.javacCommand, ['-cp', helperJar, '-d', hostDir, hostSourcePath], {
          timeoutMs: this.options.timeoutMs,
        });
        if (hostCompile.exitCode !== 0 || hostCompile.timedOut) {
          throw new Error(hostCompile.stderr || hostCompile.stdout || 'Native Java host compilation failed.');
        }
      }
      return { hostDir, helperJar };
    })();
    return this.hostPromise;
  }
}

class NativeCppRuntimeClient implements RuntimeClient {
  constructor(
    private readonly options: {
      compilerCommand: string;
      timeoutMs: number;
      workerSourcePath?: string;
      keepTempDirs?: boolean;
    }
  ) {}

  async init(): Promise<{ success: boolean; loadTimeMs: number }> {
    const startedAt = Date.now();
    await loadNativeCppWorkerApi(this.options.workerSourcePath);
    return { success: true, loadTimeMs: Date.now() - startedAt };
  }

  async execute(request: RuntimeExecuteCodeRequest): Promise<RuntimeExecuteResult>;
  async execute(request: RuntimeExecuteProjectRequest): Promise<RuntimeCommandResult>;
  async execute(request: RuntimeExecuteRequest): Promise<RuntimeExecuteResponse> {
    return executeNativeRuntimeRequest(request, {
      defaultExecutionStyle: 'solution-method',
      executeCode: this.executeCode.bind(this),
      executeWithTracing: this.executeWithTracing.bind(this),
      executeCodeInterviewMode: this.executeCodeInterviewMode.bind(this),
      executeBatch: this.executeBatch.bind(this),
    });
  }

  async executeCode(
    code: string,
    functionName: string,
    inputs: Record<string, unknown>,
    executionStyle: RuntimeExecutionStyle = 'solution-method'
  ): Promise<CodeExecutionResult> {
    return this.compileAndRun(code, functionName, inputs, { executionStyle, tracing: false }) as Promise<CodeExecutionResult>;
  }

  async executeCodeInterviewMode(
    code: string,
    functionName: string,
    inputs: Record<string, unknown>,
    executionStyle: RuntimeExecutionStyle = 'solution-method'
  ): Promise<CodeExecutionResult> {
    const result = await this.compileAndRun(code, functionName, inputs, {
      executionStyle,
      tracing: true,
      traceOptions: {
        maxTraceSteps: 20_000,
        maxLineEvents: 20_000,
        maxSingleLineHits: 10_000,
      },
    });
    if (!result.success || result.traceLimitExceeded) {
      return {
        success: false,
        output: null,
        error: result.error ?? 'Time Limit Exceeded',
        consoleOutput: result.consoleOutput,
        timeoutReason: result.timeoutReason,
        diagnosticStage: 'interview',
        timings: result.timings,
      };
    }
    return {
      success: true,
      output: result.output,
      consoleOutput: result.consoleOutput,
      timings: result.timings,
    };
  }

  async executeBatch(request: RuntimeExecuteCodeRequest): Promise<RuntimeExecuteResult> {
    const startedAt = Date.now();
    const executionStyle = request.executionStyle ?? 'solution-method';
    if (executionStyle === 'function' && !(request.functionName ?? '').trim()) {
      return this.executeBatchByCase(request, startedAt, executionStyle);
    }
    const api = await loadNativeCppWorkerApi(this.options.workerSourcePath);
    const tempDir = await mkdtemp(join(tmpdir(), 'tracecode-native-cpp-batch-'));
    try {
      const inputBatch = request.cases.map((testCase) => testCase.inputs ?? {});
      const rawDriverSource = executionStyle === 'ops-class'
        ? api.buildNativeOpsClassBatchDriverSource(
            request.code,
            request.functionName ?? '',
            inputBatch,
            { executionStyle, tracing: false }
          )
        : api.buildNativeBatchDriverSource(
            request.code,
            request.functionName ?? '',
            inputBatch,
            { executionStyle, tracing: false }
          );
      const driverSource = rawDriverSource.replace('#include "/tracecode_runtime.hpp"', '#include "tracecode_runtime.hpp"');
      const sourcePath = join(tempDir, 'TraceCodeDriver.cpp');
      const runtimeHeader = await readFile(cppRuntimeHeaderPath(), 'utf8');
      await writeFile(sourcePath, driverSource, 'utf8');
      await writeFile(join(tempDir, 'tracecode_runtime.hpp'), runtimeHeader, 'utf8');
      const programPath = join(tempDir, 'program');
      const compileStartedAt = Date.now();
      const compile = await runProcess(
        this.options.compilerCommand,
        ['-std=c++23', '-O0', sourcePath, '-o', programPath],
        { timeoutMs: this.options.timeoutMs, cwd: tempDir }
      );
      const compileMs = Date.now() - compileStartedAt;
      if (compile.exitCode !== 0 || compile.timedOut) {
        return batchCodeResultToExecuteResult(request, {
          success: false,
          results: request.cases.map(() => ({
            success: false,
            output: null,
            error: compile.stderr || compile.stdout || 'C++ batch compilation failed.',
            consoleOutput: [],
            diagnosticStage: 'driver-compile',
            timings: { compileMs, totalMs: Date.now() - startedAt },
          })),
          consoleOutput: [],
          error: compile.stderr || compile.stdout || 'C++ batch compilation failed.',
          timings: { compileMs, totalMs: Date.now() - startedAt },
        });
      }

      const runStartedAt = Date.now();
      const run = await runProcess(programPath, [], {
        input: JSON.stringify(inputBatch),
        timeoutMs: this.options.timeoutMs,
        cwd: tempDir,
      });
      const runMs = Date.now() - runStartedAt;
      let parsed;
      try {
        const signature = (request.functionName ?? '').trim()
          ? api.parseMethodSignature(request.code, request.functionName ?? '', {
              parameterCount: Object.keys(inputBatch[0] ?? {}).length,
              inputNames: Object.keys(inputBatch[0] ?? {}),
            })
          : { line: 1 };
        parsed = api.parseProgramStdout(run.stdout, {
          tracing: false,
          defaultLine: signature.line ?? 1,
        });
      } catch (error) {
        return batchCodeResultToExecuteResult(request, {
          success: false,
          results: request.cases.map(() => ({
            success: false,
            output: null,
            error: error instanceof Error ? error.message : String(error),
            consoleOutput: run.stderr ? [run.stderr] : [],
            diagnosticStage: 'runtime',
            timings: { compileMs, runMs, totalMs: Date.now() - startedAt },
          })),
          consoleOutput: run.stderr ? [run.stderr] : [],
          error: error instanceof Error ? error.message : String(error),
          timings: { compileMs, runMs, totalMs: Date.now() - startedAt },
        });
      }

      const outputs = Array.isArray(parsed.output) ? parsed.output : [];
      const success = run.exitCode === 0 && !run.timedOut && outputs.length === request.cases.length;
      const runtimeError = run.stderr || (run.timedOut
        ? 'C++ batch execution timed out.'
        : outputs.length !== request.cases.length
          ? `C++ batch returned ${outputs.length} result(s) for ${request.cases.length} case(s).`
          : `C++ program exited with code ${run.exitCode ?? 'signal'}`);
      return batchCodeResultToExecuteResult(request, {
        success,
        results: request.cases.map((_, index) => ({
          success,
          output: outputs[index] ?? null,
          ...(success ? {} : { error: runtimeError }),
          consoleOutput: [...parsed.consoleOutput, ...run.stderr.split(/\r?\n/).filter(Boolean)],
          ...(run.timedOut ? { timeoutReason: 'client-timeout' as const } : {}),
          timings: { compileMs, runMs, totalMs: Date.now() - startedAt },
        })),
        consoleOutput: [...parsed.consoleOutput, ...run.stderr.split(/\r?\n/).filter(Boolean)],
        ...(success ? {} : { error: runtimeError }),
        timings: { compileMs, runMs, totalMs: Date.now() - startedAt },
      });
    } catch (error) {
      return batchCodeResultToExecuteResult(request, {
        success: false,
        results: request.cases.map(() => ({
          success: false,
          output: null,
          error: error instanceof Error ? error.message : String(error),
          consoleOutput: [],
        })),
        error: error instanceof Error ? error.message : String(error),
        consoleOutput: [],
        timings: { totalMs: Date.now() - startedAt },
      });
    } finally {
      await removeTempDir(tempDir, this.options.keepTempDirs);
    }
  }

  private async executeBatchByCase(
    request: RuntimeExecuteCodeRequest,
    startedAt: number,
    executionStyle: RuntimeExecutionStyle
  ): Promise<RuntimeExecuteResult> {
    const results: CodeExecutionResult[] = [];
    for (const testCase of request.cases) {
      results.push(await this.executeCode(request.code, request.functionName ?? '', testCase.inputs, executionStyle));
    }
    return batchCodeResultToExecuteResult(request, {
      success: results.every((result) => result.success),
      results,
      consoleOutput: results.flatMap((result) => result.consoleOutput ?? []),
      timings: { totalMs: Date.now() - startedAt },
    });
  }

  async executeWithTracing(
    code: string,
    functionName: string | null,
    inputs: Record<string, unknown>,
    options: TraceExecutionOptions = {},
    executionStyle: RuntimeExecutionStyle = 'solution-method'
  ): Promise<ExecutionResult> {
    const result = await this.compileAndRun(code, functionName ?? '', inputs, {
      executionStyle,
      tracing: true,
      traceOptions: options,
    });
    return {
      ...result,
      trace: result.trace ?? createEmptyRuntimeTrace('cpp', { runId: 'cpp:run', file: 'solution.cpp' }),
      executionTimeMs: result.executionTimeMs ?? 0,
      consoleOutput: result.consoleOutput ?? [],
      lineEventCount: result.trace?.lineEventCount ?? 0,
      traceStepCount: result.trace?.traceStepCount ?? 0,
    };
  }

  private async compileAndRun(
    code: string,
    functionName: string,
    inputs: Record<string, unknown>,
    options: { executionStyle: RuntimeExecutionStyle; tracing: boolean; traceOptions?: TraceExecutionOptions }
  ): Promise<ExecutionResult & CodeExecutionResult> {
    const startedAt = Date.now();
    const api = await loadNativeCppWorkerApi(this.options.workerSourcePath);
    const tempDir = await mkdtemp(join(tmpdir(), 'tracecode-native-cpp-'));
    try {
      const rawDriverSource = options.executionStyle === 'ops-class'
        ? api.buildOpsClassDriverSource(code, functionName, inputs, options as unknown as Record<string, unknown>)
        : !functionName.trim() && options.executionStyle === 'function'
          ? api.buildScriptDriverSource(code, options as unknown as Record<string, unknown>)
          : api.buildDriverSource(code, functionName, inputs, options as unknown as Record<string, unknown>);
      const driverSource = rawDriverSource.replace('#include "/tracecode_runtime.hpp"', '#include "tracecode_runtime.hpp"');
      const sourcePath = join(tempDir, 'TraceCodeDriver.cpp');
      const runtimeHeader = await readFile(cppRuntimeHeaderPath(), 'utf8');
      await writeFile(sourcePath, driverSource, 'utf8');
      await writeFile(join(tempDir, 'tracecode_runtime.hpp'), runtimeHeader, 'utf8');
      const programPath = join(tempDir, 'program');
      const compileStartedAt = Date.now();
      const compile = await runProcess(
        this.options.compilerCommand,
        ['-std=c++23', '-O0', sourcePath, '-o', programPath],
        { timeoutMs: this.options.timeoutMs, cwd: tempDir }
      );
      const compileMs = Date.now() - compileStartedAt;
      if (compile.exitCode !== 0 || compile.timedOut) {
        return {
          success: false,
          output: null,
          error: compile.stderr || compile.stdout || 'C++ compilation failed.',
          consoleOutput: [],
          trace: createEmptyRuntimeTrace('cpp', { runId: 'cpp:run', file: 'solution.cpp' }),
          executionTimeMs: Date.now() - startedAt,
          timings: { compileMs, totalMs: Date.now() - startedAt },
          diagnosticStage: options.tracing ? 'trace-driver-compile' : 'driver-compile',
        };
      }
      const runStartedAt = Date.now();
      const run = await runProcess(programPath, [], {
        input: JSON.stringify(inputs ?? {}),
        timeoutMs: this.options.timeoutMs,
        cwd: tempDir,
      });
      const runMs = Date.now() - runStartedAt;
      let parsed;
      try {
        const signature = functionName.trim()
          ? api.parseMethodSignature(code, functionName, {
              parameterCount: Object.keys(inputs ?? {}).length,
              inputNames: Object.keys(inputs ?? {}),
            })
          : { line: 1 };
        parsed = api.parseProgramStdout(run.stdout, {
          tracing: options.tracing,
          defaultLine: signature.line ?? 1,
          allowMissingResult: options.tracing,
        });
      } catch (error) {
        return {
          success: false,
          output: null,
          error: error instanceof Error ? error.message : String(error),
          consoleOutput: run.stderr ? [run.stderr] : [],
          trace: createEmptyRuntimeTrace('cpp', { runId: 'cpp:run', file: 'solution.cpp' }),
          executionTimeMs: Date.now() - startedAt,
          timings: { compileMs, runMs, totalMs: Date.now() - startedAt },
          diagnosticStage: 'runtime',
        };
      }
      const success = run.exitCode === 0 && !run.timedOut;
      const base = {
        success,
        output: parsed.output,
        ...(success ? {} : { error: run.stderr || `C++ program exited with code ${run.exitCode ?? 'signal'}` }),
        consoleOutput: [...parsed.consoleOutput, ...run.stderr.split(/\r?\n/).filter(Boolean)],
        executionTimeMs: Date.now() - startedAt,
        timings: { compileMs, runMs, totalMs: Date.now() - startedAt },
        ...(run.timedOut ? { timeoutReason: 'client-timeout' as const } : {}),
      };
      if (!options.tracing) {
        return {
          ...base,
          trace: createEmptyRuntimeTrace('cpp', { runId: 'cpp:run', file: 'solution.cpp' }),
        };
      }
      const finalized = api.finalizeRuntimeTrace(parsed.events, {
        ...(options.traceOptions ?? {}),
        sourceCode: code,
      });
      return {
        ...base,
        trace: finalized.trace,
        traceLimitExceeded: finalized.traceLimitExceeded || Boolean(parsed.traceStatus?.traceLimitExceeded),
        timeoutReason: parsed.traceStatus?.timeoutReason as ExecutionResult['timeoutReason'] | undefined,
        lineEventCount: finalized.trace.lineEventCount,
        traceStepCount: finalized.trace.traceStepCount,
      };
    } catch (error) {
      return {
        success: false,
        output: null,
        error: error instanceof Error ? error.message : String(error),
        consoleOutput: [],
        trace: createEmptyRuntimeTrace('cpp', { runId: 'cpp:run', file: 'solution.cpp' }),
        executionTimeMs: Date.now() - startedAt,
      };
    } finally {
      await removeTempDir(tempDir, this.options.keepTempDirs);
    }
  }
}

function csharpProjectSource(targetFramework: string): string {
  return `<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup>
    <OutputType>Exe</OutputType>
    <TargetFramework>${targetFramework}</TargetFramework>
    <ImplicitUsings>enable</ImplicitUsings>
    <Nullable>disable</Nullable>
  </PropertyGroup>
</Project>
`;
}

function csharpDriverSource(userCode: string, functionName: string, executionStyle: RuntimeExecutionStyle, trace: boolean): string {
  return `
using System;
using System.Collections;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Text.Json;

${userCode}

public static class __TraceCodeNativeCSharpDriver
{
    private const string FunctionName = ${JSON.stringify(functionName)};
    private const string ExecutionStyle = ${JSON.stringify(executionStyle)};
    private const bool TraceEnabled = ${trace ? 'true' : 'false'};

    public static int Main()
    {
        var originalOut = Console.Out;
        try
        {
            var inputJson = Console.In.ReadToEnd();
            using var doc = JsonDocument.Parse(string.IsNullOrWhiteSpace(inputJson) ? "[]" : inputJson);
            var cases = doc.RootElement.ValueKind == JsonValueKind.Array
                ? doc.RootElement.EnumerateArray().ToArray()
                : new[] { doc.RootElement };
            var results = new List<object?>();
            foreach (var item in cases)
            {
                results.Add(RunCase(item));
            }
            originalOut.WriteLine("__TRACECODE_RESULT__" + JsonSerializer.Serialize(new { success = results.All(IsSuccess), results }));
            return results.All(IsSuccess) ? 0 : 1;
        }
        catch (Exception error)
        {
            originalOut.WriteLine("__TRACECODE_RESULT__" + JsonSerializer.Serialize(new {
                success = false,
                results = new[] { new { success = false, output = (object?)null, error = error.ToString(), consoleOutput = Array.Empty<string>() } }
            }));
            return 1;
        }
    }

    private static bool IsSuccess(object? value)
    {
        var property = value?.GetType().GetProperty("success");
        return property != null && property.GetValue(value) is bool success && success;
    }

    private static object RunCase(JsonElement inputs)
    {
        var captured = new StringWriter();
        var originalOut = Console.Out;
        Console.SetOut(captured);
        try
        {
            var assembly = Assembly.GetExecutingAssembly();
            var solutionType = assembly.GetTypes().FirstOrDefault(type => type.Name == "Solution")
                ?? assembly.GetTypes().FirstOrDefault(type => type.GetMethod(FunctionName, BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Static | BindingFlags.Instance) != null);
            if (solutionType == null)
            {
                throw new MissingMethodException("Implement a Solution class or a class containing the requested method.");
            }
            var flags = BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Static | BindingFlags.Instance;
            var method = solutionType.GetMethods(flags).FirstOrDefault(candidate => candidate.Name == FunctionName)
                ?? throw new MissingMethodException(solutionType.FullName, FunctionName);
            object? instance = method.IsStatic ? null : Activator.CreateInstance(solutionType);
            var parameters = method.GetParameters();
            var args = new object?[parameters.Length];
            for (var index = 0; index < parameters.Length; index++)
            {
                var parameter = parameters[index];
                if (TryGetInputValue(inputs, parameter, index, out var value))
                {
                    args[index] = ConvertJsonElement(value, parameter.ParameterType);
                }
                else
                {
                    args[index] = parameter.HasDefaultValue ? parameter.DefaultValue : GetDefault(parameter.ParameterType);
                }
            }
            var output = method.Invoke(instance, args);
            Console.SetOut(originalOut);
            return new {
                success = true,
                output,
                consoleOutput = CapturedLines(captured),
                trace = TraceEnabled ? new {
                    schemaVersion = "runtime-trace-2026-04-28",
                    language = "csharp",
                    runId = "csharp:run",
                    events = Array.Empty<object>(),
                    lineEventCount = 0,
                    traceStepCount = 0
                } : null
            };
        }
        catch (TargetInvocationException error)
        {
            Console.SetOut(originalOut);
            var inner = error.InnerException ?? error;
            return new { success = false, output = (object?)null, error = inner.Message, consoleOutput = CapturedLines(captured) };
        }
        catch (Exception error)
        {
            Console.SetOut(originalOut);
            return new { success = false, output = (object?)null, error = error.Message, consoleOutput = CapturedLines(captured) };
        }
    }

    private static bool TryGetInputValue(JsonElement inputs, ParameterInfo parameter, int index, out JsonElement value)
    {
        value = default;
        if (inputs.ValueKind != JsonValueKind.Object)
        {
            return false;
        }
        if (parameter.Name != null && inputs.TryGetProperty(parameter.Name, out value))
        {
            return true;
        }
        if (inputs.TryGetProperty(index.ToString(), out value))
        {
            return true;
        }
        var currentIndex = 0;
        foreach (var property in inputs.EnumerateObject())
        {
            if (currentIndex == index)
            {
                value = property.Value;
                return true;
            }
            currentIndex++;
        }
        return false;
    }

    private static object? ConvertJsonElement(JsonElement value, Type targetType)
    {
        var nullableType = Nullable.GetUnderlyingType(targetType);
        if (nullableType != null)
        {
            return value.ValueKind == JsonValueKind.Null ? null : ConvertJsonElement(value, nullableType);
        }
        if (targetType == typeof(JsonElement))
        {
            return value;
        }
        if (targetType == typeof(object))
        {
            return ConvertJsonElementToClrObject(value);
        }
        if (targetType == typeof(string))
        {
            return value.ValueKind == JsonValueKind.Null ? null : value.GetString();
        }
        if (targetType == typeof(bool))
        {
            return value.GetBoolean();
        }
        if (targetType == typeof(int))
        {
            return value.GetInt32();
        }
        if (targetType == typeof(long))
        {
            return value.GetInt64();
        }
        if (targetType == typeof(double))
        {
            return value.GetDouble();
        }
        if (targetType == typeof(float))
        {
            return value.GetSingle();
        }
        if (targetType == typeof(decimal))
        {
            return value.GetDecimal();
        }
        if (targetType.IsEnum)
        {
            return value.ValueKind == JsonValueKind.String
                ? Enum.Parse(targetType, value.GetString() ?? string.Empty)
                : Enum.ToObject(targetType, value.GetInt32());
        }
        if (targetType.IsArray)
        {
            var elementType = targetType.GetElementType() ?? typeof(object);
            var items = value.ValueKind == JsonValueKind.Array ? value.EnumerateArray().ToArray() : Array.Empty<JsonElement>();
            var output = Array.CreateInstance(elementType, items.Length);
            for (var i = 0; i < items.Length; i++)
            {
                output.SetValue(ConvertJsonElement(items[i], elementType), i);
            }
            return output;
        }
        var listElementType = ListElementType(targetType);
        if (listElementType != null)
        {
            var listType = typeof(List<>).MakeGenericType(listElementType);
            var output = (IList)Activator.CreateInstance(listType)!;
            if (value.ValueKind == JsonValueKind.Array)
            {
                foreach (var item in value.EnumerateArray())
                {
                    output.Add(ConvertJsonElement(item, listElementType));
                }
            }
            return output;
        }
        var dictionaryValueType = StringDictionaryValueType(targetType);
        if (dictionaryValueType != null)
        {
            var dictionaryType = typeof(Dictionary<,>).MakeGenericType(typeof(string), dictionaryValueType);
            var output = (IDictionary)Activator.CreateInstance(dictionaryType)!;
            if (value.ValueKind == JsonValueKind.Object)
            {
                foreach (var property in value.EnumerateObject())
                {
                    output[property.Name] = ConvertJsonElement(property.Value, dictionaryValueType);
                }
            }
            return output;
        }
        return JsonSerializer.Deserialize(value.GetRawText(), targetType);
    }

    private static Type? ListElementType(Type type)
    {
        if (type.IsGenericType && type.GetGenericTypeDefinition() == typeof(List<>))
        {
            return type.GetGenericArguments()[0];
        }
        if (type.IsGenericType && (
            type.GetGenericTypeDefinition() == typeof(IList<>) ||
            type.GetGenericTypeDefinition() == typeof(ICollection<>) ||
            type.GetGenericTypeDefinition() == typeof(IEnumerable<>) ||
            type.GetGenericTypeDefinition() == typeof(IReadOnlyList<>) ||
            type.GetGenericTypeDefinition() == typeof(IReadOnlyCollection<>)))
        {
            return type.GetGenericArguments()[0];
        }
        var collectionInterface = type.GetInterfaces()
            .FirstOrDefault(candidate => candidate.IsGenericType && (
                candidate.GetGenericTypeDefinition() == typeof(IList<>) ||
                candidate.GetGenericTypeDefinition() == typeof(ICollection<>) ||
                candidate.GetGenericTypeDefinition() == typeof(IEnumerable<>) ||
                candidate.GetGenericTypeDefinition() == typeof(IReadOnlyList<>) ||
                candidate.GetGenericTypeDefinition() == typeof(IReadOnlyCollection<>)));
        if (collectionInterface != null)
        {
            return collectionInterface.GetGenericArguments()[0];
        }
        return typeof(IList).IsAssignableFrom(type) ? typeof(object) : null;
    }

    private static Type? StringDictionaryValueType(Type type)
    {
        if (type.IsGenericType && type.GetGenericTypeDefinition() == typeof(Dictionary<,>) && type.GetGenericArguments()[0] == typeof(string))
        {
            return type.GetGenericArguments()[1];
        }
        var dictionaryInterface = type.GetInterfaces()
            .FirstOrDefault(candidate => candidate.IsGenericType &&
                candidate.GetGenericTypeDefinition() == typeof(IDictionary<,>) &&
                candidate.GetGenericArguments()[0] == typeof(string));
        return dictionaryInterface?.GetGenericArguments()[1];
    }

    private static object? ConvertJsonElementToClrObject(JsonElement value)
    {
        switch (value.ValueKind)
        {
            case JsonValueKind.Null:
            case JsonValueKind.Undefined:
                return null;
            case JsonValueKind.String:
                return value.GetString();
            case JsonValueKind.True:
                return true;
            case JsonValueKind.False:
                return false;
            case JsonValueKind.Number:
                if (value.TryGetInt32(out var intValue)) return intValue;
                if (value.TryGetInt64(out var longValue)) return longValue;
                return value.GetDouble();
            case JsonValueKind.Array:
                return value.EnumerateArray().Select(ConvertJsonElementToClrObject).ToList();
            case JsonValueKind.Object:
                return value.EnumerateObject().ToDictionary(property => property.Name, property => ConvertJsonElementToClrObject(property.Value));
            default:
                return null;
        }
    }

    private static object? GetDefault(Type type) => type.IsValueType ? Activator.CreateInstance(type) : null;

    private static string[] CapturedLines(StringWriter writer)
    {
        return writer.ToString().Split(new[] { "\\r\\n", "\\n" }, StringSplitOptions.RemoveEmptyEntries);
    }
}
`;
}

class NativeCSharpRuntimeClient implements RuntimeClient {
  constructor(
    private readonly options: {
      dotnetCommand: string;
      timeoutMs: number;
      targetFramework: string;
      keepTempDirs?: boolean;
    }
  ) {}

  async init(): Promise<{ success: boolean; loadTimeMs: number }> {
    const startedAt = Date.now();
    const result = await runProcess(this.options.dotnetCommand, ['--version'], { timeoutMs: this.options.timeoutMs });
    if (result.exitCode !== 0 || result.timedOut) {
      throw new Error(result.stderr || result.stdout || 'Unable to run dotnet.');
    }
    return { success: true, loadTimeMs: Date.now() - startedAt };
  }

  async execute(request: RuntimeExecuteCodeRequest): Promise<RuntimeExecuteResult>;
  async execute(request: RuntimeExecuteProjectRequest): Promise<RuntimeCommandResult>;
  async execute(request: RuntimeExecuteRequest): Promise<RuntimeExecuteResponse> {
    return executeNativeRuntimeRequest(request, {
      defaultExecutionStyle: 'solution-method',
      executeCode: this.executeCode.bind(this),
      executeWithTracing: this.executeWithTracing.bind(this),
      executeCodeInterviewMode: this.executeCodeInterviewMode.bind(this),
      executeBatch: this.executeBatch.bind(this),
    });
  }

  async executeCode(
    code: string,
    functionName: string,
    inputs: Record<string, unknown>,
    executionStyle: RuntimeExecutionStyle = 'solution-method'
  ): Promise<CodeExecutionResult> {
    const result = await this.executeBatch({
      kind: 'code',
      code,
      functionName,
      executionStyle,
      cases: [{ inputs }],
    });
    const first = result.cases[0];
    return first
      ? {
          success: first.success,
          output: first.output ?? null,
          error: first.error,
          errorLine: first.errorLine,
          consoleOutput: first.consoleOutput,
          timeoutReason: first.timeoutReason,
          diagnosticStage: first.diagnosticStage,
          diagnostic: first.diagnostic,
          timings: first.timings,
        }
      : { success: false, output: null, error: 'C# execution did not return a result.', consoleOutput: [] };
  }

  async executeCodeInterviewMode(
    code: string,
    functionName: string,
    inputs: Record<string, unknown>,
    executionStyle: RuntimeExecutionStyle = 'solution-method'
  ): Promise<CodeExecutionResult> {
    return this.executeCode(code, functionName, inputs, executionStyle);
  }

  async executeBatch(request: RuntimeExecuteCodeRequest): Promise<RuntimeExecuteResult> {
    const startedAt = Date.now();
    const raw = await this.compileAndRun(request, false);
    const rawResults = Array.isArray(raw.results) ? raw.results as Record<string, unknown>[] : [];
    const cases = request.cases.map((testCase, index) => codeResultToExecuteCase(testCase, {
      success: rawResults[index]?.success === true,
      output: rawResults[index]?.output,
      error: rawResults[index]?.error as string | undefined,
      consoleOutput: Array.isArray(rawResults[index]?.consoleOutput) ? rawResults[index].consoleOutput as string[] : [],
      timings: { totalMs: Date.now() - startedAt },
    }));
    return {
      success: raw.success === true && cases.every((testCase) => testCase.success),
      cases,
      timings: { totalMs: Date.now() - startedAt },
    };
  }

  async executeWithTracing(
    code: string,
    functionName: string | null,
    inputs: Record<string, unknown>,
    _options: TraceExecutionOptions = {},
    executionStyle: RuntimeExecutionStyle = 'solution-method'
  ): Promise<ExecutionResult> {
    const startedAt = Date.now();
    const raw = await this.compileAndRun({
      kind: 'code',
      code,
      functionName,
      executionStyle,
      cases: [{ inputs }],
    }, true);
    const entry = Array.isArray(raw.results) ? raw.results[0] as Record<string, unknown> | undefined : undefined;
    const trace = entry?.trace && typeof entry.trace === 'object'
      ? entry.trace as RuntimeTrace
      : createEmptyRuntimeTrace('csharp', { runId: 'csharp:run', file: 'solution.cs' });
    return {
      success: entry?.success === true,
      output: entry?.output,
      error: entry?.error as string | undefined,
      trace,
      executionTimeMs: Date.now() - startedAt,
      consoleOutput: Array.isArray(entry?.consoleOutput) ? entry.consoleOutput as string[] : [],
      lineEventCount: trace.lineEventCount,
      traceStepCount: trace.traceStepCount,
      timings: { totalMs: Date.now() - startedAt },
    };
  }

  private async compileAndRun(request: RuntimeExecuteCodeRequest, trace: boolean): Promise<Record<string, unknown>> {
    const tempDir = await mkdtemp(join(tmpdir(), 'tracecode-native-csharp-'));
    try {
      await writeFile(join(tempDir, 'TraceCodeNativeCSharp.csproj'), csharpProjectSource(this.options.targetFramework), 'utf8');
      await writeFile(
        join(tempDir, 'Program.cs'),
        csharpDriverSource(request.code, request.functionName ?? '', request.executionStyle ?? 'solution-method', trace),
        'utf8'
      );
      const build = await runProcess(this.options.dotnetCommand, ['build', '-nologo', '-v:q'], {
        cwd: tempDir,
        timeoutMs: this.options.timeoutMs,
      });
      if (build.exitCode !== 0 || build.timedOut) {
        return {
          success: false,
          results: request.cases.map(() => ({
            success: false,
            output: null,
            error: build.stderr || build.stdout || 'C# compilation failed.',
            consoleOutput: [],
          })),
        };
      }
      const run = await runProcess(this.options.dotnetCommand, ['run', '--no-build', '--no-restore'], {
        cwd: tempDir,
        input: JSON.stringify(request.cases.map((testCase) => testCase.inputs ?? {})),
        timeoutMs: this.options.timeoutMs,
      });
      try {
        return parseMarkerJson(run.stdout, '__TRACECODE_RESULT__');
      } catch (error) {
        return {
          success: false,
          results: request.cases.map(() => ({
            success: false,
            output: null,
            error: run.stderr || (error instanceof Error ? error.message : String(error)),
            consoleOutput: [],
          })),
        };
      }
    } finally {
      await removeTempDir(tempDir, this.options.keepTempDirs);
    }
  }
}

function parseMarkerJson<T>(stdout: string, marker: string): T {
  const line = stdout.split(/\r?\n/).reverse().find((candidate) => candidate.startsWith(marker));
  if (!line) throw new Error(`Native runtime did not emit ${marker}.`);
  return JSON.parse(line.slice(marker.length)) as T;
}

class UnsupportedNativeRuntimeClient implements RuntimeClient {
  constructor(private readonly language: Language) {}

  async init(): Promise<{ success: boolean; loadTimeMs: number }> {
    throw this.unsupported();
  }

  async execute(_request: RuntimeExecuteCodeRequest): Promise<RuntimeExecuteResult>;
  async execute(_request: RuntimeExecuteProjectRequest): Promise<RuntimeCommandResult>;
  async execute(_request: RuntimeExecuteRequest): Promise<RuntimeExecuteResponse> {
    throw this.unsupported();
  }

  async executeWithTracing(): Promise<ExecutionResult> {
    throw this.unsupported();
  }

  async executeCode(): Promise<CodeExecutionResult> {
    throw this.unsupported();
  }

  async executeCodeInterviewMode(): Promise<CodeExecutionResult> {
    throw this.unsupported();
  }

  private unsupported(): Error {
    return new Error(
      `${this.language} native code execution is not implemented in createNativeHarness yet. ` +
      'Use createNativeProjectWorkspace for shell/project execution, or use the browser harness for sandboxed code clients.'
    );
  }
}

function createNativeRuntimeClient(language: Language, options: NativeHarnessOptions): RuntimeClient {
  if (language === 'python') {
    return new NativePythonRuntimeClient({
      pythonCommand: options.pythonCommand ?? 'python3',
      timeoutMs: options.pythonTimeoutMs ?? 30_000,
      runtimeCorePath: options.pythonRuntimeCorePath,
    });
  }
  if (language === 'javascript' || language === 'typescript') {
    return new NativeJavaScriptRuntimeClient(language, options);
  }
  if (language === 'java') {
    return new NativeJavaRuntimeClient({
      javacCommand: options.javacCommand ?? 'javac',
      javaCommand: options.javaCommand ?? 'java',
      timeoutMs: options.javaTimeoutMs ?? 30_000,
      workerSourcePath: options.javaWorkerSourcePath,
      keepTempDirs: options.keepNativeTempDirs,
    });
  }
  if (language === 'csharp') {
    return new NativeCSharpRuntimeClient({
      dotnetCommand: options.dotnetCommand ?? 'dotnet',
      timeoutMs: options.csharpTimeoutMs ?? 30_000,
      targetFramework: options.csharpTargetFramework ?? 'net10.0',
      keepTempDirs: options.keepNativeTempDirs,
    });
  }
  if (language === 'cpp') {
    return new NativeCppRuntimeClient({
      compilerCommand: options.cppCompilerCommand ?? 'clang++',
      timeoutMs: options.cppTimeoutMs ?? 30_000,
      workerSourcePath: options.cppWorkerSourcePath,
      keepTempDirs: options.keepNativeTempDirs,
    });
  }
  return new UnsupportedNativeRuntimeClient(language);
}

function disposeNativeRuntimeClient(client: RuntimeClient): void {
  if ('dispose' in client && typeof client.dispose === 'function') {
    client.dispose();
  }
}

class NativeHarnessQueueImpl implements NativeHarnessQueue {
  private readonly workerCount: number;
  private readonly workerClients: Map<Language, RuntimeClient>[];
  private readonly pending: {
    job: NativeHarnessJob;
    resolve: (value: NativeHarnessJobResult) => void;
  }[] = [];
  private readonly waitingWorkers: ((task: { job: NativeHarnessJob; resolve: (value: NativeHarnessJobResult) => void } | null) => void)[] = [];
  private readonly workerPromises: Promise<void>[];
  private drainResolvers: (() => void)[] = [];
  private activeCount = 0;
  private disposed = false;

  constructor(
    private readonly options: NativeHarnessOptions,
    queueOptions: NativeHarnessQueueOptions = {}
  ) {
    this.workerCount = Math.max(1, Math.floor(queueOptions.workers ?? options.jobs ?? 1));
    this.workerClients = Array.from({ length: this.workerCount }, () => new Map<Language, RuntimeClient>());
    this.workerPromises = this.workerClients.map((clients, index) => this.workerLoop(index, clients));
  }

  enqueue(job: NativeHarnessJob): Promise<NativeHarnessJobResult> {
    if (this.disposed) {
      return Promise.resolve({
        id: job.id,
        language: job.language,
        success: false,
        error: 'Native harness queue has been disposed.',
        durationMs: 0,
      });
    }

    return new Promise((resolve) => {
      const task = { job, resolve };
      const waitingWorker = this.waitingWorkers.shift();
      if (waitingWorker) {
        waitingWorker(task);
        return;
      }
      this.pending.push(task);
    });
  }

  async run(jobs: Iterable<NativeHarnessJob> | AsyncIterable<NativeHarnessJob>): Promise<NativeHarnessJobResult[]> {
    const results: NativeHarnessJobResult[] = [];
    await this.runEach(jobs, (result, index) => {
      results[index] = result;
    });
    return results;
  }

  async runEach(
    jobs: Iterable<NativeHarnessJob> | AsyncIterable<NativeHarnessJob>,
    onResult: NativeHarnessJobResultHandler
  ): Promise<void> {
    const maxInFlight = Math.max(1, this.workerCount * 2);
    const inFlight = new Set<Promise<void>>();
    let index = 0;
    const schedule = async (job: NativeHarnessJob): Promise<void> => {
      const resultIndex = index;
      index += 1;
      let promise: Promise<void>;
      promise = this.enqueue(job)
        .then((result) => onResult(result, resultIndex))
        .finally(() => {
          inFlight.delete(promise);
        });
      inFlight.add(promise);
      if (inFlight.size >= maxInFlight) {
        await Promise.race(inFlight);
      }
    };

    if (Symbol.asyncIterator in jobs) {
      for await (const job of jobs) {
        await schedule(job);
      }
    } else {
      for (const job of jobs) {
        await schedule(job);
      }
    }
    await Promise.all(inFlight);
  }

  async drain(): Promise<void> {
    if (this.pending.length === 0 && this.activeCount === 0) return;
    await new Promise<void>((resolve) => {
      this.drainResolvers.push(resolve);
    });
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    while (this.pending.length > 0) {
      const task = this.pending.shift();
      task?.resolve({
        id: task.job.id,
        language: task.job.language,
        success: false,
        error: 'Native harness queue was disposed before this job started.',
        durationMs: 0,
      });
    }
    while (this.waitingWorkers.length > 0) {
      this.waitingWorkers.shift()?.(null);
    }
    for (const clients of this.workerClients) {
      for (const client of clients.values()) {
        disposeNativeRuntimeClient(client);
      }
      clients.clear();
    }
    this.resolveDrainIfIdle();
    void Promise.allSettled(this.workerPromises);
  }

  private async workerLoop(workerIndex: number, clients: Map<Language, RuntimeClient>): Promise<void> {
    while (!this.disposed) {
      const task = await this.nextTask();
      if (!task) break;
      this.activeCount += 1;
      try {
        task.resolve(await this.executeJob(workerIndex, clients, task.job));
      } finally {
        this.activeCount -= 1;
        this.resolveDrainIfIdle();
      }
    }
  }

  private async nextTask(): Promise<{ job: NativeHarnessJob; resolve: (value: NativeHarnessJobResult) => void } | null> {
    const task = this.pending.shift();
    if (task) return task;
    if (this.disposed) return null;
    return new Promise((resolve) => {
      this.waitingWorkers.push(resolve);
    });
  }

  private async executeJob(
    _workerIndex: number,
    clients: Map<Language, RuntimeClient>,
    job: NativeHarnessJob
  ): Promise<NativeHarnessJobResult> {
    const startedAt = Date.now();
    try {
      let client = clients.get(job.language);
      if (!client) {
        client = createNativeRuntimeClient(job.language, this.options);
        clients.set(job.language, client);
      }
      const result = await client.execute(job.request);
      return {
        id: job.id,
        language: job.language,
        success: result.success,
        result,
        durationMs: Date.now() - startedAt,
      };
    } catch (error) {
      return {
        id: job.id,
        language: job.language,
        success: false,
        error: error instanceof Error ? error.message : String(error),
        durationMs: Date.now() - startedAt,
      };
    }
  }

  private resolveDrainIfIdle(): void {
    if (this.pending.length > 0 || this.activeCount > 0) return;
    const resolvers = this.drainResolvers;
    this.drainResolvers = [];
    for (const resolve of resolvers) resolve();
  }
}

export function createNativeHarness(options: NativeHarnessOptions = {}): NativeHarness {
  const clients = new Map<Language, RuntimeClient>();

  const getOrCreateClient = (language: Language): RuntimeClient => {
    const existing = clients.get(language);
    if (existing) return existing;
    const client = createNativeRuntimeClient(language, options);
    clients.set(language, client);
    return client;
  };

  return {
    getClient(language: Language): RuntimeClient {
      return getOrCreateClient(language);
    },
    createQueue(queueOptions: NativeHarnessQueueOptions = {}): NativeHarnessQueue {
      return new NativeHarnessQueueImpl(options, queueOptions);
    },
    async runJobs(
      jobs: Iterable<NativeHarnessJob> | AsyncIterable<NativeHarnessJob>,
      queueOptions: NativeHarnessQueueOptions = {}
    ): Promise<NativeHarnessJobResult[]> {
      const queue = new NativeHarnessQueueImpl(options, queueOptions);
      try {
        return await queue.run(jobs);
      } finally {
        queue.dispose();
      }
    },
    async runJobsEach(
      jobs: Iterable<NativeHarnessJob> | AsyncIterable<NativeHarnessJob>,
      onResult: NativeHarnessJobResultHandler,
      queueOptions: NativeHarnessQueueOptions = {}
    ): Promise<void> {
      const queue = new NativeHarnessQueueImpl(options, queueOptions);
      try {
        await queue.runEach(jobs, onResult);
      } finally {
        queue.dispose();
      }
    },
    getNativeLanguageSupport: ((language?: Language): NativeLanguageSupport | NativeLanguageSupport[] => {
      return language ? getNativeLanguageSupport(language) : SUPPORTED_LANGUAGES.map(getNativeLanguageSupport);
    }) as NativeHarness['getNativeLanguageSupport'],
    isNativeCodeLanguageSupported(language: Language): boolean {
      return isNativeCodeLanguage(language);
    },
    getProfile: getLanguageRuntimeProfile,
    getSupportedLanguageProfiles,
    getLanguageInfo: getLanguageRuntimeInfo,
    getSupportedLanguageInfos: getSupportedLanguageRuntimeInfos,
    isLanguageSupported,
    async warmLanguage(language: Language): Promise<void> {
      await getOrCreateClient(language).init();
    },
    disposeLanguage(language: Language): void {
      const client = clients.get(language);
      if (client) disposeNativeRuntimeClient(client);
      clients.delete(language);
    },
    dispose(): void {
      for (const language of [...clients.keys()]) {
        this.disposeLanguage(language);
      }
    },
  };
}
