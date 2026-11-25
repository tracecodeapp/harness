import type { Language } from '../../packages/runtime-contracts/src/index';
import type { JudgeScheduleMarker } from '../../packages/runtime-browser/src/browser-runtime-host-internal';
import type { JudgedOutputPolicy } from '../../packages/runtime-contracts/src/judged-output-policy';

type FaultAtPoint = {
  prepare: 'prepare';
  observe: 'runtime' | 'deadline' | 'no-recorder';
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

type JudgedOutputPolicyContext = {
  readonly language: Language;
  readonly evaluationId: string;
};

/** The effective judged-output policy one ordinary prepare carried. */
export type JudgedOutputPolicyMarker = JudgedOutputPolicyContext & JudgedOutputPolicy & {
  readonly phase: 'judged-output-policy';
  readonly lowered: boolean;
  readonly at: number;
};

export interface JudgeTestBridge {
  readonly onEvent: (event: JudgeScheduleMarker | InjectionAck | JudgedOutputPolicyMarker) => void;
  readonly faultAt?: (context: FaultContext & { readonly point: FaultPoint }) =>
    FaultAtPoint[FaultPoint] | undefined;
  /**
   * Lower the judged-output policy of one ordinary prepare. Called once per
   * code-mode prepare, in the page realm. A field is used only when it is a
   * non-negative safe integer below the product default.
   */
  readonly judgedOutputPolicy?: (context: JudgedOutputPolicyContext) =>
    Partial<JudgedOutputPolicy> | undefined;
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
  const { onEvent, faultAt, judgedOutputPolicy } = bridge;
  return {
    onEvent(event) {
      try { onEvent(event); } catch { /* A subscriber cannot disrupt Judge. */ }
    },
    ...(typeof faultAt === 'function' ? {
      faultAt(context: Parameters<NonNullable<JudgeTestBridge['faultAt']>>[0]) {
        try { return faultAt(context); } catch { return undefined; }
      },
    } : {}),
    ...(typeof judgedOutputPolicy === 'function' ? {
      judgedOutputPolicy(context: Parameters<NonNullable<JudgeTestBridge['judgedOutputPolicy']>>[0]) {
        // A throwing hook keeps the product defaults.
        try { return judgedOutputPolicy(context); } catch { return undefined; }
      },
    } : {}),
  };
}
