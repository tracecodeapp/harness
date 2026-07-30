import {
  createTypeScriptProjectRunner,
  type TypeScriptProjectCompiler,
} from "../typescript-project";

import {
  BrowserTypeScriptProjectRunnerOptions,
} from "./contracts";

export {
  createTypeScriptProjectRunner,
  type TypeScriptProjectCommandRequest,
  type TypeScriptProjectCommandResult,
  type TypeScriptProjectCommandRunner,
  type TypeScriptProjectFile,
  type TypeScriptProjectFileEncoding,
  type TypeScriptProjectRunnerOptions,
  type TypeScriptProjectSnapshot,
} from '../typescript-project';

const browserTypeScriptCompilerPromises = new Map<string, Promise<TypeScriptProjectCompiler>>();

const DEFAULT_BROWSER_TYPESCRIPT_COMPILER_URL = 'workers/vendor/typescript.js';

const DOM_TYPESCRIPT_COMPILER_SCRIPT_PROTOCOLS = new Set(['http:', 'https:', 'file:']);

function resolveBrowserTypeScriptCompilerScriptUrl(
  compilerUrl: string,
  options: Pick<BrowserTypeScriptProjectRunnerOptions, 'allowExternalDomCompilerScript'>
): string {
  const documentBase = document.baseURI || globalThis.location?.href;
  if (!documentBase) {
    throw new Error('TypeScript compiler DOM script loading requires a document base URL.');
  }

  let pageUrl: URL;
  let scriptUrl: URL;
  try {
    pageUrl = new URL(documentBase);
    scriptUrl = new URL(compilerUrl, pageUrl);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Invalid TypeScript compiler script URL: ${message}`);
  }

  if (!DOM_TYPESCRIPT_COMPILER_SCRIPT_PROTOCOLS.has(scriptUrl.protocol)) {
    throw new Error(`TypeScript compiler DOM script URL must use http, https, or file: ${scriptUrl.protocol}`);
  }
  const sameDocumentScriptScope = pageUrl.protocol === 'file:' || scriptUrl.protocol === 'file:'
    ? pageUrl.protocol === scriptUrl.protocol && scriptUrl.href.startsWith(new URL('.', pageUrl).href)
    : scriptUrl.origin === pageUrl.origin;
  if (!sameDocumentScriptScope && options.allowExternalDomCompilerScript !== true) {
    throw new Error('External TypeScript compiler DOM script URLs require allowExternalDomCompilerScript.');
  }
  return scriptUrl.href;
}

async function loadBrowserTypeScriptCompiler(
  compilerUrl = DEFAULT_BROWSER_TYPESCRIPT_COMPILER_URL,
  options: Pick<BrowserTypeScriptProjectRunnerOptions, 'allowDomCompilerScript' | 'allowExternalDomCompilerScript'> = {}
): Promise<TypeScriptProjectCompiler> {
  const globalRecord = globalThis as typeof globalThis & { ts?: TypeScriptProjectCompiler };
  if (globalRecord.ts) return globalRecord.ts;
  if (typeof document === 'undefined') {
    const dynamicImport = new Function('specifier', 'return import(specifier)') as (
      specifier: string
    ) => Promise<TypeScriptProjectCompiler>;
    return dynamicImport('typescript');
  }
  if (options.allowDomCompilerScript !== true) {
    throw new Error('TypeScript project compile in the browser requires a trusted compiler object or a worker-backed compiler.');
  }
  const trustedCompilerUrl = resolveBrowserTypeScriptCompilerScriptUrl(compilerUrl, options);
  let compilerPromise = browserTypeScriptCompilerPromises.get(trustedCompilerUrl);
  if (!compilerPromise) {
    compilerPromise = new Promise<TypeScriptProjectCompiler>((resolve, reject) => {
      const script = document.createElement('script');
      script.src = trustedCompilerUrl;
      script.async = true;
      script.onload = () => {
        if (globalRecord.ts) {
          resolve(globalRecord.ts);
        } else {
          reject(new Error(`TypeScript compiler did not initialize from ${trustedCompilerUrl}`));
        }
      };
      script.onerror = () => {
        reject(new Error(`Failed to load TypeScript compiler from ${trustedCompilerUrl}`));
      };
      document.head.appendChild(script);
    });
    browserTypeScriptCompilerPromises.set(trustedCompilerUrl, compilerPromise);
    void compilerPromise.catch(() => {
      if (browserTypeScriptCompilerPromises.get(trustedCompilerUrl) === compilerPromise) {
        browserTypeScriptCompilerPromises.delete(trustedCompilerUrl);
      }
    });
  }
  return compilerPromise;
}

export function createBrowserTypeScriptProjectRunner(
  options: BrowserTypeScriptProjectRunnerOptions = {}
) {
  let compilerPromise: Promise<TypeScriptProjectCompiler> | null = null;
  const loadCompiler = (): Promise<TypeScriptProjectCompiler> => {
    if (compilerPromise) return compilerPromise;
    const attempt = (async () => {
      await options.compilerPreflight?.();
      return loadBrowserTypeScriptCompiler(options.compilerUrl, {
        allowDomCompilerScript: options.allowDomCompilerScript,
        allowExternalDomCompilerScript: options.allowExternalDomCompilerScript,
      });
    })();
    const observed = attempt.catch((error) => {
      if (compilerPromise === observed) compilerPromise = null;
      throw error;
    });
    compilerPromise = observed;
    return observed;
  };
  if (!options.compiler && options.prewarmCompiler) {
    void loadCompiler().catch(() => undefined);
  }
  return createTypeScriptProjectRunner({
    ...(options.compiler ? { compiler: options.compiler } : {}),
    loadCompiler,
  });
}
