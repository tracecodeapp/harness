export type RuntimeFileEncoding = 'utf8' | 'base64';

export interface RuntimeFile {
  path: string;
  contents: string;
  encoding?: RuntimeFileEncoding;
}

export interface RuntimeFileDeletion {
  path: string;
  deleted: true;
}

export type RuntimeFileChange = RuntimeFile | RuntimeFileDeletion;

export interface RuntimeProjectSnapshot {
  files: RuntimeFile[];
  directories?: string[];
  entrypoint?: string;
  cwd?: string;
}

export interface RuntimeCommandOptions {
  cwd?: string;
  env?: Record<string, string>;
  stdin?: string;
  signal?: AbortSignal;
  args?: string[];
}

export interface RuntimeCommandResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  files?: RuntimeFileChange[];
}

export interface RuntimeWorkspaceStat {
  isFile: boolean;
  isDirectory: boolean;
}

export interface RuntimeWorkspaceRemoveOptions {
  force?: boolean;
  recursive?: boolean;
}

export type RuntimeProjectCommandSource = 'argument' | 'file' | 'stdin';

export interface RuntimeProjectCommandRequest<
  Source extends string = RuntimeProjectCommandSource
> {
  code: string;
  source: Source;
  scriptPath: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
  stdin: string;
  project: RuntimeProjectSnapshot;
  options?: Record<string, unknown>;
}

export type RuntimeProjectCommandRunner<
  Request extends RuntimeProjectCommandRequest<string> = RuntimeProjectCommandRequest
> = (request: Request) => Promise<RuntimeCommandResult>;

export interface RuntimeWorkspace {
  readonly cwd: string;
  writeFile(path: string, contents: string, encoding?: RuntimeFileEncoding): Promise<void>;
  writeFiles(files: readonly RuntimeFile[]): Promise<void>;
  appendFile(path: string, contents: string, encoding?: RuntimeFileEncoding): Promise<void>;
  readFile(path: string, encoding?: RuntimeFileEncoding): Promise<string>;
  exists(path: string): Promise<boolean>;
  stat(path: string): Promise<RuntimeWorkspaceStat>;
  readDir(path?: string): Promise<string[]>;
  mkdir(path: string): Promise<void>;
  copyFile(sourcePath: string, destinationPath: string): Promise<void>;
  moveFile(sourcePath: string, destinationPath: string): Promise<void>;
  deleteFile(path: string): Promise<void>;
  remove(path: string, options?: RuntimeWorkspaceRemoveOptions): Promise<void>;
  runCommand(command: string, options?: RuntimeCommandOptions): Promise<RuntimeCommandResult>;
  snapshot(options?: { entrypoint?: string }): Promise<RuntimeProjectSnapshot>;
  dispose(): void;
}
