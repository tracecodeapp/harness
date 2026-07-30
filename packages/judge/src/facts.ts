export type JudgeFactVerification =
  | 'browser-asserted'
  | 'mux-computed'
  | 'signed';

export interface JudgeFactSubject {
  readonly workspaceDigest: string;
  readonly entrypoint?: string;
}

export interface JudgeFactProducer {
  /**
   * Public producer identity. The current TraceCode producer is
   * `semantic-engine`; implementation-generation labels do not belong here.
   */
  readonly id: string;
  readonly version: string;
}

export interface JudgeFact<Value = unknown> {
  readonly id: string;
  readonly schema: number;
  readonly value: Value;
  readonly subject: JudgeFactSubject;
  readonly producer: JudgeFactProducer;
  readonly verification: JudgeFactVerification;
  readonly confidence?: number;
}

export interface JudgeFactRequirement {
  readonly id: string;
  readonly schema: number;
  readonly producer?: string;
  readonly minimumVerification?: JudgeFactVerification;
  readonly minimumConfidence?: number;
}

const MAX_FACTS = 256;
const MAX_FACT_VALUE_DEPTH = 32;
const MAX_FACT_VALUE_NODES = 8_192;

const verificationRank: Readonly<Record<JudgeFactVerification, number>> =
  Object.freeze({
    'browser-asserted': 0,
    'mux-computed': 1,
    signed: 2,
  });

function boundedString(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim() || value.length > 512) {
    throw new TypeError(`${label} must be a non-empty bounded string.`);
  }
  return value;
}

function assertPortableValue(
  value: unknown,
  state: { nodes: number; seen: WeakSet<object> },
  depth = 0
): void {
  if (depth > MAX_FACT_VALUE_DEPTH) {
    throw new TypeError('Judge fact value exceeds the maximum depth.');
  }
  state.nodes += 1;
  if (state.nodes > MAX_FACT_VALUE_NODES) {
    throw new TypeError('Judge fact value exceeds the maximum size.');
  }
  if (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'boolean'
  ) {
    return;
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new TypeError('Judge fact numeric values must be finite.');
    }
    return;
  }
  if (typeof value !== 'object') {
    throw new TypeError('Judge fact values must be JSON-portable.');
  }
  if (state.seen.has(value)) {
    throw new TypeError('Judge fact values must not contain cycles.');
  }
  state.seen.add(value);
  if (Array.isArray(value)) {
    for (const entry of value) {
      assertPortableValue(entry, state, depth + 1);
    }
  } else {
    for (const [key, entry] of Object.entries(
      value as Record<string, unknown>
    )) {
      if (
        !key ||
        key === '__proto__' ||
        key === 'prototype' ||
        key === 'constructor'
      ) {
        throw new TypeError('Judge fact values contain an unsafe key.');
      }
      assertPortableValue(entry, state, depth + 1);
    }
  }
  state.seen.delete(value);
}

/**
 * Validates semantic and runtime facts before policy evaluation. Facts are
 * portable evidence, not an extension point for executable product objects.
 */
export function assertJudgeFacts(
  value: unknown,
  _workspaceDigest: string
): asserts value is readonly JudgeFact[] {
  if (!Array.isArray(value) || value.length > MAX_FACTS) {
    throw new TypeError('Judge facts must be a bounded array.');
  }
  const ids = new Set<string>();
  for (const entry of value) {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new TypeError('Judge fact must be an object.');
    }
    const fact = entry as Record<string, unknown>;
    const id = boundedString(fact.id, 'Judge fact id');
    if (ids.has(id)) {
      throw new TypeError(`Judge facts contain duplicate id ${JSON.stringify(id)}.`);
    }
    ids.add(id);
    if (!Number.isSafeInteger(fact.schema) || (fact.schema as number) < 1) {
      throw new TypeError(`Judge fact ${JSON.stringify(id)} has invalid schema.`);
    }
    if (
      fact.subject === null ||
      typeof fact.subject !== 'object' ||
      Array.isArray(fact.subject)
    ) {
      throw new TypeError(`Judge fact ${JSON.stringify(id)} has invalid subject.`);
    }
    const subject = fact.subject as Record<string, unknown>;
    boundedString(
      subject.workspaceDigest,
      'Judge fact workspace digest'
    );
    if (subject.entrypoint !== undefined) {
      boundedString(subject.entrypoint, 'Judge fact entrypoint');
    }
    if (
      fact.producer === null ||
      typeof fact.producer !== 'object' ||
      Array.isArray(fact.producer)
    ) {
      throw new TypeError(`Judge fact ${JSON.stringify(id)} has invalid producer.`);
    }
    const producer = fact.producer as Record<string, unknown>;
    boundedString(producer.id, 'Judge fact producer id');
    boundedString(producer.version, 'Judge fact producer version');
    if (
      !['browser-asserted', 'mux-computed', 'signed'].includes(
        fact.verification as string
      )
    ) {
      throw new TypeError(
        `Judge fact ${JSON.stringify(id)} has invalid verification.`
      );
    }
    if (
      fact.confidence !== undefined &&
      (
        typeof fact.confidence !== 'number' ||
        !Number.isFinite(fact.confidence) ||
        fact.confidence < 0 ||
        fact.confidence > 1
      )
    ) {
      throw new TypeError(
        `Judge fact ${JSON.stringify(id)} has invalid confidence.`
      );
    }
    assertPortableValue(
      fact.value,
      { nodes: 0, seen: new WeakSet<object>() }
    );
  }
}

export function judgeFactMeetsRequirement(
  fact: JudgeFact,
  requirement: JudgeFactRequirement,
  workspaceDigest: string
): boolean {
  if (
    fact.id !== requirement.id ||
    fact.schema !== requirement.schema ||
    fact.subject.workspaceDigest !== workspaceDigest
  ) {
    return false;
  }
  if (
    requirement.producer !== undefined &&
    fact.producer.id !== requirement.producer
  ) {
    return false;
  }
  if (
    requirement.minimumVerification !== undefined &&
    verificationRank[fact.verification] <
      verificationRank[requirement.minimumVerification]
  ) {
    return false;
  }
  return (
    requirement.minimumConfidence === undefined ||
    (
      fact.confidence !== undefined &&
      fact.confidence >= requirement.minimumConfidence
    )
  );
}
