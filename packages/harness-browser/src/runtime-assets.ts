import type { CppToolchainIntegrityManifest } from './cpp-worker-client';

const DEFAULT_ASSET_BASE_URL = '/workers';

export interface BrowserHarnessAssets {
  pythonWorker: string;
  pythonRuntimeCore: string;
  pythonSnippets: string;
  javascriptWorker: string;
  javascriptProjectWorker: string;
  javaWorker: string;
  csharpWorker: string;
  csharpAssetBaseUrl: string;
  typescriptCompiler: string;
  cppWorker: string;
  cppCompilerFrame: string;
  cppCompilerWorker: string;
  cppClangWasm: string;
  cppLldWasm: string;
  cppSysroot: string;
  cppRuntimeHeader: string;
  cppCompilerBundle: string;
  cppToolchainIntegrity?: CppToolchainIntegrityManifest;
}

export type BrowserHarnessAssetOverrides = Partial<BrowserHarnessAssets>;

export const DEFAULT_BROWSER_HARNESS_ASSET_RELATIVE_PATHS: Readonly<BrowserHarnessAssets> = Object.freeze({
  pythonWorker: 'pyodide-worker.js',
  pythonRuntimeCore: 'pyodide/runtime-core.js',
  pythonSnippets: 'generated-python-harness-snippets.js',
  javascriptWorker: 'javascript-worker.js',
  javascriptProjectWorker: 'javascript-project-worker.js',
  javaWorker: 'java-worker.js',
  csharpWorker: 'csharp-worker.js',
  csharpAssetBaseUrl: 'vendor/csharp',
  typescriptCompiler: 'vendor/typescript.js',
  cppWorker: 'cpp-worker.js',
  cppCompilerFrame: 'cpp-compiler-frame.html',
  cppCompilerWorker: 'cpp-compiler-worker.js',
  cppClangWasm: '',
  cppLldWasm: '',
  cppSysroot: '',
  cppRuntimeHeader: 'cpp/tracecode_runtime.hpp',
  cppCompilerBundle: 'vendor/cpp/yowasp/bundle.js',
});

function isExplicitAssetPath(pathname: string): boolean {
  return (
    pathname.startsWith('/') ||
    pathname.startsWith('./') ||
    pathname.startsWith('../') ||
    pathname.startsWith('http://') ||
    pathname.startsWith('https://') ||
    pathname.startsWith('data:') ||
    pathname.startsWith('blob:')
  );
}

function stripTrailingSlash(value: string): string {
  return value.replace(/\/+$/, '');
}

function trimLeadingSlash(value: string): string {
  return value.replace(/^\/+/, '');
}

function resolveAssetPath(baseUrl: string, pathname: string): string {
  if (pathname === '') {
    return '';
  }
  if (isExplicitAssetPath(pathname)) {
    return pathname;
  }
  const normalizedBase = stripTrailingSlash(baseUrl || DEFAULT_ASSET_BASE_URL);
  const normalizedPath = trimLeadingSlash(pathname);
  return `${normalizedBase}/${normalizedPath}`;
}

export function resolveBrowserHarnessAssets(options: {
  assetBaseUrl?: string;
  assets?: BrowserHarnessAssetOverrides;
} = {}): BrowserHarnessAssets {
  const assetBaseUrl = options.assetBaseUrl ?? DEFAULT_ASSET_BASE_URL;
  const assets = options.assets ?? {};
  return {
    pythonWorker: resolveAssetPath(assetBaseUrl, assets.pythonWorker ?? DEFAULT_BROWSER_HARNESS_ASSET_RELATIVE_PATHS.pythonWorker),
    pythonRuntimeCore: resolveAssetPath(
      assetBaseUrl,
      assets.pythonRuntimeCore ?? DEFAULT_BROWSER_HARNESS_ASSET_RELATIVE_PATHS.pythonRuntimeCore
    ),
    pythonSnippets: resolveAssetPath(assetBaseUrl, assets.pythonSnippets ?? DEFAULT_BROWSER_HARNESS_ASSET_RELATIVE_PATHS.pythonSnippets),
    javascriptWorker: resolveAssetPath(
      assetBaseUrl,
      assets.javascriptWorker ?? DEFAULT_BROWSER_HARNESS_ASSET_RELATIVE_PATHS.javascriptWorker
    ),
    javascriptProjectWorker: resolveAssetPath(
      assetBaseUrl,
      assets.javascriptProjectWorker ?? DEFAULT_BROWSER_HARNESS_ASSET_RELATIVE_PATHS.javascriptProjectWorker
    ),
    javaWorker: resolveAssetPath(assetBaseUrl, assets.javaWorker ?? DEFAULT_BROWSER_HARNESS_ASSET_RELATIVE_PATHS.javaWorker),
    csharpWorker: resolveAssetPath(assetBaseUrl, assets.csharpWorker ?? DEFAULT_BROWSER_HARNESS_ASSET_RELATIVE_PATHS.csharpWorker),
    csharpAssetBaseUrl: resolveAssetPath(
      assetBaseUrl,
      assets.csharpAssetBaseUrl ?? DEFAULT_BROWSER_HARNESS_ASSET_RELATIVE_PATHS.csharpAssetBaseUrl
    ),
    typescriptCompiler: resolveAssetPath(
      assetBaseUrl,
      assets.typescriptCompiler ?? DEFAULT_BROWSER_HARNESS_ASSET_RELATIVE_PATHS.typescriptCompiler
    ),
    cppWorker: resolveAssetPath(assetBaseUrl, assets.cppWorker ?? DEFAULT_BROWSER_HARNESS_ASSET_RELATIVE_PATHS.cppWorker),
    cppCompilerFrame: resolveAssetPath(
      assetBaseUrl,
      assets.cppCompilerFrame ?? DEFAULT_BROWSER_HARNESS_ASSET_RELATIVE_PATHS.cppCompilerFrame
    ),
    cppCompilerWorker: resolveAssetPath(
      assetBaseUrl,
      assets.cppCompilerWorker ?? DEFAULT_BROWSER_HARNESS_ASSET_RELATIVE_PATHS.cppCompilerWorker
    ),
    cppClangWasm: resolveAssetPath(assetBaseUrl, assets.cppClangWasm ?? DEFAULT_BROWSER_HARNESS_ASSET_RELATIVE_PATHS.cppClangWasm),
    cppLldWasm: resolveAssetPath(assetBaseUrl, assets.cppLldWasm ?? DEFAULT_BROWSER_HARNESS_ASSET_RELATIVE_PATHS.cppLldWasm),
    cppSysroot: resolveAssetPath(assetBaseUrl, assets.cppSysroot ?? DEFAULT_BROWSER_HARNESS_ASSET_RELATIVE_PATHS.cppSysroot),
    cppRuntimeHeader: resolveAssetPath(
      assetBaseUrl,
      assets.cppRuntimeHeader ?? DEFAULT_BROWSER_HARNESS_ASSET_RELATIVE_PATHS.cppRuntimeHeader
    ),
    cppCompilerBundle: resolveAssetPath(
      assetBaseUrl,
      assets.cppCompilerBundle ?? DEFAULT_BROWSER_HARNESS_ASSET_RELATIVE_PATHS.cppCompilerBundle
    ),
    ...(assets.cppToolchainIntegrity ? { cppToolchainIntegrity: assets.cppToolchainIntegrity } : {}),
  };
}
