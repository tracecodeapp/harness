export * from '../packages/harness-browser/src/index';

import {
  createBrowserHarness as createProviderBrowserHarness,
  createBrowserRuntimeProviderRegistry,
  type BrowserHarness,
  type BrowserRuntimeProviderRegistry,
  type CreateBrowserHarnessOptions as ProviderBrowserHarnessOptions,
} from '../packages/harness-browser/src/index';
import {
  createPythonBrowserRuntimeProvider,
  type PythonBrowserRuntimeProviderOptions,
} from '../packages/harness-python/src/index';
import {
  createJavaScriptBrowserRuntimeProvider,
} from '../packages/harness-javascript/src/index';
import {
  createJavaBrowserRuntimeProvider,
  type JavaBrowserRuntimeProviderOptions,
} from '../packages/harness-java/src/index';
import {
  createCSharpBrowserRuntimeProvider,
  type CSharpBrowserRuntimeProviderOptions,
} from '../packages/harness-csharp/src/index';
import {
  createCppBrowserRuntimeProvider,
  type CppBrowserRuntimeProviderOptions,
} from '../packages/harness-cpp/src/index';

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
