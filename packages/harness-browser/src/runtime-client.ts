import { getJavaScriptRuntimeClient, getTypeScriptRuntimeClient } from './javascript-runtime-client';
import { getPythonRuntimeClient } from './python-runtime-client';
import type { Language, RuntimeClient } from '../../harness-core/src/runtime-types';

export const SUPPORTED_LANGUAGES: readonly Language[] = ['python', 'javascript', 'typescript'];

export function isLanguageSupported(language: Language): boolean {
  return SUPPORTED_LANGUAGES.includes(language);
}

export function getRuntimeClient(language: Language): RuntimeClient {
  if (language === 'python') {
    return getPythonRuntimeClient();
  }
  if (language === 'javascript') {
    return getJavaScriptRuntimeClient();
  }
  if (language === 'typescript') {
    return getTypeScriptRuntimeClient();
  }

  throw new Error(`Runtime for language \"${language}\" is not implemented yet.`);
}
