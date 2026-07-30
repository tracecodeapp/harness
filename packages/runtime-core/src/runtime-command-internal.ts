import type {
  RuntimeFile,
  RuntimeFileChange,
  RuntimeSymlink,
} from './runtime-workspace-manifest';

export const RUNTIME_SIGNAL_EXIT_CODES = new Map<string, number>([
  ['SIGHUP', 1],
  ['SIGINT', 2],
  ['SIGQUIT', 3],
  ['SIGKILL', 9],
  ['SIGTERM', 15],
]);

export function runtimeErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function isRuntimeAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}

export function isRuntimeTimeoutError(error: unknown): boolean {
  const message = runtimeErrorMessage(error).toLowerCase();
  return message.includes('timed out') || message.includes('timeout');
}

const textEncoder = new TextEncoder();

export function runtimeFileChangeByteSize(change: RuntimeFileChange): number {
  let size = textEncoder.encode(change.path).byteLength;
  if ((change as RuntimeSymlink).symlink === true) {
    return size + textEncoder.encode((change as RuntimeSymlink).target).byteLength;
  }
  const file = change as RuntimeFile;
  if (file.contents !== undefined) {
    size += file.encoding === 'base64'
      ? Math.ceil(file.contents.length * 3 / 4)
      : textEncoder.encode(file.contents).byteLength;
  }
  return size;
}
