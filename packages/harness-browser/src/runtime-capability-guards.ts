import type {
  LanguageRuntimeProfile,
  RuntimeExecutionStyle,
} from '../../harness-core/src/runtime-types';

type RuntimeRequestKind = 'execute' | 'trace' | 'interview';

interface RuntimeRequestSupportOptions {
  request: RuntimeRequestKind;
  executionStyle: RuntimeExecutionStyle;
  functionName?: string | null;
}

function isScriptRequest(functionName: string | null | undefined): boolean {
  if (functionName == null) return true;
  return functionName.trim().length === 0;
}

function executionStyleLabel(executionStyle: RuntimeExecutionStyle): string {
  if (executionStyle === 'solution-method') return 'solution-method';
  if (executionStyle === 'ops-class') return 'ops-class';
  return 'function';
}

function isExecutionStyleSupported(
  profile: LanguageRuntimeProfile,
  executionStyle: RuntimeExecutionStyle
): boolean {
  const styles = profile.capabilities.execution.styles;
  if (executionStyle === 'solution-method') return styles.solutionMethod;
  if (executionStyle === 'ops-class') return styles.opsClass;
  return styles.function;
}

function describeRequest(request: RuntimeRequestKind): string {
  if (request === 'trace') return 'tracing';
  if (request === 'interview') return 'interview execution';
  return 'execution';
}

export function assertRuntimeRequestSupported(
  profile: LanguageRuntimeProfile,
  options: RuntimeRequestSupportOptions
): void {
  if (options.request === 'trace' && !profile.capabilities.tracing.supported) {
    throw new Error(`Runtime "${profile.language}" does not support tracing.`);
  }

  if (options.request === 'interview' && !profile.capabilities.execution.styles.interviewMode) {
    throw new Error(`Runtime "${profile.language}" does not support interview execution.`);
  }

  if (!isExecutionStyleSupported(profile, options.executionStyle)) {
    throw new Error(
      `Runtime "${profile.language}" does not support execution style "${executionStyleLabel(options.executionStyle)}".`
    );
  }

  if (isScriptRequest(options.functionName) && !profile.capabilities.execution.styles.script) {
    throw new Error(`Runtime "${profile.language}" does not support script mode ${describeRequest(options.request)}.`);
  }
}
