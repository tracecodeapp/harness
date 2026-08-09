export interface EngineRuntimePackageComponent {
  readonly component: 'tracejvm' | 'tracecc';
  readonly packageRoot: string;
  readonly package: Readonly<{ name: string; version: string }>;
  readonly manifest: Readonly<Record<string, unknown>>;
  readonly releaseId: string;
  readonly sourceRoot: string;
  readonly targetPath: string;
  readonly files: readonly Readonly<{
    path: string;
    size: number;
    sha256: string;
    absolute: string;
  }>[];
}

export function loadEngineRuntimePackages(harnessRoot?: string): Promise<Readonly<{
  tracejvm: EngineRuntimePackageComponent;
  tracecc: EngineRuntimePackageComponent;
}>>;

export function installEngineRuntimePackage(
  component: EngineRuntimePackageComponent,
  targetRoot: string
): Promise<string>;
