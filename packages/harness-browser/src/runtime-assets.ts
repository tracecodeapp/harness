const DEFAULT_ASSET_BASE_URL = '/workers';

export interface BrowserHarnessAssets {
  pythonWorker: string;
  pythonRuntimeCore: string;
  pythonSnippets: string;
  javascriptWorker: string;
  typescriptCompiler: string;
}

export type BrowserHarnessAssetOverrides = Partial<BrowserHarnessAssets>;

export const DEFAULT_BROWSER_HARNESS_ASSET_RELATIVE_PATHS: Readonly<BrowserHarnessAssets> = Object.freeze({
  pythonWorker: 'pyodide-worker.js',
  pythonRuntimeCore: 'pyodide/runtime-core.js',
  pythonSnippets: 'generated-python-harness-snippets.js',
  javascriptWorker: 'javascript-worker.js',
  typescriptCompiler: 'vendor/typescript.js',
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
    typescriptCompiler: resolveAssetPath(
      assetBaseUrl,
      assets.typescriptCompiler ?? DEFAULT_BROWSER_HARNESS_ASSET_RELATIVE_PATHS.typescriptCompiler
    ),
  };
}
