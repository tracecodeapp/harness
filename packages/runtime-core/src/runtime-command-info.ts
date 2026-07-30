import { RUNTIME_COMMAND_VERSIONS } from './generated/runtime-language-info-data';

/**
 * CLI identities exposed by TraceKernel's runtime command shims.
 *
 * These are intentionally separate from `LanguageRuntimeInfo`: the latter is
 * a provider-neutral product contract, while commands such as `dotnet
 * --version` must identify the concrete toolchain shipped by the harness.
 */
export type RuntimeCommandName = 'dotnet';

export function getRuntimeCommandVersion(command: RuntimeCommandName): string {
  const version = Object.prototype.hasOwnProperty.call(RUNTIME_COMMAND_VERSIONS, command)
    ? RUNTIME_COMMAND_VERSIONS[command]
    : undefined;
  if (!version) {
    throw new Error(`Runtime command version for "${command}" is not implemented yet.`);
  }
  return version;
}
