import './styles.css';

import * as monaco from 'monaco-editor';
import editorWorker from 'monaco-editor/esm/vs/editor/editor.worker?worker';
import jsonWorker from 'monaco-editor/esm/vs/language/json/json.worker?worker';
import tsWorker from 'monaco-editor/esm/vs/language/typescript/ts.worker?worker';

import { createBrowserHarness, SUPPORTED_LANGUAGES } from '@tracecode/harness/browser';
import type { Language } from '@tracecode/harness/core';

// ----------------------------------------------------------------------
// Monaco Environment Setup
// ----------------------------------------------------------------------
self.MonacoEnvironment = {
  getWorker(_, label) {
    if (label === 'json') return new jsonWorker();
    if (label === 'typescript' || label === 'javascript') return new tsWorker();
    return new editorWorker();
  }
};

monaco.editor.defineTheme('tracecodeDark', {
  base: 'vs-dark',
  inherit: true,
  rules: [
    { background: '1e1f22', token: '' }
  ],
  colors: {
    'editor.background': '#1e1f22',
    'editor.lineHighlightBackground': '#26282e',
    'editorLineNumber.foreground': '#585b63',
    'editorIndentGuide.background': '#393b40',
    'editor.selectionBackground': '#2d5fa566',
    'scrollbarSlider.background': '#393b4080',
    'scrollbarSlider.hoverBackground': '#4e515780',
    'scrollbarSlider.activeBackground': '#5a5d63',
  }
});

// ----------------------------------------------------------------------
// Constants & Fixtures
// ----------------------------------------------------------------------
type ExampleFixture = {
  functionName: string;
  inputs: Record<string, unknown>;
  code: string;
  executionStyle?: 'function' | 'solution-method' | 'ops-class';
};

const EXAMPLES: Record<Language, ExampleFixture> = {
  python: {
    functionName: 'solve',
    inputs: {
      nums: [2, 7, 11, 15],
      target: 9,
    },
    code: `def solve(nums, target):
    seen = {}
    for index, value in enumerate(nums):
        complement = target - value
        if complement in seen:
            return [seen[complement], index]
        seen[value] = index
    return []`,
  },
  javascript: {
    functionName: 'solve',
    inputs: {
      nums: [2, 7, 11, 15],
      target: 9,
    },
    code: `function solve(nums, target) {
  const seen = new Map();
  for (let index = 0; index < nums.length; index += 1) {
    const value = nums[index];
    const complement = target - value;
    if (seen.has(complement)) {
      return [seen.get(complement), index];
    }
    seen.set(value, index);
  }
  return [];
}`,
  },
  typescript: {
    functionName: 'solve',
    inputs: {
      nums: [2, 7, 11, 15],
      target: 9,
    },
    code: `function solve(nums: number[], target: number): number[] {
  const seen = new Map<number, number>();
  for (let index = 0; index < nums.length; index += 1) {
    const value = nums[index];
    const complement = target - value;
    if (seen.has(complement)) {
      return [seen.get(complement)!, index];
    }
    seen.set(value, index);
  }
  return [];
}`,
  },
  java: {
    functionName: '',
    executionStyle: 'function',
    inputs: {},
    code: `import java.util.HashMap;
import java.util.Map;

int[] nums = new int[] { 2, 7, 11, 15 };
int target = 9;
Map<Integer, Integer> seen = new HashMap<>();
result = new int[] {};

  for (int index = 0; index < nums.length; index += 1) {
    int value = nums[index];
    int complement = target - value;
    if (seen.containsKey(complement)) {
      result = new int[] { seen.get(complement), index };
      break;
    }
    seen.put(value, index);
}`,
  },
  csharp: {
    functionName: 'Add',
    executionStyle: 'solution-method',
    inputs: {
      a: 2,
      b: 3,
    },
    code: `public class Solution
{
    public int Add(int a, int b)
    {
        return a + b;
    }
}`,
  },
  cpp: {
    functionName: '',
    executionStyle: 'function',
    inputs: {},
    code: `vector<int> nums = {2, 7, 11, 15};
int target = 9;
vector<int> result;
unordered_map<int, int> seen;

for (int index = 0; index < nums.size(); ++index) {
  int complement = target - nums[index];
  if (seen.count(complement)) {
    result = {seen[complement], index};
    break;
  }
  seen[nums[index]] = index;
}`,
  },
};

const getExtension = (lang: Language) => {
  if (lang === 'python') return '.py';
  if (lang === 'javascript') return '.js';
  if (lang === 'typescript') return '.ts';
  if (lang === 'java') return '.java';
  if (lang === 'csharp') return '.cs';
  if (lang === 'cpp') return '.cpp';
  return '.txt';
};

const getEditorLanguage = (lang: Language): string => {
  if (lang === 'typescript') return 'typescript';
  if (lang === 'javascript') return 'javascript';
  if (lang === 'python') return 'python';
  if (lang === 'java') return 'java';
  if (lang === 'csharp') return 'csharp';
  if (lang === 'cpp') return 'cpp';
  return 'plaintext';
};

async function bootDevTerminal(): Promise<void> {
  document.body.innerHTML = `
    <main class="dev-terminal-root">
      <section class="dev-terminal">
        <div class="dev-terminal-header">
          <span class="dev-terminal-title">/dev</span>
          <span class="dev-terminal-status" id="dev-terminal-status">booting</span>
        </div>
        <div class="dev-terminal-output" id="dev-terminal-output" aria-live="polite"></div>
        <form class="dev-terminal-form" id="dev-terminal-form">
          <span class="dev-terminal-prompt">$</span>
          <input
            id="dev-terminal-input"
            class="dev-terminal-input"
            autocomplete="off"
            spellcheck="false"
            autofocus
          />
        </form>
      </section>
    </main>
  `;

  const output = document.querySelector<HTMLDivElement>('#dev-terminal-output')!;
  const status = document.querySelector<HTMLSpanElement>('#dev-terminal-status')!;
  const form = document.querySelector<HTMLFormElement>('#dev-terminal-form')!;
  const input = document.querySelector<HTMLInputElement>('#dev-terminal-input')!;

  const appendLine = (text: string, className = ''): void => {
    const line = document.createElement('div');
    line.className = `dev-terminal-line ${className}`.trim();
    line.textContent = text;
    output.append(line);
    output.scrollTop = output.scrollHeight;
  };

  const appendBlock = (text: string, className = ''): void => {
    if (!text) return;
    for (const line of text.replace(/\r\n/g, '\n').replace(/\n$/, '').split('\n')) {
      appendLine(line, className);
    }
  };

  appendLine('Loading project workspace...');

  const { createBrowserProjectWorkspace } = await import('@tracecode/harness/browser/project');

  const workspace = await createBrowserProjectWorkspace({
    assetBaseUrl: '/workers',
    pythonProjectTimeoutMs: 120_000,
    javaProjectTimeoutMs: 120_000,
    csharpProjectTimeoutMs: 120_000,
    cppProjectTimeoutMs: 120_000,
    files: [
      {
        path: 'helper.py',
        contents: `def add(left, right):
    return left + right
`,
      },
      {
        path: 'main.py',
        contents: `from helper import add
import sys

print(add(2, 3))
if len(sys.argv) > 1:
    print("args=" + ",".join(sys.argv[1:]))
`,
      },
      {
        path: 'app/__init__.py',
        contents: '',
      },
      {
        path: 'app/mathlib.py',
        contents: `def add(left, right):
    return left + right
`,
      },
      {
        path: 'app/main.py',
        contents: `from .mathlib import add
import sys

print(add(2, 3))
print("package=" + str(__package__))
if len(sys.argv) > 1:
    print("module_args=" + ",".join(sys.argv[1:]))
`,
      },
      {
        path: 'src/py/helper.py',
        contents: `def value():
    return 31
`,
      },
      {
        path: 'src/py/main.py',
        contents: `import os
from helper import value

print(os.getcwd())
print(value())
open("generated.txt", "w").write("created\\n")
`,
      },
      {
        path: 'vendor/pkgtools.py',
        contents: `def value():
    return 42
`,
      },
      {
        path: 'py_env.py',
        contents: `import os
from pkgtools import value

print(value())
print(os.environ.get("MODE"))
`,
      },
      {
        path: 'pkg_a/__init__.py',
        contents: '',
      },
      {
        path: 'pkg_a/helper.py',
        contents: `def value():
    return "a-helper"
`,
      },
      {
        path: 'pkg_a/main.py',
        contents: `from .helper import value

print(value())
open("pkg-a-generated.txt", "w").write(value() + "\\n")
`,
      },
      {
        path: 'pkg_b/__init__.py',
        contents: '',
      },
      {
        path: 'pkg_b/helper.py',
        contents: `def value():
    return "b-helper"
`,
      },
      {
        path: 'pkg_b/main.py',
        contents: `from .helper import value

print(value())
open("pkg-b-generated.txt", "w").write(value() + "\\n")
`,
      },
      {
        path: 'vendor/pkg_b/helper.py',
        contents: `def value():
    return "vendor-helper"
`,
      },
      {
        path: 'reload_target.py',
        contents: `def value():
    return "old"
`,
      },
      {
        path: 'reload_main.py',
        contents: `from reload_target import value

print(value())
`,
      },
      {
        path: 'stale.txt',
        contents: 'delete me\n',
      },
      {
        path: 'java-stale.txt',
        contents: 'delete me\n',
      },
      {
        path: 'README.txt',
        contents: 'Try: ls, cat main.py, python3 main.py alpha beta, python3 globpy/*.py data/*.txt, python3 -m app.main alpha beta, node index.js alpha beta, node globjs/*.js data/*.txt, javac -d out src/app/PackageMain.java src/app/PackageHelper.java, javac -d glob-out src/app/*.java, java --class-path out app.PackageMain alpha beta, java --class-path glob-out app.PackageMain alpha beta, java Main alpha beta, java app.PackageMain alpha beta, java right.Main, dotnet run -- alpha beta, dotnet run -- data/*.txt, clang++ -std=c++17 main.cpp helper.cpp, clang++ -std=c++17 *.cpp -o glob-app, ./a.out alpha beta, ./glob-app alpha beta, ./glob-app data/*.txt\\n',
      },
      {
        path: 'data/a.txt',
        contents: 'a\n',
      },
      {
        path: 'data/b.txt',
        contents: 'b\n',
      },
      {
        path: 'globpy/run.py',
        contents: `import sys

print(2 + 3)
print("python_glob_args=" + ",".join(sys.argv[1:]))
`,
      },
      {
        path: 'math.js',
        contents: `exports.add = (left, right) => left + right;
`,
      },
      {
        path: 'index.js',
        contents: `const { add } = require("./math");

console.log(add(2, 3));
if (process.argv.length > 2) {
  console.log("node_args=" + process.argv.slice(2).join(","));
}
`,
      },
      {
        path: 'globjs/run.js',
        contents: `console.log(2 + 3);
console.log("node_glob_args=" + process.argv.slice(2).join(","));
`,
      },
      {
        path: 'Helper.java',
        contents: `class Helper {
  static int add(int left, int right) {
    return left + right;
  }
}
`,
      },
      {
        path: 'Main.java',
        contents: `class Main {
  public static void main(String[] args) {
    System.out.println(Helper.add(2, 3));
    if (args.length > 0) {
      System.out.println("java_args=" + String.join(",", args));
    }
  }
}
`,
      },
      {
        path: 'src/app/PackageHelper.java',
        contents: `package app;

class PackageHelper {
  static int add(int left, int right) {
    return left + right;
  }
}
`,
      },
      {
        path: 'src/app/PackageMain.java',
        contents: `package app;

public class PackageMain {
  public static void main(String[] args) {
    System.out.println(PackageHelper.add(2, 3));
    if (args.length > 0) {
      System.out.println("java_package_args=" + String.join(",", args));
    }
  }
}
`,
      },
      {
        path: 'src/left/Main.java',
        contents: `package left;

public class Main {
  public static int value() {
    return 5;
  }
}
`,
      },
      {
        path: 'src/right/Main.java',
        contents: `package right;

public class Main {
  public static void main(String[] args) {
    System.out.println(left.Main.value());
  }
}
`,
      },
      {
        path: 'src/javawd/CwdMain.java',
        contents: `public class CwdMain {
  public static void main(String[] args) throws Exception {
    System.out.println(System.getProperty("user.dir"));
    java.nio.file.Path cwd = java.nio.file.Path.of(System.getProperty("user.dir"));
    java.nio.file.Files.writeString(cwd.resolve("generated.txt"), "java-created\\n");
    java.nio.file.Files.deleteIfExists(cwd.resolve("../../java-stale.txt").normalize());
  }
}
`,
      },
      {
        path: 'src/javacwd/CompileMain.java',
        contents: `public class CompileMain {
  public static void main(String[] args) {
    System.out.println("cwd-compile");
  }
}
`,
      },
      {
        path: 'src/javaarg/ArgMain.java',
        contents: `public class ArgMain {
  public static void main(String[] args) {
    System.out.println("argfile-compile");
  }
}
`,
      },
      {
        path: 'src/javaarg/javac.args',
        contents: `-d out
ArgMain.java
`,
      },
      {
        path: 'src/javasourcepath/src/app/Main.java',
        contents: `package app;

public class Main {
  public static void main(String[] args) {
    System.out.println(Helper.value());
  }
}
`,
      },
      {
        path: 'src/javasourcepath/src/app/Helper.java',
        contents: `package app;

class Helper {
  static String value() {
    return "sourcepath-helper";
  }
}
`,
      },
      {
        path: 'src/javasourcepath/javac.args',
        contents: `-d out
-sourcepath src
src/app/Main.java
`,
      },
      {
        path: 'src/javastdin/InputMain.java',
        contents: `public class InputMain {
  public static void main(String[] args) throws Exception {
    java.io.BufferedReader reader = new java.io.BufferedReader(new java.io.InputStreamReader(System.in));
    System.out.println("stdin=" + reader.readLine());
  }
}
`,
      },
      {
        path: 'Program.cs',
        contents: `using System;

Console.WriteLine(Helper.Add(2, 3));
if (args.Length > 0) {
  Console.WriteLine("csharp_args=" + string.Join(",", args));
}
`,
      },
      {
        path: 'Helper.cs',
        contents: `static class Helper
{
  public static int Add(int left, int right) => left + right;
}
`,
      },
      {
        path: 'helper.hpp',
        contents: `#pragma once

int add(int left, int right);
`,
      },
      {
        path: 'helper.cpp',
        contents: `#include "helper.hpp"

int add(int left, int right) {
  return left + right;
}
`,
      },
      {
        path: 'main.cpp',
        contents: `#include "helper.hpp"

#include <iostream>
#include <string>

int main(int argc, char** argv) {
  std::cout << add(2, 3) << "\\n";
  if (argc > 1) {
    std::cout << "cpp_args=";
    for (int index = 1; index < argc; ++index) {
      if (index > 1) std::cout << ",";
      std::cout << argv[index];
    }
    std::cout << "\\n";
  }
  return 0;
}
`,
      },
    ],
  });

  const disposeTerminal = (): void => {
    workspace.dispose();
  };

  (
    window as Window & {
      __tracecodeProjectWorkspace?: typeof workspace;
    }
  ).__tracecodeProjectWorkspace = workspace;

  window.addEventListener('beforeunload', disposeTerminal);
  if (import.meta.hot) {
    import.meta.hot.dispose(disposeTerminal);
  }

  status.textContent = 'ready';
  appendLine('Ready. Try: python3 main.py alpha beta');
  appendLine('Ready. Try: python3 globpy/*.py data/*.txt');
  appendLine('Ready. Try: node index.js alpha beta');
  appendLine('Ready. Try: node globjs/*.js data/*.txt');
  appendLine('Ready. Try: java Main alpha beta');
  appendLine('Ready. Try: javac -d out src/app/PackageMain.java src/app/PackageHelper.java');
  appendLine('Ready. Try: java --class-path out app.PackageMain alpha beta');
  appendLine('Ready. Try: java app.PackageMain alpha beta');
  appendLine('Ready. Try: java right.Main');
  appendLine('Ready. Try: dotnet run -- alpha beta');
  appendLine('Ready. Try: dotnet run -- data/*.txt');
  appendLine('Ready. Try: clang++ -std=c++17 main.cpp helper.cpp');
  appendLine('Ready. Try: ./a.out alpha beta');
  appendLine('Ready. Try: ./glob-app data/*.txt');
  input.disabled = false;
  input.focus();

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const command = input.value.trim();
    if (!command) return;

    input.value = '';
    input.disabled = true;
    status.textContent = 'running';
    appendLine(`$ ${command}`, 'command');

    try {
      const streamedOutput = { stdout: '', stderr: '' };
      const result = await workspace.runCommand(command, {
        onEvent: (event) => {
          if (event.type === 'status') {
            appendLine(`[${event.phase}] ${event.message}`, 'status');
            return;
          }
          if (event.type === 'output') {
            streamedOutput[event.stream] += event.data;
            appendBlock(event.data, event.stream);
          }
        },
      });
      (window as unknown as { __tracecodeLastDevResult?: unknown }).__tracecodeLastDevResult = result;
      const remainingStdout = result.stdout.startsWith(streamedOutput.stdout)
        ? result.stdout.slice(streamedOutput.stdout.length)
        : result.stdout;
      const remainingStderr = result.stderr.startsWith(streamedOutput.stderr)
        ? result.stderr.slice(streamedOutput.stderr.length)
        : result.stderr;
      appendBlock(remainingStdout, 'stdout');
      appendBlock(remainingStderr, 'stderr');
      if (result.exitCode !== 0) {
        appendLine(`exit ${result.exitCode}`, 'exit');
      }
    } catch (error) {
      appendLine(error instanceof Error ? error.message : String(error), 'stderr');
    } finally {
      status.textContent = 'ready';
      input.disabled = false;
      input.focus();
    }
  });
}

function bootIde(): void {
// ----------------------------------------------------------------------
// Harness Setup
// ----------------------------------------------------------------------
const harness = createBrowserHarness({
  assetBaseUrl: '/workers',
});

const disposeHarness = (): void => {
  harness.dispose();
};

if (typeof window !== 'undefined') {
  window.addEventListener('beforeunload', disposeHarness);
}

if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    disposeHarness();
  });
}

// ----------------------------------------------------------------------
// DOM Elements
// ----------------------------------------------------------------------
const languageSelect = document.querySelector<HTMLSelectElement>('#language')!;
const functionNameInput = document.querySelector<HTMLInputElement>('#function-name')!;
const runButton = document.querySelector<HTMLButtonElement>('#run')!;
const traceButton = document.querySelector<HTMLButtonElement>('#trace')!;

const statusOutput = document.querySelector<HTMLDivElement>('#status')!;
const statusDot = document.querySelector<HTMLDivElement>('#status-dot')!;

const executionOutput = document.querySelector<HTMLPreElement>('#execution-output')!;
const traceOutput = document.querySelector<HTMLPreElement>('#trace-output')!;
const consoleEmpty = document.querySelector<HTMLDivElement>('#console-empty')!;
const traceEmpty = document.querySelector<HTMLDivElement>('#trace-empty')!;

const fileExtension = document.querySelector<HTMLSpanElement>('#file-extension')!;

// ----------------------------------------------------------------------
// Initialize Monaco Editors
// ----------------------------------------------------------------------
const editorContainer = document.getElementById('monaco-editor-root')!;
const inputsContainer = document.getElementById('monaco-inputs-root')!;

const codeEditor = monaco.editor.create(editorContainer, {
  value: '',
  language: 'python',
  theme: 'tracecodeDark',
  automaticLayout: true,
  minimap: { enabled: false },
  fontSize: 14,
  fontFamily: 'var(--font-mono)',
  lineHeight: 24,
  roundedSelection: true,
  padding: { top: 16, bottom: 16 },
  scrollBeyondLastLine: false,
});

const inputsEditor = monaco.editor.create(inputsContainer, {
  value: '',
  language: 'json',
  theme: 'tracecodeDark',
  automaticLayout: true,
  minimap: { enabled: false },
  fontSize: 14,
  fontFamily: 'var(--font-mono)',
  lineHeight: 24,
  padding: { top: 16, bottom: 16 },
  scrollBeyondLastLine: false,
});

let activeLanguage: Language = 'python';

// ----------------------------------------------------------------------
// Helper Functions
// ----------------------------------------------------------------------
function renderOutput(targetElement: HTMLPreElement, emptyElement: HTMLDivElement, value: unknown): void {
  emptyElement.style.display = 'none';
  targetElement.style.display = 'block';
  targetElement.textContent = JSON.stringify(value, null, 2);
}

function setStatus(value: string, state: 'idle' | 'active' | 'success' | 'error' = 'idle'): void {
  statusOutput.textContent = value;
  statusDot.className = `status-dot ${state}`;
  
  if (state === 'active') {
    statusOutput.style.color = 'var(--text-main)';
  } else if (state === 'error') {
    statusOutput.style.color = 'var(--error-color)';
  } else if (state === 'success') {
    statusOutput.style.color = 'var(--accent-run)';
  } else {
    statusOutput.style.color = 'var(--text-muted)';
  }
}

function applyExample(language: Language): void {
  activeLanguage = language;
  const example = EXAMPLES[language];
  
  functionNameInput.value = example.functionName;
  
  codeEditor.getModel()?.setValue(example.code);
  monaco.editor.setModelLanguage(codeEditor.getModel()!, getEditorLanguage(language));
  fileExtension.textContent = getExtension(language);
  
  inputsEditor.getModel()?.setValue(JSON.stringify(example.inputs, null, 2));
  
  // Clear outputs
  executionOutput.textContent = '';
  executionOutput.style.display = 'none';
  consoleEmpty.style.display = 'flex';
  
  traceOutput.textContent = '';
  traceOutput.style.display = 'none';
  traceEmpty.style.display = 'flex';
  
  setStatus(`Ready`, 'idle');
}

function readInputs(): Record<string, unknown> {
  try {
    return JSON.parse(inputsEditor.getValue()) as Record<string, unknown>;
  } catch (e) {
    throw new Error('Invalid JSON in Inputs panel.');
  }
}

function focusTab(tabName: string) {
  document.querySelectorAll('.panel-tab').forEach(t => t.classList.remove('active'));
  document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
  
  const tabButton = document.querySelector(`.panel-tab[data-tab="${tabName}"]`);
  if (tabButton) tabButton.classList.add('active');
  
  const tabContent = document.getElementById(`${tabName}-tab-content`);
  if (tabContent) tabContent.classList.add('active');
}

// ----------------------------------------------------------------------
// Actions
// ----------------------------------------------------------------------
async function runCode(): Promise<void> {
  focusTab('console');
  try {
    const inputs = readInputs();
    const code = codeEditor.getValue();
    const fnName = functionNameInput.value;
    const executionStyle = EXAMPLES[activeLanguage].executionStyle ?? 'function';
    
    const client = harness.getClient(activeLanguage);
    setStatus(`Initializing runtime...`, 'active');
    await client.init();

    setStatus(`Executing...`, 'active');
    const result = await client.executeCode(code, fnName, inputs, executionStyle);
    
    renderOutput(executionOutput, consoleEmpty, result);
    setStatus(`Execution complete`, 'success');
  } catch (error) {
    renderOutput(executionOutput, consoleEmpty, {
      error: error instanceof Error ? error.message : String(error),
    });
    setStatus(`Execution failed`, 'error');
  }
}

async function traceCode(): Promise<void> {
  focusTab('trace');
  try {
    const inputs = readInputs();
    const code = codeEditor.getValue();
    const fnName = functionNameInput.value;
    const executionStyle = EXAMPLES[activeLanguage].executionStyle ?? 'function';
    
    const client = harness.getClient(activeLanguage);
    setStatus(`Initializing runtime...`, 'active');
    await client.init();
    
    setStatus(`Tracing...`, 'active');
    const result = await client.executeWithTracing(
      code,
      fnName,
      inputs,
      {
        maxTraceSteps: 200,
        maxLineEvents: 200,
        maxSingleLineHits: 50,
      },
      executionStyle
    );

    renderOutput(traceOutput, traceEmpty, result);
    setStatus(`Trace complete`, 'success');
  } catch (error) {
    renderOutput(traceOutput, traceEmpty, {
      error: error instanceof Error ? error.message : String(error),
    });
    setStatus(`Trace failed`, 'error');
  }
}

// ----------------------------------------------------------------------
// Event Listeners
// ----------------------------------------------------------------------
languageSelect.innerHTML = SUPPORTED_LANGUAGES.map((language) => {
  const label = language === 'csharp' ? 'C#' : language.charAt(0).toUpperCase() + language.slice(1);
  return `<option value="${language}">${label}</option>`;
}).join('');

languageSelect.addEventListener('change', (event) => {
  const nextLanguage = (event.currentTarget as HTMLSelectElement).value as Language;
  applyExample(nextLanguage);
});

runButton.addEventListener('click', runCode);
traceButton.addEventListener('click', traceCode);

// UI Event Listeners
document.querySelectorAll('.panel-tab').forEach(tab => {
  tab.addEventListener('click', (e) => {
    const target = (e.currentTarget as HTMLElement).dataset.tab;
    if (target) focusTab(target);
  });
});

// ----------------------------------------------------------------------
// Boot
// ----------------------------------------------------------------------
applyExample(activeLanguage);
}

if (window.location.pathname.replace(/\/+$/, '') === '/dev') {
  bootDevTerminal().catch((error) => {
    document.body.innerHTML = `<pre class="dev-terminal-error"></pre>`;
    document.querySelector<HTMLPreElement>('.dev-terminal-error')!.textContent =
      error instanceof Error ? error.stack ?? error.message : String(error);
  });
} else {
  bootIde();
}
