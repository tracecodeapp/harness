import { LANGUAGE_RUNTIME_INFOS } from './generated/runtime-language-info-data';
import type { Language } from './runtime-types';

export interface RuntimeComponentInfo {
  name: string;
  version?: string;
  label?: string;
  detail?: string;
}

export interface RuntimeLibraryInfo {
  name: string;
  version?: string;
  importName?: string;
  globalName?: string;
  detail?: string;
}

export interface LanguageRuntimeInfo {
  language: Language;
  displayName: string;
  versionLabel: string;
  description: string;
  runtime: RuntimeComponentInfo;
  compiler?: RuntimeComponentInfo;
  engine?: RuntimeComponentInfo;
  standard?: string;
  defaultImports?: readonly string[];
  libraries?: readonly RuntimeLibraryInfo[];
  notes?: readonly string[];
}

export { LANGUAGE_RUNTIME_INFOS };

/** Node.js CLI/API compatibility level exposed by browser project workspaces. */
export const NODE_RUNTIME_COMPAT_VERSION = '22.0.0';

export const SUPPORTED_LANGUAGE_RUNTIME_INFOS: readonly LanguageRuntimeInfo[] = Object.freeze(
  Object.values(LANGUAGE_RUNTIME_INFOS)
);

export function getLanguageRuntimeInfo(language: Language): LanguageRuntimeInfo {
  const info = Object.prototype.hasOwnProperty.call(LANGUAGE_RUNTIME_INFOS, language)
    ? LANGUAGE_RUNTIME_INFOS[language]
    : undefined;
  if (!info) {
    throw new Error(`Runtime info for language "${language}" is not implemented yet.`);
  }
  return info;
}

export function getSupportedLanguageRuntimeInfos(): readonly LanguageRuntimeInfo[] {
  return SUPPORTED_LANGUAGE_RUNTIME_INFOS;
}
