/**
 * Test compatibility layer — thin re-exports from Deno standard library
 * with Jest-style mock methods built on top of @std/expect/fn.
 *
 * Why this file exists:
 * - @std/testing/mock spies are NOT recognized by @std/expect matchers
 *   (different symbol systems — they simply don't interoperate)
 * - @std/expect/fn IS recognized but provides no Jest methods
 *   (no mockImplementation, mockReturnValue, mockClear, .mock.calls)
 * - Tests use expect(spy).toHaveBeenCalledWith() AND spy.mock.calls[0]
 *   (~30 call sites), so we need both to work
 *
 * This file adds the Jest convenience methods on top of @std/expect/fn,
 * which handles all call tracking and MOCK_SYMBOL registration natively.
 */

import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  it,
} from "@std/testing/bdd";
import { expect } from "@std/expect";
import { fn as expectFn } from "@std/expect/fn";
import { FakeTime } from "@std/testing/time";

export {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
};

export const test = it;

// ---------------------------------------------------------------------------
// Mock functions — wraps @std/expect/fn with Jest-style convenience methods
// ---------------------------------------------------------------------------

const MOCK_SYMBOL = Symbol.for("@MOCK");

// deno-lint-ignore no-explicit-any
type StdMockCall = { args: any[]; returned?: any; thrown?: any; returns: boolean; throws: boolean };

interface MockFn {
  (...args: unknown[]): unknown;
  mock: {
    calls: unknown[][];
    results: { type: "return" | "throw"; value: unknown }[];
  };
  mockClear(): void;
  mockReset(): void;
  mockRestore?: () => void;
  // deno-lint-ignore no-explicit-any
  mockImplementation(fn: (...args: any[]) => any): MockFn;
  mockReturnValue(value: unknown): MockFn;
  mockResolvedValue(value: unknown): MockFn;
  mockRejectedValue(value: unknown): MockFn;
}

// deno-lint-ignore no-explicit-any
const stdCalls = (f: any): StdMockCall[] => f[MOCK_SYMBOL].calls;

/**
 * Create a mock function backed by @std/expect/fn
 */
// deno-lint-ignore no-explicit-any
export const fn = (impl?: (...args: any[]) => any): MockFn => {
  let implementation = impl ?? (() => undefined);

  // @std/expect/fn handles call tracking and MOCK_SYMBOL registration
  // deno-lint-ignore no-explicit-any
  const mockFn = expectFn((...args: any[]) => implementation(...args)) as unknown as MockFn;

  // .mock.calls / .mock.results — derived from @std/expect's call records
  Object.defineProperty(mockFn, "mock", {
    get: () => ({
      get calls() { return stdCalls(mockFn).map((c) => c.args); },
      get results() {
        return stdCalls(mockFn).map((c) => ({
          type: c.throws ? "throw" as const : "return" as const,
          value: c.throws ? c.thrown : c.returned,
        }));
      },
    }),
    configurable: true,
  });

  mockFn.mockClear = () => { stdCalls(mockFn).length = 0; };
  mockFn.mockReset = () => { stdCalls(mockFn).length = 0; implementation = () => undefined; };
  mockFn.mockImplementation = (fn) => { implementation = fn; return mockFn; };
  mockFn.mockReturnValue = (v) => { implementation = () => v; return mockFn; };
  mockFn.mockResolvedValue = (v) => { implementation = () => Promise.resolve(v); return mockFn; };
  mockFn.mockRejectedValue = (v) => { implementation = () => Promise.reject(v); return mockFn; };

  return mockFn;
};

// ---------------------------------------------------------------------------
// Spy
// ---------------------------------------------------------------------------

interface SpyFn extends MockFn {
  mockRestore(): void;
}

// deno-lint-ignore no-explicit-any
export const spyOn = <T extends Record<string, any>>(
  obj: T,
  method: keyof T,
): SpyFn => {
  const original = obj[method] as (...args: unknown[]) => unknown;
  const mock = fn(original) as SpyFn;

  try {
    Object.defineProperty(obj, method, {
      value: mock,
      writable: true,
      configurable: true,
    });
    mock.mockRestore = () => {
      Object.defineProperty(obj, method, {
        value: original,
        writable: true,
        configurable: true,
      });
    };
  } catch {
    obj[method] = mock as T[keyof T];
    mock.mockRestore = () => {
      obj[method] = original as T[keyof T];
    };
  }

  return mock;
};

// ---------------------------------------------------------------------------
// Fake timers — Deno's FakeTime patches Date, setTimeout, setInterval
// ---------------------------------------------------------------------------

let fakeTimeInstance: FakeTime | null = null;

export const useFakeTimers = (): void => {
  fakeTimeInstance = new FakeTime();
};

export const useRealTimers = (): void => {
  if (fakeTimeInstance) {
    fakeTimeInstance.restore();
    fakeTimeInstance = null;
  }
};

export const setSystemTime = (time: number | Date): void => {
  const target = typeof time === "number" ? time : time.getTime();
  if (fakeTimeInstance) {
    const delta = target - fakeTimeInstance.now;
    if (delta >= 0) {
      fakeTimeInstance.tick(delta);
    } else {
      fakeTimeInstance.restore();
      fakeTimeInstance = new FakeTime(target);
    }
  }
};

export const jest = {
  fn,
  useFakeTimers,
  useRealTimers,
  setSystemTime,
};
