import type { Language } from '../../harness-core/src/runtime-types';

export type RuntimeWorkerFamily = 'python' | 'javascript';

const LANGUAGE_STORAGE_KEY = 'tracecode-language';

let activeRuntimeLanguage: Language | null = null;

function isLanguage(value: unknown): value is Language {
  return value === 'python' || value === 'javascript' || value === 'typescript';
}

function readPersistedLanguage(): Language | null {
  if (typeof window === 'undefined') {
    return null;
  }

  const raw = window.localStorage.getItem(LANGUAGE_STORAGE_KEY);
  if (!raw) {
    return null;
  }

  try {
    const parsed = JSON.parse(raw) as unknown;

    if (isLanguage(parsed)) {
      return parsed;
    }

    if (typeof parsed === 'object' && parsed !== null) {
      const record = parsed as {
        selectedLanguage?: unknown;
        state?: { selectedLanguage?: unknown };
      };

      if (isLanguage(record.selectedLanguage)) {
        return record.selectedLanguage;
      }

      if (record.state && isLanguage(record.state.selectedLanguage)) {
        return record.state.selectedLanguage;
      }
    }
  } catch {
    return null;
  }

  return null;
}

export function setActiveRuntimeLanguage(language: Language): void {
  activeRuntimeLanguage = language;
}

export function clearActiveRuntimeLanguage(): void {
  activeRuntimeLanguage = null;
}

export function getActiveRuntimeLanguage(): Language | null {
  return activeRuntimeLanguage ?? readPersistedLanguage();
}

function isFamilyAllowed(language: Language, family: RuntimeWorkerFamily): boolean {
  if (family === 'python') {
    return language === 'python';
  }
  return language === 'javascript' || language === 'typescript';
}

export function assertWorkerFamilyAllowed(family: RuntimeWorkerFamily): void {
  const activeLanguage = getActiveRuntimeLanguage();
  if (!activeLanguage) {
    throw new Error('Runtime language is not hydrated yet. Wait for language initialization before loading workers.');
  }
  if (isFamilyAllowed(activeLanguage, family)) {
    return;
  }

  const workerLabel = family === 'python' ? 'Python (Pyodide)' : 'JavaScript/TypeScript';
  throw new Error(
    `${workerLabel} worker is disabled while active language is "${activeLanguage}". Switch languages to use this runtime.`
  );
}
