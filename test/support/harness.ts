// Test harness on Node's built-in runner. `expect` is a small wrapper over node:assert that covers the
// matchers this suite uses, so tests read the same without a test framework dependency.

import assert from 'node:assert/strict';
import { after, afterEach, before, beforeEach, describe, it as nodeIt, mock } from 'node:test';
import { format, isDeepStrictEqual } from 'node:util';

export { describe, beforeEach, afterEach };
export const beforeAll = before;
export const afterAll = after;

type TestBody = () => void | Promise<void>;
type EachBody<T extends readonly unknown[]> = (...row: T) => void | Promise<void>;

function each<T extends readonly unknown[]>(rows: readonly T[]) {
  return (name: string, body: EachBody<T>): void => {
    for (const row of rows) nodeIt(format(name, ...row.slice(0, (name.match(/%[sdjo]/g) ?? []).length)), () => body(...row));
  };
}

export const it = Object.assign((name: string, body: TestBody): void => { nodeIt(name, body); }, { each });

// --- Asymmetric matchers ----------------------------------------------------

const ASYMMETRIC = Symbol('asymmetric');
interface Asymmetric { readonly [ASYMMETRIC]: (actual: unknown) => boolean }
const isAsymmetric = (v: unknown): v is Asymmetric => typeof v === 'object' && v !== null && ASYMMETRIC in v;

const TYPE_NAMES = new Map<unknown, string>([[String, 'string'], [Number, 'number'], [Boolean, 'boolean']]);

function any(type: unknown): Asymmetric {
  const primitive = TYPE_NAMES.get(type);
  return {
    [ASYMMETRIC]: (actual) => (primitive ? typeof actual === primitive : actual instanceof (type as new () => unknown)),
  };
}

function objectContaining(shape: Record<string, unknown>): Asymmetric {
  return { [ASYMMETRIC]: (actual) => matches(actual, shape, true) };
}

// --- Equality ---------------------------------------------------------------

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null;

/** Recursive equality. Undefined properties count as absent; `subset` lets `actual` carry extra keys. */
function matches(actual: unknown, expected: unknown, subset: boolean): boolean {
  if (isAsymmetric(expected)) return expected[ASYMMETRIC](actual);
  if (Array.isArray(expected)) {
    return Array.isArray(actual) && actual.length === expected.length && expected.every((e, i) => matches(actual[i], e, subset));
  }
  if (!isObject(expected) || !isObject(actual) || expected instanceof Date || expected instanceof RegExp) {
    return isDeepStrictEqual(actual, expected);
  }
  if (Array.isArray(actual)) return false;
  const defined = (o: Record<string, unknown>): string[] => Object.keys(o).filter((k) => o[k] !== undefined);
  const expectedKeys = defined(expected);
  if (!subset && defined(actual).length !== expectedKeys.length) return false;
  return expectedKeys.every((k) => k in actual && matches(actual[k], expected[k], subset));
}

const show = (v: unknown): string => format('%O', v);

// --- Mock functions ---------------------------------------------------------

interface Spy {
  (...args: unknown[]): unknown;
  readonly mock: { readonly calls: readonly { readonly arguments: readonly unknown[] }[] };
}
const callsOf = (fn: unknown): readonly (readonly unknown[])[] => (fn as Spy).mock.calls.map((c) => c.arguments);

type AnyFn = (...args: never[]) => unknown;

export const vi = {
  fn: (impl?: AnyFn) => mock.fn(impl as (...args: unknown[]) => unknown),
  spyOn<T extends object>(target: T, method: keyof T & string) {
    const spy = mock.method(target, method as never);
    return {
      mockImplementation(impl: AnyFn) {
        spy.mock.mockImplementation(impl as never);
        return this;
      },
    };
  },
  restoreAllMocks: (): void => mock.restoreAll(),
};

// --- expect -----------------------------------------------------------------

function thrownBy(fn: unknown): { threw: boolean; error: unknown } {
  try {
    (fn as () => unknown)();
    return { threw: false, error: undefined };
  } catch (error) {
    return { threw: true, error };
  }
}

type ErrorPattern = string | RegExp | (new (...args: never[]) => Error);

function errorMatches(error: unknown, pattern?: ErrorPattern): boolean {
  if (pattern === undefined) return true;
  if (typeof pattern === 'function') return error instanceof pattern;
  const message = error instanceof Error ? error.message : String(error);
  return typeof pattern === 'string' ? message.includes(pattern) : pattern.test(message);
}

function matchers(actual: unknown, negate: boolean) {
  const check = (pass: boolean, description: string): void => {
    assert.ok(pass !== negate, `expected ${show(actual)} ${negate ? 'not ' : ''}${description}`);
  };
  const size = (): number => (actual as { length: number }).length;
  return {
    toBe: (expected: unknown) => check(Object.is(actual, expected), `to be ${show(expected)}`),
    toEqual: (expected: unknown) => check(matches(actual, expected, false), `to equal ${show(expected)}`),
    toMatchObject: (expected: unknown) => check(matches(actual, expected, true), `to match object ${show(expected)}`),
    toBeNull: () => check(actual === null, 'to be null'),
    toBeUndefined: () => check(actual === undefined, 'to be undefined'),
    toBeDefined: () => check(actual !== undefined, 'to be defined'),
    toBeGreaterThan: (n: number) => check((actual as number) > n, `to be greater than ${n}`),
    toBeGreaterThanOrEqual: (n: number) => check((actual as number) >= n, `to be at least ${n}`),
    toBeLessThan: (n: number) => check((actual as number) < n, `to be less than ${n}`),
    toBeLessThanOrEqual: (n: number) => check((actual as number) <= n, `to be at most ${n}`),
    toHaveLength: (n: number) => check(size() === n, `to have length ${n} (has ${size()})`),
    toContain: (item: unknown) =>
      check(typeof actual === 'string' ? actual.includes(String(item)) : (actual as unknown[]).includes(item), `to contain ${show(item)}`),
    toContainEqual: (item: unknown) => check((actual as unknown[]).some((a) => matches(a, item, false)), `to contain equal ${show(item)}`),
    toMatch: (pattern: RegExp | string) =>
      check(typeof pattern === 'string' ? String(actual).includes(pattern) : pattern.test(String(actual)), `to match ${pattern}`),
    toHaveProperty: (key: string, ...value: unknown[]) => {
      const has = isObject(actual) && key in actual;
      check(has && (value.length === 0 || matches((actual as Record<string, unknown>)[key], value[0], false)), `to have property ${key}`);
    },
    toThrow: (pattern?: ErrorPattern) => {
      const { threw, error } = thrownBy(actual);
      assert.ok((threw && errorMatches(error, pattern)) !== negate, `expected function ${negate ? 'not ' : ''}to throw ${pattern ?? ''}${threw ? ` (threw ${show(error)})` : ''}`);
    },
    toHaveBeenCalled: () => check(callsOf(actual).length > 0, 'to have been called'),
    toHaveBeenCalledOnce: () => check(callsOf(actual).length === 1, `to have been called once (calls: ${callsOf(actual).length})`),
    toHaveBeenCalledWith: (...args: unknown[]) =>
      check(callsOf(actual).some((call) => matches(call, args, false)), `to have been called with ${show(args)}`),
  };
}

type Matchers = ReturnType<typeof matchers>;

export function expect(actual: unknown): Matchers & {
  readonly not: Matchers;
  readonly rejects: { toThrow: (pattern?: ErrorPattern) => Promise<void> };
} {
  return {
    ...matchers(actual, false),
    not: matchers(actual, true),
    rejects: {
      async toThrow(pattern?: ErrorPattern): Promise<void> {
        let rejection: { error: unknown } | null = null;
        try {
          await actual;
        } catch (error) {
          rejection = { error };
        }
        assert.ok(rejection !== null, 'expected promise to reject');
        assert.ok(errorMatches(rejection.error, pattern), `expected rejection to match ${pattern} (got ${show(rejection.error)})`);
      },
    },
  };
}

expect.any = any;
expect.objectContaining = objectContaining;
