import { getJavaScriptWorkerClient } from './javascript-worker-client';
import { getPyodideWorkerClient } from './pyodide-worker-client';
import { setActiveRuntimeLanguage } from './runtime-language-gate';
import type { Language } from '../../harness-core/src/runtime-types';

/**
 * Ensure only the selected language runtime is allowed in this tab.
 * Inactive workers are terminated immediately to avoid cross-runtime drift.
 */
export function enforceRuntimeWorkerIsolation(language: Language): void {
  setActiveRuntimeLanguage(language);

  if (language === 'python') {
    getJavaScriptWorkerClient().terminate();
    return;
  }

  getPyodideWorkerClient().terminate();
}
