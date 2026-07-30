import { defineConfig } from 'tsup';
import { libraryConfig } from './tsup.shared';

export default defineConfig({
  ...libraryConfig,
  // TraceKernel is an internal build input that the root package bundles
  // again. Keeping each intermediate entry self-contained prevents esbuild
  // from adding a redundant bare import of its shared interop-helper chunk;
  // that import is correctly removed under sideEffects:false, but produces an
  // ignored-bare-import warning for every downstream bundle.
  splitting: false,
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
