

export type ModuleRecord = {
  exports: unknown;
  id?: string;
  filename?: string;
  loaded?: boolean;
  parent?: ModuleRecord | null;
  children?: ModuleRecord[];
  path?: string;
  paths?: string[];
  require?: ((specifier: string) => unknown) & {
    cache: Record<string, ModuleRecord>;
    main?: ModuleRecord;
    resolve: (specifier: string) => string;
  };
};

export interface PackageMetadata {
  type?: unknown;
  main?: unknown;
  module?: unknown;
  exports?: unknown;
  dependencies?: unknown;
  devDependencies?: unknown;
  optionalDependencies?: unknown;
  peerDependencies?: unknown;
}

export type PackageResolutionCondition = 'require' | 'import';
