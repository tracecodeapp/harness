import type {
  Language,
  LanguageRuntimeProfile,
  RuntimeClient,
} from '../../harness-core/src/runtime-types';
import { JavaScriptWorkerClient } from './javascript-worker-client';
import { createJavaScriptRuntimeClient } from './javascript-runtime-client';
import { JavaWorkerClient } from './java-worker-client';
import { createJavaRuntimeClient } from './java-runtime-client';
import { CppWorkerClient } from './cpp-worker-client';
import { createCppRuntimeClient } from './cpp-runtime-client';
import { PyodideWorkerClient } from './pyodide-worker-client';
import { createPythonRuntimeClient } from './python-runtime-client';
import {
  DEFAULT_BROWSER_HARNESS_ASSET_RELATIVE_PATHS,
  resolveBrowserHarnessAssets,
  type BrowserHarnessAssets,
  type BrowserHarnessAssetOverrides,
} from './runtime-assets';
import {
  getLanguageRuntimeProfile,
  getSupportedLanguageProfiles,
  isLanguageSupported,
  SUPPORTED_LANGUAGES,
} from './runtime-profiles';

export interface CreateBrowserHarnessOptions {
  assetBaseUrl?: string;
  assets?: BrowserHarnessAssetOverrides;
  debug?: boolean;
}

export interface BrowserHarness {
  readonly assets: BrowserHarnessAssets;
  readonly supportedLanguages: readonly Language[];
  getClient(language: Language): RuntimeClient;
  getProfile(language: Language): LanguageRuntimeProfile;
  getSupportedLanguageProfiles(): readonly LanguageRuntimeProfile[];
  isLanguageSupported(language: Language): boolean;
  disposeLanguage(language: Language): void;
  dispose(): void;
}

class BrowserHarnessRuntime implements BrowserHarness {
  readonly assets: BrowserHarnessAssets;
  readonly supportedLanguages = SUPPORTED_LANGUAGES;

  private readonly pythonWorkerClient: PyodideWorkerClient;
  private readonly javaScriptWorkerClient: JavaScriptWorkerClient;
  private readonly javaWorkerClient: JavaWorkerClient;
  private readonly cppWorkerClient: CppWorkerClient;
  private readonly clients: Record<Language, RuntimeClient>;

  constructor(options: CreateBrowserHarnessOptions = {}) {
    this.assets = resolveBrowserHarnessAssets(options);
    this.pythonWorkerClient = new PyodideWorkerClient({
      workerUrl: this.assets.pythonWorker,
      debug: options.debug,
    });
    this.javaScriptWorkerClient = new JavaScriptWorkerClient({
      workerUrl: this.assets.javascriptWorker,
      debug: options.debug,
    });
    this.javaWorkerClient = new JavaWorkerClient({
      workerUrl: this.assets.javaWorker,
      debug: options.debug,
    });
    this.cppWorkerClient = new CppWorkerClient({
      workerUrl: this.assets.cppWorker,
      clangWasmUrl: this.assets.cppClangWasm,
      lldWasmUrl: this.assets.cppLldWasm,
      sysrootUrl: this.assets.cppSysroot,
      runtimeHeaderUrl: this.assets.cppRuntimeHeader,
      compilerBundleUrl: this.assets.cppCompilerBundle,
      debug: options.debug,
    });
    this.clients = {
      python: createPythonRuntimeClient(this.pythonWorkerClient),
      javascript: createJavaScriptRuntimeClient('javascript', this.javaScriptWorkerClient),
      typescript: createJavaScriptRuntimeClient('typescript', this.javaScriptWorkerClient),
      java: createJavaRuntimeClient(this.javaWorkerClient),
      cpp: createCppRuntimeClient(this.cppWorkerClient),
    };
  }

  getClient(language: Language): RuntimeClient {
    const client = this.clients[language];
    if (!client) {
      throw new Error(`Runtime for language "${language}" is not implemented yet.`);
    }
    return client;
  }

  getProfile(language: Language): LanguageRuntimeProfile {
    return getLanguageRuntimeProfile(language);
  }

  getSupportedLanguageProfiles(): readonly LanguageRuntimeProfile[] {
    return getSupportedLanguageProfiles();
  }

  isLanguageSupported(language: Language): boolean {
    return isLanguageSupported(language);
  }

  disposeLanguage(language: Language): void {
    if (language === 'python') {
      this.pythonWorkerClient.terminate();
      return;
    }
    if (language === 'java') {
      this.javaWorkerClient.terminate();
      return;
    }
    if (language === 'cpp') {
      this.cppWorkerClient.terminate();
      return;
    }
    this.javaScriptWorkerClient.terminate();
  }

  dispose(): void {
    this.pythonWorkerClient.terminate();
    this.javaScriptWorkerClient.terminate();
    this.javaWorkerClient.terminate();
    this.cppWorkerClient.terminate();
  }
}

export function createBrowserHarness(options: CreateBrowserHarnessOptions = {}): BrowserHarness {
  return new BrowserHarnessRuntime(options);
}

export {
  DEFAULT_BROWSER_HARNESS_ASSET_RELATIVE_PATHS,
  resolveBrowserHarnessAssets,
  type BrowserHarnessAssets,
  type BrowserHarnessAssetOverrides,
};
