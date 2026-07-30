import type {
  RuntimeCommandEvent,
  RuntimeCommandResult,
  RuntimeKernelHttpBridge,
  RuntimeKernelInfo,
  RuntimeKernelSignalBridge,
  RuntimeKernelSyscallBridge,
  RuntimeProjectCommandRequest,
  RuntimeProjectCommandRunner,
  RuntimeProjectSnapshot,
} from '@tracecode/runtime-core';
import type { CommandContext } from 'just-bash/browser';
import {
  createPackageManagerProjectCommands,
  type NormalizedRuntimePackageManagerConfig,
  type PackageManagerOutputEmitter,
} from './package-manager';
import {
  createCppProjectCommands,
  createCSharpProjectCommands,
  createJavaProjectCommands,
  createNodeProjectCommands,
  createPythonProjectCommands,
  createTypeScriptProjectCommands,
} from './language-commands';
import type {
  RuntimeCommandExecutionContext,
  RuntimeFileChangeObserver,
} from './fs-observed';
import type {
  CreateRuntimeWorkspaceOptions,
  ProjectWorkspaceCommand,
} from './workspace-options';

export interface WorkspaceRuntimeProcessRequest {
  readonly pid: number;
  readonly ppid: number;
  readonly pgid: number;
  readonly sid: number;
  readonly descriptors: readonly number[];
}

export interface WorkspaceRuntimeProcessBinding {
  readonly signal?: AbortSignal;
  readonly kernelSignals?: RuntimeKernelSignalBridge;
  readonly process?: WorkspaceRuntimeProcessRequest;
}

export interface WorkspaceRuntimeRunnerBridgeOptions {
  readonly resolveCommandContext: (
    context?: CommandContext
  ) => RuntimeCommandExecutionContext | undefined;
  readonly bindProcess: (
    context: RuntimeCommandExecutionContext,
    descriptorStdio: boolean
  ) => WorkspaceRuntimeProcessBinding;
  readonly startHostStandardInputPump: (
    context: RuntimeCommandExecutionContext
  ) => void;
  readonly createKernelHttpBridge: (
    context?: RuntimeCommandExecutionContext
  ) => RuntimeKernelHttpBridge;
  readonly createKernelSyscallBridge: (
    context?: RuntimeCommandExecutionContext
  ) => RuntimeKernelSyscallBridge | undefined;
  readonly handleRuntimeCommandEvent: (
    event: RuntimeCommandEvent,
    context?: RuntimeCommandExecutionContext
  ) => void;
  readonly flushRuntimeEventQueue: () => Promise<void>;
}

/**
 * Adapts one language runtime command runner to a TraceKernel process.
 *
 * Process binding, descriptor ownership, and event publication stay
 * host-owned. The adapter only translates the stable runner request/result
 * contract, so every language uses the same lifecycle path.
 */
export function createWorkspaceRuntimeRunnerBridge(
  bridge: WorkspaceRuntimeRunnerBridgeOptions
): <Request extends RuntimeProjectCommandRequest<string>>(
  runner: RuntimeProjectCommandRunner<Request>,
  options?: {
    readonly kernelSyscalls?: boolean;
    readonly descriptorStdio?: boolean;
  }
) => RuntimeProjectCommandRunner<Request> {
  return <Request extends RuntimeProjectCommandRequest<string>>(
    runner: RuntimeProjectCommandRunner<Request>,
    options: {
      readonly kernelSyscalls?: boolean;
      readonly descriptorStdio?: boolean;
    } = {}
  ): RuntimeProjectCommandRunner<Request> => {
    const descriptorStdio =
      options.descriptorStdio === true &&
      runner.capabilities?.descriptorStdio === true;

    return (async (request, ctx?: CommandContext) => {
      const commandContext = bridge.resolveCommandContext(ctx);
      const {
        stdinPipe: _legacyRequestStdinPipe,
        ...requestWithoutLegacyStdin
      } = request;
      const activeStdinPipe =
        request.source !== 'compile' && request.source !== 'stdin'
          ? commandContext?.stdinPipe
          : undefined;
      const stdinPipe = request.stdinPipe ?? activeStdinPipe;
      const processBinding = commandContext
        ? bridge.bindProcess(commandContext, descriptorStdio)
        : {};
      const signal = processBinding.signal ?? request.signal;
      const runtimeIo = commandContext?.runtimeIo;
      let acceptingRunnerEvents = true;
      let result: RuntimeCommandResult;
      const kernelSyscalls = options.kernelSyscalls
        ? bridge.createKernelSyscallBridge(commandContext)
        : undefined;

      if (descriptorStdio && commandContext) {
        bridge.startHostStandardInputPump(commandContext);
      }

      try {
        result = await runner({
          ...(descriptorStdio ? requestWithoutLegacyStdin : request),
          ...(processBinding.process
            ? { process: processBinding.process }
            : {}),
          ...(
            stdinPipe && !descriptorStdio
              ? { stdinPipe: { buffer: stdinPipe.buffer } }
              : {}
          ),
          ...(commandContext?.terminal
            ? { terminal: commandContext.terminal }
            : {}),
          ...(commandContext?.engineLease
            ? { engineLease: commandContext.engineLease }
            : {}),
          ...(signal ? { signal } : {}),
          kernelHttp: bridge.createKernelHttpBridge(commandContext),
          ...(kernelSyscalls ? { kernelSyscalls } : {}),
          ...(processBinding.kernelSignals
            ? { kernelSignals: processBinding.kernelSignals }
            : {}),
          onEvent: (event) => {
            if (!acceptingRunnerEvents) return;
            bridge.handleRuntimeCommandEvent(event, commandContext);
          },
        } as Request);
      } finally {
        acceptingRunnerEvents = false;
        kernelSyscalls?.close();
      }

      if (result.handledSignal && commandContext) {
        commandContext.handledSignal = result.handledSignal;
      }
      // just-bash preserves the standard stdout/stderr/exitCode fields from a
      // custom command but does not retain harness-specific result metadata.
      // Carry structured runner failures on the command context so the outer
      // workspace result can expose them to the host without printing them in
      // the learner's terminal.
      if (result.error && commandContext && !commandContext.kernelError) {
        commandContext.kernelError = result.error;
      }
      if (runtimeIo) {
        await runtimeIo.flush();
        return runtimeIo.filterAppliedResultFiles(
          result
        ) as RuntimeCommandResult;
      }
      await bridge.flushRuntimeEventQueue();
      return result;
    }) as RuntimeProjectCommandRunner<Request>;
  };
}

export interface WorkspaceRuntimeCommandOptions {
  readonly workspace: CreateRuntimeWorkspaceOptions;
  readonly packageManager?: NormalizedRuntimePackageManagerConfig | null;
  readonly cwd: string;
  readonly entrypoint?: string;
  readonly workspaceAlias?: string;
  readonly kernelInfo: RuntimeKernelInfo;
  readonly readonlyFiles?: readonly string[];
  readonly hiddenFiles?: readonly string[];
  readonly withEvents: ReturnType<
    typeof createWorkspaceRuntimeRunnerBridge
  >;
  readonly observeFileChange: RuntimeFileChangeObserver;
  readonly emitPackageManagerOutput: PackageManagerOutputEmitter;
  readonly includeHiddenFiles: (
    context?: CommandContext
  ) => boolean;
  readonly snapshotProject: (
    context: CommandContext,
    includeHiddenFiles: boolean
  ) => Promise<RuntimeProjectSnapshot>;
  readonly recordCppExecutable: (path: string) => void;
}

/**
 * Builds the language and package-manager command set mounted into a
 * workspace shell. Provider-specific command registration belongs here, not
 * in the workspace lifecycle coordinator.
 */
export function createWorkspaceRuntimeCommands(
  options: WorkspaceRuntimeCommandOptions
): ProjectWorkspaceCommand[] {
  const {
    workspace,
    packageManager,
    cwd,
    entrypoint,
    workspaceAlias,
    kernelInfo,
    readonlyFiles,
    hiddenFiles,
    withEvents,
    observeFileChange,
    emitPackageManagerOutput,
    includeHiddenFiles,
    snapshotProject,
    recordCppExecutable,
  } = options;

  return [
    ...(workspace.pythonRunner
      ? createPythonProjectCommands(
          withEvents(workspace.pythonRunner, {
            kernelSyscalls: true,
            descriptorStdio: true,
          }),
          cwd,
          entrypoint,
          observeFileChange,
          workspaceAlias,
          kernelInfo,
          readonlyFiles,
          hiddenFiles,
          includeHiddenFiles,
          snapshotProject
        )
      : []),
    ...(workspace.nodeRunner
      ? createNodeProjectCommands(
          withEvents(workspace.nodeRunner, {
            kernelSyscalls: true,
            descriptorStdio: true,
          }),
          cwd,
          entrypoint,
          observeFileChange,
          workspaceAlias,
          kernelInfo,
          readonlyFiles,
          hiddenFiles,
          includeHiddenFiles,
          snapshotProject
        )
      : []),
    ...(workspace.typescriptRunner
      ? createTypeScriptProjectCommands(
          withEvents(workspace.typescriptRunner),
          cwd,
          entrypoint,
          observeFileChange,
          workspaceAlias,
          kernelInfo,
          readonlyFiles,
          hiddenFiles,
          includeHiddenFiles,
          snapshotProject
        )
      : []),
    ...(packageManager
      ? createPackageManagerProjectCommands(
          packageManager,
          cwd,
          entrypoint,
          observeFileChange,
          workspaceAlias,
          kernelInfo,
          readonlyFiles,
          emitPackageManagerOutput,
          hiddenFiles,
          includeHiddenFiles
        )
      : []),
    ...(workspace.javaRunner
      ? createJavaProjectCommands(
          withEvents(workspace.javaRunner, {
            kernelSyscalls: true,
            descriptorStdio: true,
          }),
          cwd,
          entrypoint,
          observeFileChange,
          workspaceAlias,
          kernelInfo,
          readonlyFiles,
          hiddenFiles,
          includeHiddenFiles,
          snapshotProject
        )
      : []),
    ...(workspace.cppRunner
      ? createCppProjectCommands(
          withEvents(workspace.cppRunner, {
            kernelSyscalls: true,
            descriptorStdio: true,
          }),
          cwd,
          {
            recordExecutablePath: recordCppExecutable,
            entrypoint,
            onFileChange: observeFileChange,
            workspaceAlias,
            kernel: kernelInfo,
            readonlyFiles,
            hiddenFiles,
            includeHiddenFiles,
            snapshotProject,
          }
        )
      : []),
    ...(workspace.csharpRunner
      ? createCSharpProjectCommands(
          withEvents(workspace.csharpRunner, {
            kernelSyscalls: true,
            descriptorStdio: true,
          }),
          cwd,
          entrypoint,
          observeFileChange,
          workspaceAlias,
          kernelInfo,
          readonlyFiles,
          hiddenFiles,
          includeHiddenFiles,
          snapshotProject
        )
      : []),
  ];
}
