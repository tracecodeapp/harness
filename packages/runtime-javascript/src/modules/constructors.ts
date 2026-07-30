

export const AsyncFunction = Object.getPrototypeOf(async function noop() {
  // Intentionally empty.
}).constructor as typeof Function;

export const BrowserFunction = Function;
