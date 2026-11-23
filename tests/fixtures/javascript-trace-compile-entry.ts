import { createBrowserJudgeHost } from '../../src/judge';
import {
  runTraceCompileMatrix,
  type TraceCompileMatrixOptions,
} from './javascript-trace-compile-matrix';

export function runInBrowser(selection: Omit<TraceCompileMatrixOptions, 'createHost'>) {
  return runTraceCompileMatrix({
    ...selection,
    createHost: (fault) => createBrowserJudgeHost({
      assetBaseUrl: fault ? `/injected/${fault}/workers` : '/workers',
      providers: ['javascript', 'typescript'],
    }),
  });
}
