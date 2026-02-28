/**
 * Test compatibility layer — thin re-exports from Deno standard library
 * with custom mock/spy utilities.
 *
 * BDD functions and expect come from Deno's standard library, giving us
 * proper sanitizeOps/sanitizeResources, working beforeAll/afterAll, and
 * correct assertion semantics (including not.toMatchObject).
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
// Mock functions — @std/expect's fn() only tracks calls via a symbol with
// no Jest methods (mockImplementation, mockReturnValue, mockClear, etc.)
// and no .mock.calls property. Tests use both the Jest API and direct
// .mock.calls access (~30 call sites), so we keep a custom fn/spyOn.
// ---------------------------------------------------------------------------

/** Symbol @std/expect uses to identify mock functions */
const MOCK_SYMBOL = Symbol.for("@MOCK");

/**
 * Mock function type — compatible with @std/expect mock matchers
 */
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

/**
 * Create a mock function
 */
// deno-lint-ignore no-explicit-any
export const fn = (impl?: (...args: any[]) => any): MockFn => {
  let implementation = impl ?? (() => undefined);

  const mock: MockFn["mock"] = {
    calls: [],
    results: [],
  };

  const mockFn = ((...args: unknown[]) => {
    mock.calls.push(args);
    try {
      const result = implementation(...args);
      mock.results.push({ type: "return", value: result });
      return result;
    } catch (e) {
      mock.results.push({ type: "throw", value: e });
      throw e;
    }
  }) as MockFn;

  // @std/expect reads calls via this symbol. Derive from mock.calls/results
  // on access so there's a single source of truth.
  Object.defineProperty(mockFn, MOCK_SYMBOL, {
    get: () => ({
      calls: mock.calls.map((args, i) => ({
        args,
        returned: mock.results[i]?.type === "return" ? mock.results[i].value : undefined,
        thrown: mock.results[i]?.type === "throw" ? mock.results[i].value : undefined,
        timestamp: 0,
        returns: mock.results[i]?.type === "return",
        throws: mock.results[i]?.type === "throw",
      })),
    }),
    configurable: true,
  });

  mockFn.mock = mock;

  mockFn.mockClear = () => {
    mock.calls = [];
    mock.results = [];
  };

  mockFn.mockReset = () => {
    mock.calls = [];
    mock.results = [];
    implementation = () => undefined;
  };

  mockFn.mockImplementation = (fn) => {
    implementation = fn;
    return mockFn;
  };

  mockFn.mockReturnValue = (value) => {
    implementation = () => value;
    return mockFn;
  };

  mockFn.mockResolvedValue = (value) => {
    implementation = () => Promise.resolve(value);
    return mockFn;
  };

  mockFn.mockRejectedValue = (value) => {
    implementation = () => Promise.reject(value);
    return mockFn;
  };

  return mockFn;
};

// ---------------------------------------------------------------------------
// Spy
// ---------------------------------------------------------------------------

/**
 * Extended mock function with restore capability
 */
interface SpyFn extends MockFn {
  mockRestore(): void;
}

/**
 * Spy on an object's method
 * Note: ES module exports cannot be mocked — use dependency injection or
 * integration tests with real implementations (e.g., stripe-mock) instead
 */
// deno-lint-ignore no-explicit-any
export const spyOn = <T extends Record<string, any>>(
  obj: T,
  method: keyof T,
): SpyFn => {
  const original = obj[method] as (...args: unknown[]) => unknown;
  const mock = fn(original) as SpyFn;

  // Try Object.defineProperty first (works for globalThis and some objects)
  // then fall back to direct assignment for plain objects
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
    // Direct assignment for plain objects (will still fail for frozen objects)
    obj[method] = mock as T[keyof T];
    mock.mockRestore = () => {
      obj[method] = original as T[keyof T];
    };
  }

  return mock;
};

// ---------------------------------------------------------------------------
// Fake timers — backed by Deno's FakeTime which patches Date.now,
// setTimeout, setInterval, and queueMicrotask
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
      // Going backwards — recreate FakeTime at the target
      fakeTimeInstance.restore();
      fakeTimeInstance = new FakeTime(target);
    }
  }
};

/**
 * Jest-like jest object
 */
export const jest = {
  fn,
  useFakeTimers,
  useRealTimers,
  setSystemTime,
};
