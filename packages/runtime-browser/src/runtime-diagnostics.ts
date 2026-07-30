export type RuntimeDiagnosticLevel = 'debug' | 'info' | 'warn' | 'error';

export interface RuntimeDiagnosticEvent {
  schema: 'tracecode.runtime-diagnostic.v1';
  source: 'harness';
  component: string;
  runtime?: string;
  phase: string;
  message: string;
  detail?: unknown;
}

const CONSOLE_METHOD_BY_LEVEL: Record<RuntimeDiagnosticLevel, 'debug' | 'info' | 'warn' | 'error'> = {
  debug: 'debug',
  info: 'info',
  warn: 'warn',
  error: 'error',
};

export function runtimeDiagnosticEvent(params: Omit<RuntimeDiagnosticEvent, 'schema' | 'source'>): RuntimeDiagnosticEvent {
  return {
    schema: 'tracecode.runtime-diagnostic.v1',
    source: 'harness',
    ...params,
  };
}

export function logRuntimeDiagnostic(
  level: RuntimeDiagnosticLevel,
  params: Omit<RuntimeDiagnosticEvent, 'schema' | 'source'>,
  options: { enabled?: boolean } = {}
): void {
  if (options.enabled === false && level !== 'error') {
    return;
  }

  const method = CONSOLE_METHOD_BY_LEVEL[level] ?? 'info';
  console[method]('[TraceRuntime]', runtimeDiagnosticEvent(params));
}
