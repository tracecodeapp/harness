import type { Language } from './runtime-capabilities';
import type { RuntimeProgramPreparationCall } from './runtime-calls';

/**
 * @internal Product-owned bounds on one judged (ordinary) answer.
 *
 * Measured on the answer's JSON form as it reaches the page:
 * - `maxBytes`: UTF-8 length of its compact `JSON.stringify` text;
 * - `maxItems`: entries in any one container (array elements, object members,
 *   set values, map entries);
 * - `maxNodes`: JSON values in the whole answer, containers and scalars;
 * - `maxDepth`: container nesting (a scalar root is 0, `[]` and `{}` are 1).
 *
 * An answer over any bound, or one the serializer cannot represent completely
 * (a cycle), is the case's typed `serialization-limit` with no value. No
 * placeholder such as `'<max depth>'` or `'<cycle>'` may reach a judged value.
 * See harness-artifacts C-SEAM-CONTRACT.md.
 */
export interface JudgedOutputPolicy {
  readonly maxBytes: number;
  readonly maxItems: number;
  readonly maxNodes: number;
  readonly maxDepth: number;
}

/** @internal Which bound a refused judged answer crossed. */
export type JudgedOutputLimit = 'byte' | 'item' | 'node' | 'depth' | 'cycle';

/**
 * @internal The ordinary (`code`) prepare call as the Judge composition sends
 * it. Only the composition sets `judgedOutputPolicy`; providers forward it to
 * their worker unchanged and behave as before when it is absent.
 */
export type JudgedPreparationCall = RuntimeProgramPreparationCall & {
  readonly judgedOutputPolicy?: JudgedOutputPolicy;
};

const JUDGED_OUTPUT_BYTES = 8 * 1024 * 1024;

function policy(maxDepth: number): JudgedOutputPolicy {
  return Object.freeze({
    maxBytes: JUDGED_OUTPUT_BYTES,
    maxItems: 250_000,
    maxNodes: 1_000_000,
    maxDepth,
  });
}

/**
 * @internal Product defaults. Python has none in 0.21: its execute serializer
 * keeps its own ceilings (250,000 items, 1,000,000 values), which these match.
 * C++ keeps a deep bound because it returns stated-constraint lists (up to
 * 5,000 nodes) completely today; the others never returned past 48 or 64.
 */
export const JUDGED_OUTPUT_POLICY_DEFAULTS: Readonly<Partial<Record<Language, JudgedOutputPolicy>>> =
  Object.freeze({
    javascript: policy(64),
    typescript: policy(64),
    java: policy(64),
    csharp: policy(64),
    cpp: policy(10_000),
  });

const POLICY_FIELDS = ['maxBytes', 'maxItems', 'maxNodes', 'maxDepth'] as const;

/**
 * @internal The effective policy for `language`: its default, with each field
 * of `lower` applied only when it is a non-negative safe integer below the
 * default. Nothing can raise a bound. `undefined` when the language has no
 * judged-output policy.
 */
export function resolveJudgedOutputPolicy(
  language: Language,
  lower?: unknown
): { readonly policy: JudgedOutputPolicy; readonly lowered: boolean } | undefined {
  const defaults = Object.hasOwn(JUDGED_OUTPUT_POLICY_DEFAULTS, language)
    ? JUDGED_OUTPUT_POLICY_DEFAULTS[language]
    : undefined;
  if (!defaults) return undefined;
  if (lower === null || typeof lower !== 'object') return { policy: defaults, lowered: false };
  const effective: Record<(typeof POLICY_FIELDS)[number], number> = { ...defaults };
  let lowered = false;
  for (const field of POLICY_FIELDS) {
    let value: unknown;
    try {
      const descriptor = Object.getOwnPropertyDescriptor(lower, field);
      value = descriptor && 'value' in descriptor ? descriptor.value : undefined;
    } catch {
      value = undefined;
    }
    if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value < defaults[field]) {
      effective[field] = value;
      lowered = true;
    }
  }
  return { policy: lowered ? Object.freeze(effective) : defaults, lowered };
}
