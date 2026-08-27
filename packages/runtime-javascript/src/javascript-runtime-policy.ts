const ADMITTED_JAVASCRIPT_MODULES = Object.freeze([
  'lodash',
  'lodash.js',
  '@datastructures-js/binary-search-tree',
  '@datastructures-js/deque',
  '@datastructures-js/graph',
  '@datastructures-js/heap',
  '@datastructures-js/linked-list',
  '@datastructures-js/priority-queue',
  '@datastructures-js/queue',
  '@datastructures-js/set',
  '@datastructures-js/stack',
  '@datastructures-js/trie',
] as const);

const JAVASCRIPT_RUNTIME_RESERVED_SELECTOR_WORDS = Object.freeze([
  'await', 'break', 'case', 'catch', 'class', 'const', 'continue', 'debugger',
  'default', 'delete', 'do', 'else', 'enum', 'export', 'extends', 'false',
  'finally', 'for', 'function', 'if', 'import', 'in', 'instanceof', 'new',
  'null', 'return', 'super', 'switch', 'this', 'throw', 'true', 'try',
  'typeof', 'var', 'void', 'while', 'with', 'yield',
] as const);

export const SES_CONSOLE_COMPATIBILITY_REQUIRED =
  'ERR_SES_CONSOLE_BUDGET_REQUIRES_COMPATIBILITY';

export function isAdmittedJavaScriptModule(value: unknown): value is string {
  return typeof value === 'string' &&
    ADMITTED_JAVASCRIPT_MODULES.includes(value as typeof ADMITTED_JAVASCRIPT_MODULES[number]);
}

export function isJavaScriptRuntimeSelectorAllowed(value: unknown): value is string {
  return typeof value === 'string' &&
    /^[A-Za-z_$][0-9A-Za-z_$]*$/u.test(value) &&
    !JAVASCRIPT_RUNTIME_RESERVED_SELECTOR_WORDS.includes(
      value as typeof JAVASCRIPT_RUNTIME_RESERVED_SELECTOR_WORDS[number]
    );
}
