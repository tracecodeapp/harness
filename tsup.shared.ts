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
  noExternal: ['just-bash', 'balanced-match', 'brace-expansion', 'diff', 'effect', 'fflate', 'minimatch', 'sprintf-js', 'turndown'],
  external: ['typescript'],
} as const;

export const libraryConfig = {
  ...commonConfig,
  external: [...commonConfig.external, '@tracecode/harness-core'],
};
