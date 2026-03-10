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
};

const getExtension = (lang: Language) => {
  if (lang === 'python') return '.py';
  if (lang === 'javascript') return '.js';
  if (lang === 'typescript') return '.ts';
  return '.txt';
};

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
  monaco.editor.setModelLanguage(codeEditor.getModel()!, language);
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
    
    const client = harness.getClient(activeLanguage);
    setStatus(`Initializing runtime...`, 'active');
    await client.init();

    setStatus(`Executing...`, 'active');
    const result = await client.executeCode(code, fnName, inputs, 'function');
    
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
      'function'
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
  const label = language.charAt(0).toUpperCase() + language.slice(1);
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
