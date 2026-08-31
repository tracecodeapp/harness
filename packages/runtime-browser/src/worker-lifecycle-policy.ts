/**
 * Named lifecycle policies for clean browser execution workers.
 *
 * These policies are orthogonal to the isolation boundary. Both policies
 * retire a worker after its lease exposes it to learner-controlled state.
 * They differ only in whether the durable owner replenishes clean capacity for
 * a later operation.
 */
export const BROWSER_WORKER_LIFECYCLE_POLICIES = [
  'warm-and-retire',
  'retire-only',
] as const;

export type BrowserWorkerLifecyclePolicy =
  (typeof BROWSER_WORKER_LIFECYCLE_POLICIES)[number];

export interface BrowserSafeExecutionOptions {
  /**
   * `warm-and-retire` keeps clean capacity warming between human-paced runs.
   * `retire-only` preserves the same isolation boundary without replenishment.
   */
  readonly workerLifecycle?: BrowserWorkerLifecyclePolicy;
}

export interface ResolvedBrowserWorkerLifecyclePolicy {
  readonly workerLifecycle: BrowserWorkerLifecyclePolicy;
}

function isBrowserWorkerLifecyclePolicy(
  value: unknown
): value is BrowserWorkerLifecyclePolicy {
  return (
    typeof value === 'string' &&
    BROWSER_WORKER_LIFECYCLE_POLICIES.includes(
      value as BrowserWorkerLifecyclePolicy
    )
  );
}

/**
 * Resolves the public policy name once, at the browser-host authority.
 */
export function resolveBrowserWorkerLifecyclePolicy(
  options: BrowserSafeExecutionOptions | undefined
): ResolvedBrowserWorkerLifecyclePolicy {
  const namedPolicy = options?.workerLifecycle;
  if (
    namedPolicy !== undefined &&
    !isBrowserWorkerLifecyclePolicy(namedPolicy)
  ) {
    throw new TypeError(
      `safeExecution.workerLifecycle must be one of ${BROWSER_WORKER_LIFECYCLE_POLICIES.map(
        (policy) => JSON.stringify(policy)
      ).join(', ')}.`
    );
  }
  const workerLifecycle = namedPolicy ?? 'warm-and-retire';
  return Object.freeze({ workerLifecycle });
}
