import {
  readRuntimeCommandStdinPipeBytes,
  RUNTIME_PROJECT_MAX_OUTPUT_STREAM_BYTES,
  runtimeCommandStdinPipeClosed,
  runtimeDeviceOutputTarget,
  runtimeKernelDeviceInputRoute,
  runtimeKernelDeviceOutputRoute,
  runtimeProjectTruncateUtf8,
  runtimeProjectUtf8Bytes,
  type RuntimeCommandEventStream,
  type RuntimeCommandOutputEvent,
  type RuntimeCommandResult,
  type RuntimeKernelDevicePath,
  type RuntimeWorkspaceActor,
} from '@tracecode/runtime-core';
import {
  decodeUtf8,
  type RuntimeCommandExecutionContext,
} from './fs-observed';

export interface WorkspaceDeviceIoOptions {
  readonly emitOutput: (
    event: RuntimeCommandOutputEvent,
    context?: RuntimeCommandExecutionContext
  ) => void;
}

/**
 * Routes virtual device input/output and enforces per-stream output budgets.
 *
 * Command contexts remain the source of truth for captured output. This
 * controller only applies device routing and byte-limit policy.
 */
export class WorkspaceDeviceIo {
  constructor(private readonly options: WorkspaceDeviceIoOptions) {}

  read(
    device: RuntimeKernelDevicePath,
    context?: RuntimeCommandExecutionContext
  ): string {
    if (!runtimeKernelDeviceInputRoute(undefined, device)) return '';
    const stdinPipe = context?.stdinPipe;
    if (!stdinPipe) return '';
    let text = '';
    while (true) {
      const chunk = readRuntimeCommandStdinPipeBytes(stdinPipe);
      if (chunk.byteLength > 0) {
        text +=
          decodeUtf8(chunk) ??
          Array.from(chunk, (byte) =>
            String.fromCharCode(byte)
          ).join('');
        continue;
      }
      if (runtimeCommandStdinPipeClosed(stdinPipe)) break;
      break;
    }
    return text;
  }

  write(
    device: RuntimeKernelDevicePath,
    data: string,
    contextOrActor?:
      | RuntimeCommandExecutionContext
      | RuntimeWorkspaceActor
  ): void {
    const route = runtimeKernelDeviceOutputRoute(undefined, device);
    if (!route) {
      if (runtimeDeviceOutputTarget(device) === '/dev/null') return;
      throw new Error(`Kernel device is read-only: ${device}`);
    }
    const commandContext =
      contextOrActor && 'process' in contextOrActor
        ? contextOrActor
        : undefined;
    const actor =
      contextOrActor && 'kind' in contextOrActor
        ? contextOrActor
        : undefined;
    if (commandContext) {
      data = this.captureDeviceOutput(
        commandContext,
        route.stream,
        data
      );
      if (!data) return;
    }
    this.options.emitOutput(
      {
        type: 'output',
        stream: route.stream,
        device: route.outputDevice,
        ...(route.sourceDevice
          ? { sourceDevice: route.sourceDevice }
          : {}),
        data,
        ...(actor ? { actor } : {}),
      },
      commandContext
    );
  }

  captureDeviceOutput(
    context: RuntimeCommandExecutionContext,
    stream: RuntimeCommandEventStream,
    data: string
  ): string {
    const chunk = this.captureCommandOutput(context, stream, data);
    if (stream === 'stdout') context.deviceStdout += chunk;
    if (stream === 'stderr') context.deviceStderr += chunk;
    return chunk;
  }

  captureCommandOutput(
    context: RuntimeCommandExecutionContext,
    stream: RuntimeCommandEventStream,
    data: string
  ): string {
    if (!data || context.truncatedOutputStreams.has(stream)) return '';
    const used = context.outputBytes[stream];
    const remaining = RUNTIME_PROJECT_MAX_OUTPUT_STREAM_BYTES - used;
    const bytes = runtimeProjectUtf8Bytes(data);
    if (bytes <= remaining) {
      context.outputBytes[stream] = used + bytes;
      return data;
    }
    context.truncatedOutputStreams.add(stream);
    const marker =
      `\n[${stream} output truncated after ` +
      `${RUNTIME_PROJECT_MAX_OUTPUT_STREAM_BYTES} bytes]\n`;
    const chunk =
      runtimeProjectTruncateUtf8(data, Math.max(0, remaining)) +
      marker;
    context.outputBytes[stream] =
      RUNTIME_PROJECT_MAX_OUTPUT_STREAM_BYTES +
      runtimeProjectUtf8Bytes(marker);
    return chunk;
  }

  captureReturnedOutput(
    context: RuntimeCommandExecutionContext,
    result: Pick<RuntimeCommandResult, 'stdout' | 'stderr'>
  ): Pick<RuntimeCommandResult, 'stdout' | 'stderr'> {
    return {
      stdout:
        this.captureCommandOutput(
          context,
          'stdout',
          result.stdout
        ) + context.deviceStdout,
      stderr:
        this.captureCommandOutput(
          context,
          'stderr',
          result.stderr
        ) + context.deviceStderr,
    };
  }
}
