import {
  byteEqual,
} from "../internal/encoding";

export class BrowserAssertionError extends Error {
  readonly code = 'ERR_ASSERTION';
  readonly actual: unknown;
  readonly expected: unknown;
  readonly operator: string;
  readonly generatedMessage: boolean;

  constructor(options: { actual?: unknown; expected?: unknown; message?: string; operator?: string } = {}) {
    const operator = options.operator ?? 'fail';
    const generatedMessage = options.message === undefined;
    super(options.message ?? `Assertion failed: ${operator}`);
    this.name = 'AssertionError';
    this.actual = options.actual;
    this.expected = options.expected;
    this.operator = operator;
    this.generatedMessage = generatedMessage;
  }
}

export function browserDeepStrictEqual(left: unknown, right: unknown, seen = new WeakMap<object, object>()): boolean {
  if (Object.is(left, right)) return true;
  if (typeof left !== 'object' || left === null || typeof right !== 'object' || right === null) return false;
  if (Object.getPrototypeOf(left) !== Object.getPrototypeOf(right)) return false;
  const seenRight = seen.get(left);
  if (seenRight) return seenRight === right;
  seen.set(left, right);

  if (left instanceof Date || right instanceof Date) {
    return left instanceof Date && right instanceof Date && Object.is(left.getTime(), right.getTime());
  }
  if (ArrayBuffer.isView(left) || ArrayBuffer.isView(right)) {
    if (!ArrayBuffer.isView(left) || !ArrayBuffer.isView(right)) return false;
    const leftBytes = new Uint8Array(left.buffer, left.byteOffset, left.byteLength);
    const rightBytes = new Uint8Array(right.buffer, right.byteOffset, right.byteLength);
    return byteEqual(leftBytes, rightBytes);
  }
  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) return false;
    return left.every((value, index) => browserDeepStrictEqual(value, right[index], seen));
  }
  if (left instanceof Map || right instanceof Map) {
    if (!(left instanceof Map) || !(right instanceof Map) || left.size !== right.size) return false;
    for (const [key, value] of left.entries()) {
      if (!right.has(key) || !browserDeepStrictEqual(value, right.get(key), seen)) return false;
    }
    return true;
  }
  if (left instanceof Set || right instanceof Set) {
    if (!(left instanceof Set) || !(right instanceof Set) || left.size !== right.size) return false;
    return [...left].every((value) => right.has(value));
  }

  const leftKeys = Reflect.ownKeys(left);
  const rightKeys = Reflect.ownKeys(right);
  if (leftKeys.length !== rightKeys.length) return false;
  return leftKeys.every((key) => (
    Object.prototype.propertyIsEnumerable.call(right, key) &&
    browserDeepStrictEqual((left as Record<PropertyKey, unknown>)[key], (right as Record<PropertyKey, unknown>)[key], seen)
  ));
}

export function createAssertApi() {
  const fail = (message?: string): never => {
    throw new BrowserAssertionError({ message, operator: 'fail' });
  };
  const assert = ((value: unknown, message?: string): asserts value => {
    if (!value) throw new BrowserAssertionError({ actual: value, expected: true, message, operator: '==' });
  }) as ((value: unknown, message?: string) => void) & Record<string, unknown>;
  const strictEqual = (actual: unknown, expected: unknown, message?: string): void => {
    if (!Object.is(actual, expected)) throw new BrowserAssertionError({ actual, expected, message, operator: 'strictEqual' });
  };
  const notStrictEqual = (actual: unknown, expected: unknown, message?: string): void => {
    if (Object.is(actual, expected)) throw new BrowserAssertionError({ actual, expected, message, operator: 'notStrictEqual' });
  };
  const deepStrictEqual = (actual: unknown, expected: unknown, message?: string): void => {
    if (!browserDeepStrictEqual(actual, expected)) throw new BrowserAssertionError({ actual, expected, message, operator: 'deepStrictEqual' });
  };
  const notDeepStrictEqual = (actual: unknown, expected: unknown, message?: string): void => {
    if (browserDeepStrictEqual(actual, expected)) throw new BrowserAssertionError({ actual, expected, message, operator: 'notDeepStrictEqual' });
  };
  const match = (actual: unknown, expected: RegExp, message?: string): void => {
    if (!(expected instanceof RegExp)) throw new TypeError('The "regexp" argument must be an instance of RegExp');
    if (!expected.test(String(actual))) throw new BrowserAssertionError({ actual, expected, message, operator: 'match' });
  };
  const doesNotMatch = (actual: unknown, expected: RegExp, message?: string): void => {
    if (!(expected instanceof RegExp)) throw new TypeError('The "regexp" argument must be an instance of RegExp');
    if (expected.test(String(actual))) throw new BrowserAssertionError({ actual, expected, message, operator: 'doesNotMatch' });
  };
  const throws = (fn: () => unknown, expected?: RegExp | ((error: unknown) => boolean), message?: string): unknown => {
    try {
      fn();
    } catch (error) {
      if (expected instanceof RegExp && !expected.test(error instanceof Error ? error.message : String(error))) {
        throw new BrowserAssertionError({ actual: error, expected, message, operator: 'throws' });
      }
      if (typeof expected === 'function' && !expected(error)) {
        throw new BrowserAssertionError({ actual: error, expected, message, operator: 'throws' });
      }
      return error;
    }
    throw new BrowserAssertionError({ actual: undefined, expected, message, operator: 'throws' });
  };
  const rejects = async (fn: (() => Promise<unknown>) | Promise<unknown>, expected?: RegExp | ((error: unknown) => boolean), message?: string): Promise<unknown> => {
    try {
      await (typeof fn === 'function' ? fn() : fn);
    } catch (error) {
      if (expected instanceof RegExp && !expected.test(error instanceof Error ? error.message : String(error))) {
        throw new BrowserAssertionError({ actual: error, expected, message, operator: 'rejects' });
      }
      if (typeof expected === 'function' && !expected(error)) {
        throw new BrowserAssertionError({ actual: error, expected, message, operator: 'rejects' });
      }
      return error;
    }
    throw new BrowserAssertionError({ actual: undefined, expected, message, operator: 'rejects' });
  };

  Object.assign(assert, {
    AssertionError: BrowserAssertionError,
    fail,
    ok: assert,
    equal: strictEqual,
    notEqual: notStrictEqual,
    strictEqual,
    notStrictEqual,
    deepEqual: deepStrictEqual,
    notDeepEqual: notDeepStrictEqual,
    deepStrictEqual,
    notDeepStrictEqual,
    match,
    doesNotMatch,
    throws,
    rejects,
  });
  return assert;
}
