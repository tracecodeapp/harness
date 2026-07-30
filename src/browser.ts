export * from '../packages/runtime-browser/src/index';

import {
  createBrowserHarness as createProviderBrowserHarness,
  createBrowserRuntimeHost as createProviderBrowserRuntimeHost,
  createBrowserRuntimeProviderRegistry,
  type BrowserHarness,
  type BrowserRuntimeHost,
  type BrowserRuntimeProviderRegistry,
  type CreateBrowserHarnessOptions as ProviderBrowserHarnessOptions,
  type CreateBrowserRuntimeHostOptions as ProviderBrowserRuntimeHostOptions,
} from '../packages/runtime-browser/src/index';
import {
  createPythonBrowserRuntimeProvider,
  type PythonBrowserRuntimeProviderOptions,
} from '../packages/runtime-python/src/browser-runtime-provider';
import {
  createJavaScriptBrowserRuntimeProvider,
} from '../packages/runtime-javascript/src/browser-runtime-provider';
import {
  createJavaBrowserRuntimeProvider,
  type JavaBrowserRuntimeProviderOptions,
} from '../packages/runtime-java/src/browser-runtime-provider';
import {
  createCSharpBrowserRuntimeProvider,
  type CSharpBrowserRuntimeProviderOptions,
} from '../packages/runtime-csharp/src/browser-runtime-provider';
import {
  createCppBrowserRuntimeProvider,
  type CppBrowserRuntimeProviderOptions,
} from '../packages/runtime-cpp/src/browser-runtime-provider';

export type CreateBrowserHarnessOptions = Omit<
  ProviderBrowserHarnessOptions,
  'providerRegistry'
> & {
  providerRegistry?: BrowserRuntimeProviderRegistry;
  python?: PythonBrowserRuntimeProviderOptions;
  java?: JavaBrowserRuntimeProviderOptions;
  csharp?: CSharpBrowserRuntimeProviderOptions;
  cpp?: CppBrowserRuntimeProviderOptions;
};

export type CreateBrowserRuntimeHostOptions = Omit<
  ProviderBrowserRuntimeHostOptions,
  'providerRegistry'
> & {
  providerRegistry?: BrowserRuntimeProviderRegistry;
  python?: PythonBrowserRuntimeProviderOptions;
  java?: JavaBrowserRuntimeProviderOptions;
  csharp?: CSharpBrowserRuntimeProviderOptions;
  cpp?: CppBrowserRuntimeProviderOptions;
};

export interface DefaultBrowserRuntimeProviderOptions {
  python?: PythonBrowserRuntimeProviderOptions;
  java?: JavaBrowserRuntimeProviderOptions;
  csharp?: CSharpBrowserRuntimeProviderOptions;
  cpp?: CppBrowserRuntimeProviderOptions;
}

export function createDefaultBrowserRuntimeProviderRegistry(
  options: DefaultBrowserRuntimeProviderOptions = {}
): BrowserRuntimeProviderRegistry {
  return createBrowserRuntimeProviderRegistry([
    createPythonBrowserRuntimeProvider(options.python),
    createJavaScriptBrowserRuntimeProvider(),
    createJavaBrowserRuntimeProvider(options.java),
    createCSharpBrowserRuntimeProvider(options.csharp),
    createCppBrowserRuntimeProvider(options.cpp),
  ]);
}

/**
 * Creates the prepared-only browser runtime host used by Judge-backed
 * execution. Language clients remain private to their provider leases; callers
 * can prepare programs only through `getPreparedProvider(language)`.
 */
export function createBrowserRuntimeHost(
  options: CreateBrowserRuntimeHostOptions = {}
): BrowserRuntimeHost {
  const {
    providerRegistry,
    python,
    java,
    csharp,
    cpp,
    ...hostOptions
  } = options;
  return createProviderBrowserRuntimeHost({
    ...hostOptions,
    providerRegistry:
      providerRegistry ??
      createDefaultBrowserRuntimeProviderRegistry({
        python,
        java,
        csharp,
        cpp,
      }),
  });
}

/**
 * @deprecated Direct BrowserHarness execution is retained only while existing
 * product integrations migrate to BrowserRuntimeHost and Judge.
 */
export function createBrowserHarness(
  options: CreateBrowserHarnessOptions = {}
): BrowserHarness {
  const {
    providerRegistry,
    python,
    java,
    csharp,
    cpp,
    ...browserOptions
  } = options;
  return createProviderBrowserHarness({
    ...browserOptions,
    providerRegistry:
      providerRegistry ??
      createDefaultBrowserRuntimeProviderRegistry({
        python,
        java,
        csharp,
        cpp,
      }),
  });
}
