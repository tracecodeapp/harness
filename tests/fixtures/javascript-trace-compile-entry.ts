import { createBrowserJudgeHost } from '../../src/judge';
import { runUntracedRouteChecks } from './javascript-untraced-route';
import {
  runTraceCompileMatrix,
  type TraceCompileMatrixOptions,
} from './javascript-trace-compile-matrix';

export async function runInBrowser(selection: Omit<TraceCompileMatrixOptions, 'createHost'>) {
  const createHost: TraceCompileMatrixOptions['createHost'] = (fault) => createBrowserJudgeHost({
    assetBaseUrl: fault ? `/injected/${fault}/workers` : '/workers',
    providers: ['javascript', 'typescript'],
  });
  const routeChecks = await runUntracedRouteChecks(createHost);
  return { routeChecks, ...(await runTraceCompileMatrix({ ...selection, createHost })) };
}
