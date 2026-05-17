export * from '../packages/harness-project/src/index';

import {
  createRuntimeWorkspace,
  type CreateRuntimeWorkspaceOptions,
  type JustBashRuntimeWorkspace,
} from '../packages/harness-project/src/index';
import { createNativeCppProjectRunner } from '../packages/harness-cpp/src/project-node';
import { createNativeCSharpProjectRunner } from '../packages/harness-csharp/src/project-node';
import { createNativeJavaProjectRunner } from '../packages/harness-java/src/project-node';
import { createNativeJavaScriptProjectRunner } from '../packages/harness-javascript/src/project-node';
import { createNativePythonProjectRunner } from '../packages/harness-python/src/project-node';

export interface CreateNativeProjectWorkspaceOptions
  extends Omit<
    CreateRuntimeWorkspaceOptions,
    'pythonRunner' | 'nodeRunner' | 'javaRunner' | 'cppRunner' | 'csharpRunner'
  > {
  pythonCommand?: string;
  nodeCommand?: string;
  javacCommand?: string;
  javaCommand?: string;
  cppCompilerCommand?: string;
  dotnetCommand?: string;
  pythonProjectTimeoutMs?: number;
  nodeProjectTimeoutMs?: number;
  javaProjectTimeoutMs?: number;
  cppProjectTimeoutMs?: number;
  csharpProjectTimeoutMs?: number;
  keepNativeTempDirs?: boolean;
}

export async function createNativeProjectWorkspace(
  options: CreateNativeProjectWorkspaceOptions = {}
): Promise<JustBashRuntimeWorkspace> {
  const {
    pythonCommand,
    nodeCommand,
    javacCommand,
    javaCommand,
    cppCompilerCommand,
    dotnetCommand,
    pythonProjectTimeoutMs,
    nodeProjectTimeoutMs,
    javaProjectTimeoutMs,
    cppProjectTimeoutMs,
    csharpProjectTimeoutMs,
    keepNativeTempDirs,
    ...workspaceOptions
  } = options;

  return createRuntimeWorkspace({
    ...workspaceOptions,
    pythonRunner: createNativePythonProjectRunner({
      pythonCommand,
      timeoutMs: pythonProjectTimeoutMs,
      keepTempDir: keepNativeTempDirs,
    }),
    nodeRunner: createNativeJavaScriptProjectRunner({
      nodeCommand,
      timeoutMs: nodeProjectTimeoutMs,
      keepTempDir: keepNativeTempDirs,
    }),
    javaRunner: createNativeJavaProjectRunner({
      javacCommand,
      javaCommand,
      timeoutMs: javaProjectTimeoutMs,
      keepTempDir: keepNativeTempDirs,
    }),
    cppRunner: createNativeCppProjectRunner({
      compilerCommand: cppCompilerCommand,
      timeoutMs: cppProjectTimeoutMs,
      keepTempDir: keepNativeTempDirs,
    }),
    csharpRunner: createNativeCSharpProjectRunner({
      dotnetCommand,
      timeoutMs: csharpProjectTimeoutMs,
      keepTempDir: keepNativeTempDirs,
    }),
  });
}
