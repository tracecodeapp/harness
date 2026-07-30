import { defineConfig } from 'tsup';
import { libraryConfig } from './tsup.shared';

export default defineConfig({
  ...libraryConfig,
  // TraceKernel exposes Effect types publicly. Keep Effect external so the
  // application and kernel share one runtime identity.
  noExternal: libraryConfig.noExternal.filter((dependency) => dependency !== 'effect'),
  external: [...libraryConfig.external, 'effect'],
  entry: {
    index: 'packages/tracekernel/src/index.ts',
    workspace: 'packages/tracekernel/src/workspace/index.ts',
    'zlib-browser-shim':
      'packages/tracekernel/src/zlib-browser-shim.ts',
  },
  outDir: 'packages/tracekernel/dist',
});
