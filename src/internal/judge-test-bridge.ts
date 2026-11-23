import type { Language } from '../../packages/runtime-contracts/src/index';
import type { JudgeScheduleMarker } from '../../packages/runtime-browser/src/browser-runtime-host-internal';

type FaultAtPoint = {
  prepare: 'prepare';
  observe: 'runtime' | 'deadline';
  encode: 'encode';
};

type FaultPoint = keyof FaultAtPoint;

type FaultContext = Pick<
  JudgeScheduleMarker,
  'evaluationId' | 'workspaceDigest' | 'generation' | 'caseId' | 'attemptToken'
> & { readonly language: Language };

type InjectionAck = FaultContext & {
  readonly phase: 'injection-ack';
  readonly point: FaultPoint;
  readonly fault: FaultAtPoint[FaultPoint];
  readonly at: number;
};

export interface JudgeTestBridge {
  readonly onEvent: (event: JudgeScheduleMarker | InjectionAck) => void;
  readonly faultAt?: (context: FaultContext & { readonly point: FaultPoint }) =>
    FaultAtPoint[FaultPoint] | undefined;
}

export function readJudgeTestBridge(): JudgeTestBridge | undefined {
  // The page and its execution workers have separate realms. Read the hook
  // only in a Window, and only from an own, non-enumerable data property.
  if (typeof window === 'undefined' || window !== globalThis ||
    typeof document === 'undefined' || document.defaultView !== window) return;
  const descriptor = Object.getOwnPropertyDescriptor(globalThis,
    Symbol.for('@tracecode/harness/internal/judge-test-bridge/v1'));
  if (!descriptor || descriptor.enumerable || !('value' in descriptor)) return;

  const bridge: JudgeTestBridge | undefined = descriptor.value;
  if (typeof bridge?.onEvent !== 'function') return;
  const { onEvent, faultAt } = bridge;
  return {
    onEvent(event) {
      try { onEvent(event); } catch { /* A subscriber cannot disrupt Judge. */ }
    },
    ...(typeof faultAt === 'function' ? {
      faultAt(context: Parameters<NonNullable<JudgeTestBridge['faultAt']>>[0]) {
        try { return faultAt(context); } catch { return undefined; }
      },
    } : {}),
  };
}
