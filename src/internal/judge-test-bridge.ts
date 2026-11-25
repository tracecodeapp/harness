import type { Language } from '../../packages/runtime-contracts/src/index';
import type { JudgeScheduleMarker } from '../../packages/runtime-browser/src/browser-runtime-host-internal';
import {
  resolveJudgedOutputPolicy,
  type JudgedOutputPolicy,
} from '../../packages/runtime-contracts/src/judged-output-policy';

type FaultAtPoint = {
  prepare: 'prepare';
  observe: 'runtime' | 'deadline' | 'no-recorder';
  encode: 'encode';
  /** Expire the service watchdog right after this journalled progress. */
  service: 'deadline';
};

type FaultPoint = keyof FaultAtPoint;

type FaultContext = Pick<
  JudgeScheduleMarker,
  'evaluationId' | 'workspaceDigest' | 'generation' | 'caseId' | 'attemptToken'
> & {
  readonly language: Language;
  /** Point `service` only: the progress the coordinator just journalled. */
  readonly caseIndex?: number;
  readonly dispatchGeneration?: number;
  readonly progress?: 'started' | 'finished';
};

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

/**
 * The effective judged-output policy one ordinary prepare carried. Like every
 * journal event it may be read for the binding fields; it belongs to no
 * case, attempt or receipt generation, so those are absent.
 */
export type JudgedOutputPolicyMarker = JudgedOutputPolicyContext & JudgedOutputPolicy & {
  readonly phase: 'judged-output-policy';
  readonly lowered: boolean;
  readonly at: number;
  readonly workspaceDigest?: undefined;
  readonly generation?: undefined;
  readonly caseId?: undefined;
  readonly attemptToken?: undefined;
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

/**
 * The policy the composition puts on one ordinary (code-mode) prepare call:
 * the product default for `language`, lowered only through the trusted page
 * bridge. A bridge that installs the hook also receives the effective policy
 * as a `judged-output-policy` marker. Nothing in a request, a binding or a
 * worker message is consulted.
 */
export function judgedOutputPolicyForPrepare(
  language: Language,
  evaluationId: string,
  bridge: JudgeTestBridge | undefined
): JudgedOutputPolicy | undefined {
  const context = Object.freeze({ language, evaluationId });
  const hook = bridge?.judgedOutputPolicy;
  let lower: unknown;
  if (hook) {
    try { lower = hook(context); } catch { lower = undefined; }
  }
  const resolved = resolveJudgedOutputPolicy(language, lower);
  if (!resolved) return undefined;
  if (bridge && hook) {
    try {
      bridge.onEvent(Object.freeze({
        phase: 'judged-output-policy',
        ...context,
        ...resolved.policy,
        lowered: resolved.lowered,
        at: globalThis.performance.now(),
      }));
    } catch { /* A subscriber cannot disrupt Judge. */ }
  }
  return resolved.policy;
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
