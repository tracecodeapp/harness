

export const AsyncFunction = Object.getPrototypeOf(async function noop() {
  // Intentionally empty.
}).constructor as typeof Function;

export const BrowserFunction = Function;

// Captured before the worker denies the `eval` global to user code, as the
// Function constructor above is; only the module compiler calls it.
export const browserIndirectEval = globalThis.eval as (source: string) => unknown;
