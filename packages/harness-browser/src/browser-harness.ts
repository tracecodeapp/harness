import type {
  Language,
  LanguageRuntimeProfile,
  RuntimeClient,
} from '@tracecode/harness-core';
import type { LanguageRuntimeInfo } from '@tracecode/harness-core';
import {
  getLanguageRuntimeInfo,
  getSupportedLanguageRuntimeInfos,
} from '@tracecode/harness-core';
import { JavaScriptWorkerClient } from './javascript-worker-client';
import { createJavaScriptRuntimeClient } from './javascript-runtime-client';
import { createBrowserJavaScriptProjectRunner } from '../../harness-javascript/src/project-browser';
import { JavaWorkerClient } from './java-worker-client';
import { createJavaRuntimeClient } from './java-runtime-client';
import { CSharpWorkerClient } from './csharp-worker-client';
import { createCSharpRuntimeClient } from './csharp-runtime-client';
import { CppWorkerClient } from './cpp-worker-client';
import { createCppRuntimeClient } from './cpp-runtime-client';
import { PythonWorkerClient } from './pyodide-worker-client';
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
  java?: {
    workerIdleTimeoutMs?: number;
    externalCompilerUrl?: string;
    cheerpjLoaderUrl?: string;
  };
  csharp?: {
    workerIdleTimeoutMs?: number;
  };
  cpp?: {
    initTimeoutMs?: number;
    executionTimeoutMs?: number;
    tracingTimeoutMs?: number;
    interviewTimeoutMs?: number;
    workerIdleTimeoutMs?: number;
    programCacheLimit?: number;
    usePrecompiledHeader?: boolean;
    externalCompilerUrl?: string;
  };
}

export interface BrowserHarness {
  readonly assets: BrowserHarnessAssets;
  readonly supportedLanguages: readonly Language[];
  getClient(language: Language): RuntimeClient;
  getProfile(language: Language): LanguageRuntimeProfile;
  getSupportedLanguageProfiles(): readonly LanguageRuntimeProfile[];
  getLanguageInfo(language: Language): LanguageRuntimeInfo;
  getSupportedLanguageInfos(): readonly LanguageRuntimeInfo[];
  isLanguageSupported(language: Language): boolean;
  warmLanguage(language: Language): Promise<{ success: boolean; loadTimeMs: number }>;
  disposeLanguage(language: Language): void;
  dispose(): void;
}

class BrowserHarnessRuntime implements BrowserHarness {
  readonly assets: BrowserHarnessAssets;
  readonly supportedLanguages = SUPPORTED_LANGUAGES;

  private readonly pythonWorkerClient: PythonWorkerClient;
  private readonly javaScriptWorkerClient: JavaScriptWorkerClient;
  private readonly javaWorkerClient: JavaWorkerClient;
  private readonly csharpWorkerClient: CSharpWorkerClient;
  private readonly cppWorkerClient: CppWorkerClient;
  private readonly clients: Record<Language, RuntimeClient>;

  constructor(options: CreateBrowserHarnessOptions = {}) {
    this.assets = resolveBrowserHarnessAssets(options);
    this.pythonWorkerClient = new PythonWorkerClient({
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
      workerIdleTimeoutMs: options.java?.workerIdleTimeoutMs,
      externalCompilerUrl: options.java?.externalCompilerUrl,
      cheerpjLoaderUrl: options.java?.cheerpjLoaderUrl,
    });
    this.csharpWorkerClient = new CSharpWorkerClient({
      workerUrl: this.assets.csharpWorker,
      assetBaseUrl: this.assets.csharpAssetBaseUrl,
      debug: options.debug,
      workerIdleTimeoutMs: options.csharp?.workerIdleTimeoutMs,
    });
    this.cppWorkerClient = new CppWorkerClient({
      workerUrl: this.assets.cppWorker,
      compilerFrameUrl: this.assets.cppCompilerFrame,
      compilerWorkerUrl: this.assets.cppCompilerWorker,
      clangWasmUrl: this.assets.cppClangWasm,
      lldWasmUrl: this.assets.cppLldWasm,
      sysrootUrl: this.assets.cppSysroot,
      runtimeHeaderUrl: this.assets.cppRuntimeHeader,
      compilerBundleUrl: this.assets.cppCompilerBundle,
      toolchainIntegrity: this.assets.cppToolchainIntegrity,
      debug: options.debug,
      initTimeoutMs: options.cpp?.initTimeoutMs,
      executionTimeoutMs: options.cpp?.executionTimeoutMs,
      tracingTimeoutMs: options.cpp?.tracingTimeoutMs,
      interviewTimeoutMs: options.cpp?.interviewTimeoutMs,
      workerIdleTimeoutMs: options.cpp?.workerIdleTimeoutMs,
      programCacheLimit: options.cpp?.programCacheLimit,
      usePrecompiledHeader: options.cpp?.usePrecompiledHeader,
      externalCompilerUrl: options.cpp?.externalCompilerUrl,
    });
    this.clients = {
      python: createPythonRuntimeClient(this.pythonWorkerClient),
      javascript: createJavaScriptRuntimeClient('javascript', this.javaScriptWorkerClient, {
        executeProject: createBrowserJavaScriptProjectRunner({
          workerUrl: this.assets.javascriptProjectWorker,
          workerIsolation: 'per-command',
        }),
      }),
      typescript: createJavaScriptRuntimeClient('typescript', this.javaScriptWorkerClient),
      java: createJavaRuntimeClient(this.javaWorkerClient),
      csharp: createCSharpRuntimeClient(this.csharpWorkerClient),
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

  getLanguageInfo(language: Language): LanguageRuntimeInfo {
    return getLanguageRuntimeInfo(language);
  }

  getSupportedLanguageInfos(): readonly LanguageRuntimeInfo[] {
    return getSupportedLanguageRuntimeInfos();
  }

  isLanguageSupported(language: Language): boolean {
    return isLanguageSupported(language);
  }

  warmLanguage(language: Language): Promise<{ success: boolean; loadTimeMs: number }> {
    if (language === 'python') {
      return this.pythonWorkerClient.warmup();
    }
    if (language === 'java') {
      return this.javaWorkerClient.warmup();
    }
    if (language === 'cpp') {
      return this.cppWorkerClient.warmup();
    }
    if (language === 'csharp') {
      return this.csharpWorkerClient.warmup();
    }
    if (language === 'typescript') {
      return this.javaScriptWorkerClient.warmup('typescript');
    }
    return this.getClient(language).init();
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
    if (language === 'csharp') {
      this.csharpWorkerClient.terminate();
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
    this.csharpWorkerClient.terminate();
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
export type {
  CppToolchainIntegrityEntry,
  CppToolchainIntegrityManifest,
} from './cpp-worker-client';
