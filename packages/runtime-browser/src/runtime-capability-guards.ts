import type {
  LanguageRuntimeProfile,
  RuntimeExecutionLimits,
  RuntimeExecutionStyle,
} from '@tracecode/runtime-contracts';

type RuntimeRequestKind = 'execute' | 'trace';

interface RuntimeRequestSupportOptions {
  request: RuntimeRequestKind;
  executionStyle: RuntimeExecutionStyle;
  functionName?: string | null;
  limits?: RuntimeExecutionLimits;
}

const LIMIT_SUPPORT_FIELDS: ReadonlyArray<{
  limit: keyof RuntimeExecutionLimits;
  support: keyof LanguageRuntimeProfile['capabilities']['execution']['limits'];
}> = [
  { limit: 'wallClockMs', support: 'wallClock' },
  { limit: 'maxLineEvents', support: 'lineEvents' },
  { limit: 'maxSingleLineHits', support: 'singleLineHits' },
  { limit: 'maxCallDepth', support: 'callDepth' },
  { limit: 'maxMemoryBytes', support: 'memory' },
];

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
  return 'execution';
}

export function assertRuntimeRequestSupported(
  profile: LanguageRuntimeProfile,
  options: RuntimeRequestSupportOptions
): void {
  if (options.request === 'trace' && !profile.capabilities.tracing.supported) {
    throw new Error(`Runtime "${profile.language}" does not support tracing.`);
  }

  if (options.limits) {
    for (const { limit, support } of LIMIT_SUPPORT_FIELDS) {
      if (options.limits[limit] !== undefined && !profile.capabilities.execution.limits[support]) {
        throw new Error(`Runtime "${profile.language}" does not support the "${limit}" execution limit.`);
      }
    }
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
