interface BlockedJavaScriptRuntimeSource {
  readonly reason: string;
}

function maskJavaScriptRuntimeStringsAndComments(code: string): string {
  let masked = '';
  for (let index = 0; index < code.length; index += 1) {
    const char = code[index];
    const next = code[index + 1];
    if (char === '"' || char === "'" || char === '`') {
      const quote = char;
      masked += quote;
      index += 1;
      for (; index < code.length; index += 1) {
        const current = code[index];
        masked += current === '\n' ? '\n' : ' ';
        if (current === '\\') {
          index += 1;
          if (index < code.length) masked += code[index] === '\n' ? '\n' : ' ';
          continue;
        }
        if (current === quote) break;
      }
      continue;
    }
    if (char === '/' && next === '/') {
      masked += '  ';
      index += 2;
      for (; index < code.length; index += 1) {
        const current = code[index];
        if (current === '\n') {
          masked += '\n';
          break;
        }
        masked += ' ';
      }
      continue;
    }
    if (char === '/' && next === '*') {
      masked += '  ';
      index += 2;
      for (; index < code.length; index += 1) {
        const current = code[index];
        const following = code[index + 1];
        masked += current === '\n' ? '\n' : ' ';
        if (current === '*' && following === '/') {
          masked += ' ';
          index += 1;
          break;
        }
      }
      continue;
    }
    masked += char;
  }
  return masked;
}

export function blockedJavaScriptRuntimeSource(
  code: string
): BlockedJavaScriptRuntimeSource | undefined {
  const searchableCode = maskJavaScriptRuntimeStringsAndComments(code);
  const blockedPatterns: Array<{ pattern: RegExp; reason: string }> = [
    { pattern: /\bimport\s*\(/, reason: 'dynamic import expressions are not supported by the JavaScript runtime sandbox' },
    { pattern: /\.\s*constructor\b/, reason: 'constructor property access is not supported by the JavaScript runtime sandbox' },
    { pattern: /\b__proto__\b/, reason: '__proto__ access is not supported by the JavaScript runtime sandbox' },
    { pattern: /\bObject\s*\.\s*(getPrototypeOf|getOwnPropertyDescriptor|getOwnPropertyDescriptors|setPrototypeOf|defineProperty|defineProperties)\b/, reason: 'prototype reflection is not supported by the JavaScript runtime sandbox' },
    { pattern: /\bReflect\b/, reason: 'Reflect is not supported by the JavaScript runtime sandbox' },
    { pattern: /\beval\b/, reason: 'eval is not supported by the JavaScript runtime sandbox' },
  ];
  const blocked = blockedPatterns.find(({ pattern }) => pattern.test(searchableCode));
  if (blocked) return { reason: blocked.reason };
  return /\[\s*(["'`])constructor\1\s*\]/.test(code)
    ? { reason: 'constructor property access is not supported by the JavaScript runtime sandbox' }
    : undefined;
}

export function isJavaScriptRuntimeSourceAllowed(code: string): boolean {
  return blockedJavaScriptRuntimeSource(code) === undefined;
}

export function assertJavaScriptRuntimeSourceAllowed(code: string): void {
  const blocked = blockedJavaScriptRuntimeSource(code);
  if (!blocked) return;
  throw Object.assign(
    new Error(`Harness blocked unsupported JavaScript runtime code: ${blocked.reason}`),
    { code: 'ERR_HARNESS_UNSAFE_JAVASCRIPT_RUNTIME' }
  );
}
