export const commonConfig = {
  format: ['esm', 'cjs'],
  dts: {
    compilerOptions: {
      module: 'esnext',
      moduleResolution: 'bundler',
    },
  },
  sourcemap: true,
  clean: true,
  target: 'es2022',
  // Use tsup's format-aware default: split ESM while keeping CommonJS
  // self-contained. Explicit CJS splitting can corrupt generated just-bash code.
  bundle: true,
  banner: {
    js: 'var define = undefined;',
  },
  skipNodeModulesBundle: true,
  // just-bash uses turndown for its HTML-to-Markdown command. Turndown selects
  // Domino when no native DOMParser exists, so both packages must stay inside
  // the published bundle; otherwise clean Node consumers fail at module load.
  noExternal: [
    'just-bash',
    '@mixmark-io/domino',
    'balanced-match',
    'brace-expansion',
    'diff',
    'effect',
    'fflate',
    'minimatch',
    'sprintf-js',
    'turndown',
  ],
  external: ['typescript'],
} as const;

export const libraryConfig = {
  ...commonConfig,
  external: [
    ...commonConfig.external,
    '@tracecode/harness-core',
    '@tracecode/tracekernel',
  ],
};
