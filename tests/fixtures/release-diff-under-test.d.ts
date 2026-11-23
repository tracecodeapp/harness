// The browser build aliases these modules to the installed package on each side.
declare module 'tracecode-harness-under-test/judge' {
  export const createAlgorithmJudgeBundle: typeof import('../../src/judge').createAlgorithmJudgeBundle;
  export const createBrowserJudgeHost: typeof import('../../src/judge').createBrowserJudgeHost;
}
declare module 'tracecode-harness-under-test/tracekernel' {
  export const getLanguageRuntimeProfile: typeof import('../../src/tracekernel').getLanguageRuntimeProfile;
}
