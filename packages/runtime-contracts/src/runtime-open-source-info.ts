import { LANGUAGE_RUNTIME_OPEN_SOURCE_INFOS } from './generated/runtime-open-source-info-data';
import type { Language } from './runtime-types';

export type RuntimeOpenSourceResourceKind =
  | 'license'
  | 'notices'
  | 'source'
  | 'modifications'
  | 'corresponding-source'
  | 'package';

export interface RuntimeOpenSourceUrlResource {
  kind: RuntimeOpenSourceResourceKind;
  label: string;
  url: string;
  assetPath?: never;
}

/** A path relative to the Harness runtime asset root (normally `/workers`). */
export interface RuntimeOpenSourceAssetResource {
  kind: RuntimeOpenSourceResourceKind;
  label: string;
  assetPath: string;
  url?: never;
}

export type RuntimeOpenSourceResource =
  | RuntimeOpenSourceUrlResource
  | RuntimeOpenSourceAssetResource;

export interface RuntimeOpenSourceComponentInfo {
  name: string;
  version?: string;
  /** SPDX license identifier or expression. */
  license: string;
  detail?: string;
  resources: readonly RuntimeOpenSourceResource[];
}

export interface LanguageRuntimeOpenSourceInfo {
  language: Language;
  components: readonly RuntimeOpenSourceComponentInfo[];
}

export interface ResolvedRuntimeOpenSourceResource {
  kind: RuntimeOpenSourceResourceKind;
  label: string;
  href: string;
}

export interface ResolvedRuntimeOpenSourceComponentInfo
  extends Omit<RuntimeOpenSourceComponentInfo, 'resources'> {
  resources: readonly ResolvedRuntimeOpenSourceResource[];
}

export interface ResolvedLanguageRuntimeOpenSourceInfo {
  language: Language;
  components: readonly ResolvedRuntimeOpenSourceComponentInfo[];
}

export interface RuntimeOpenSourceInfoOptions {
  /** Root under which the package's runtime assets are served. Defaults to `/workers`. */
  assetBaseUrl?: string;
}

export { LANGUAGE_RUNTIME_OPEN_SOURCE_INFOS };

function joinAssetUrl(assetBaseUrl: string, assetPath: string): string {
  const base = assetBaseUrl.replace(/\/+$/, '');
  const path = assetPath.replace(/^\/+/, '');
  return `${base}/${path}`;
}

export function resolveRuntimeOpenSourceResourceHref(
  resource: RuntimeOpenSourceResource,
  options: RuntimeOpenSourceInfoOptions = {}
): string {
  if (typeof resource.url === 'string') return resource.url;
  return joinAssetUrl(options.assetBaseUrl ?? '/workers', resource.assetPath);
}

/**
 * Returns UI-ready open-source metadata for one language runtime.
 *
 * Package-owned legal files are resolved against the same runtime asset root
 * used by the browser providers. Consumers only need to serve that tree; they
 * do not need to understand TraceJVM, TraceCC, Pyodide, or role-specific paths.
 */
export function getLanguageRuntimeOpenSourceInfo(
  language: Language,
  options: RuntimeOpenSourceInfoOptions = {}
): ResolvedLanguageRuntimeOpenSourceInfo {
  const info = Object.prototype.hasOwnProperty.call(LANGUAGE_RUNTIME_OPEN_SOURCE_INFOS, language)
    ? LANGUAGE_RUNTIME_OPEN_SOURCE_INFOS[language]
    : undefined;
  if (!info) {
    throw new Error(`Open-source runtime info for language "${language}" is not implemented yet.`);
  }
  return {
    language: info.language,
    components: info.components.map((component) => ({
      ...component,
      resources: component.resources.map((resource) => ({
        kind: resource.kind,
        label: resource.label,
        href: resolveRuntimeOpenSourceResourceHref(resource, options),
      })),
    })),
  };
}

export function getSupportedLanguageRuntimeOpenSourceInfos(
  options: RuntimeOpenSourceInfoOptions = {}
): readonly ResolvedLanguageRuntimeOpenSourceInfo[] {
  return Object.keys(LANGUAGE_RUNTIME_OPEN_SOURCE_INFOS).map((language) =>
    getLanguageRuntimeOpenSourceInfo(language as Language, options)
  );
}
