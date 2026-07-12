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
  splitting: false,
  bundle: true,
  banner: {
    js: 'var define = undefined;',
  },
  skipNodeModulesBundle: true,
  noExternal: ['just-bash', 'balanced-match', 'brace-expansion', 'diff', 'fflate', 'minimatch', 'sprintf-js', 'turndown'],
  external: ['typescript'],
} as const;

export const libraryConfig = {
  ...commonConfig,
  external: [...commonConfig.external, '@tracecode/harness-core'],
};
