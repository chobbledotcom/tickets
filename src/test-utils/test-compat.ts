/**
 * Test compatibility layer for Deno
 * Provides Jest-like API for testing
 */

import {
  assert,
  assertArrayIncludes,
  assertEquals,
  assertExists,
  assertFalse,
  assertInstanceOf,
  assertMatch,
  assertNotEquals,
  assertNotStrictEquals,
  assertRejects,
  assertStrictEquals,
  assertStringIncludes,
  assertThrows,
} from "jsr:@std/assert@1";

type TestFn = () => void | Promise<void>;

interface DescribeContext {
  beforeEach?: TestFn;
  afterEach?: TestFn;
  beforeAll?: TestFn;
  afterAll?: TestFn;
  parent?: DescribeContext;
}

const contextStack: DescribeContext[] = [];

/**
 * Get the current test context
 */
const getCurrentContext = (): DescribeContext => {
  return contextStack[contextStack.length - 1] ?? {};
};

/**
 * Collect hook functions from context chain
 */
const collectHooks = (
  ctx: DescribeContext,
  hookType: "beforeEach" | "afterEach",
): TestFn[] => {
  const hooks: TestFn[] = [];
  let current: DescribeContext | undefined = ctx;
  while (current) {
    const hook = current[hookType];
    if (hook) hooks.push(hook);
    current = current.parent;
  }
  // beforeEach runs parent-to-child (reverse), afterEach runs child-to-parent (as-is)
  return hookType === "beforeEach" ? hooks.reverse() : hooks;
};

/**
 * Jest-like describe block
 */
export const describe = (_name: string, fn: () => void): void => {
  const parent = contextStack[contextStack.length - 1];
  const context: DescribeContext = { parent };
  contextStack.push(context);

  // Execute the describe block to collect tests
  fn();

  contextStack.pop();
};

/**
 * Jest-like test/it function
 */
export const test = (name: string, fn: TestFn): void => {
  const ctx = getCurrentContext();
  const beforeEachChain = collectHooks(ctx, "beforeEach");
  const afterEachChain = collectHooks(ctx, "afterEach");

  Deno.test({
    name,
    fn: async () => {
      for (const beforeFn of beforeEachChain) {
        await beforeFn();
      }
      try {
        await fn();
      } finally {
        for (const afterFn of afterEachChain) {
          await afterFn();
        }
      }
    },
    sanitizeOps: false,
    sanitizeResources: false,
  });
};

export const it = test;

/**
 * Setup function run before each test
 */
export const beforeEach = (fn: TestFn): void => {
  const ctx = getCurrentContext();
  ctx.beforeEach = fn;
};

/**
 * Teardown function run after each test
 */
export const afterEach = (fn: TestFn): void => {
  const ctx = getCurrentContext();
  ctx.afterEach = fn;
};

/**
 * Setup function run before all tests
 */
export const beforeAll = (fn: TestFn): void => {
  const ctx = getCurrentContext();
  ctx.beforeAll = fn;
};

/**
 * Teardown function run after all tests
 */
export const afterAll = (fn: TestFn): void => {
  const ctx = getCurrentContext();
  ctx.afterAll = fn;
};

/**
 * Jest-like expect API
 */
export const expect = <T>(actual: T): ExpectChain<T> => {
  return new ExpectChain(actual);
};

class ExpectChain<T> {
  private actual: T;
  private isNot = false;

  constructor(actual: T) {
    this.actual = actual;
  }

  get not(): ExpectChain<T> {
    this.isNot = !this.isNot;
    return this;
  }

  get resolves(): ExpectChain<T> {
    return this;
  }

  get rejects(): RejectsChain {
    return new RejectsChain(this.actual as Promise<unknown>);
  }

  toBe(expected: T): void {
    if (this.isNot) {
      assertNotStrictEquals(this.actual, expected);
    } else {
      assertStrictEquals(this.actual, expected);
    }
  }

  toEqual(expected: unknown): void {
    if (this.isNot) {
      assertNotEquals(this.actual, expected);
    } else {
      assertEquals(this.actual, expected);
    }
  }

  toStrictEqual(expected: unknown): void {
    if (this.isNot) {
      assertNotStrictEquals(this.actual as unknown, expected);
    } else {
      assertStrictEquals(this.actual as unknown, expected);
    }
  }

  toBeTruthy(): void {
    if (this.isNot) {
      assertFalse(!!this.actual);
    } else {
      assert(!!this.actual);
    }
  }

  toBeFalsy(): void {
    if (this.isNot) {
      assert(!!this.actual);
    } else {
      assertFalse(!!this.actual);
    }
  }

  toBeNull(): void {
    if (this.isNot) {
      assertNotStrictEquals(this.actual, null);
    } else {
      assertStrictEquals(this.actual, null);
    }
  }

  toBeUndefined(): void {
    if (this.isNot) {
      assertNotStrictEquals(this.actual, undefined);
    } else {
      assertStrictEquals(this.actual, undefined);
    }
  }

  toBeDefined(): void {
    if (this.isNot) {
      assertStrictEquals(this.actual, undefined);
    } else {
      assertExists(this.actual);
    }
  }

  toBeNaN(): void {
    const isNaN = Number.isNaN(this.actual);
    if (this.isNot) {
      assertFalse(isNaN);
    } else {
      assert(isNaN);
    }
  }

  private assertNumericComparison(
    compareFn: (actual: number, expected: number) => boolean,
    expected: number,
    message: string,
  ): void {
    const result = compareFn(this.actual as number, expected);
    if (this.isNot) {
      assertFalse(result);
    } else {
      assert(result, message);
    }
  }

  toBeGreaterThan(expected: number): void {
    this.assertNumericComparison(
      (a, e) => a > e,
      expected,
      `Expected ${this.actual} to be greater than ${expected}`,
    );
  }

  toBeGreaterThanOrEqual(expected: number): void {
    this.assertNumericComparison(
      (a, e) => a >= e,
      expected,
      `Expected ${this.actual} to be >= ${expected}`,
    );
  }

  toBeLessThan(expected: number): void {
    this.assertNumericComparison(
      (a, e) => a < e,
      expected,
      `Expected ${this.actual} to be less than ${expected}`,
    );
  }

  toBeLessThanOrEqual(expected: number): void {
    this.assertNumericComparison(
      (a, e) => a <= e,
      expected,
      `Expected ${this.actual} to be <= ${expected}`,
    );
  }

  toContain(expected: unknown): void {
    if (typeof this.actual === "string") {
      if (this.isNot) {
        assertFalse((this.actual as string).includes(expected as string));
      } else {
        assertStringIncludes(this.actual as string, expected as string);
      }
    } else if (Array.isArray(this.actual)) {
      const includes = this.actual.includes(expected);
      if (this.isNot) {
        assertFalse(includes);
      } else {
        assert(includes, `Expected array to contain ${expected}`);
      }
    }
  }

  toContainEqual(expected: unknown): void {
    if (Array.isArray(this.actual)) {
      if (this.isNot) {
        for (const item of this.actual) {
          try {
            assertEquals(item, expected);
            throw new Error(`Expected array not to contain ${JSON.stringify(expected)}`);
          } catch {
            // Expected - item doesn't match
          }
        }
      } else {
        assertArrayIncludes(this.actual, [expected]);
      }
    }
  }

  toHaveLength(expected: number): void {
    const length = (this.actual as { length: number }).length;
    if (this.isNot) {
      assertNotEquals(length, expected);
    } else {
      assertEquals(length, expected);
    }
  }

  toMatch(expected: RegExp | string): void {
    const regex = typeof expected === "string" ? new RegExp(expected) : expected;
    if (this.isNot) {
      assertFalse(regex.test(this.actual as string));
    } else {
      assertMatch(this.actual as string, regex);
    }
  }

  toMatchObject(expected: Record<string, unknown>): void {
    const actual = this.actual as Record<string, unknown>;
    for (const key of Object.keys(expected)) {
      if (this.isNot) {
        try {
          assertEquals(actual[key], expected[key]);
          throw new Error(`Expected objects not to match on key "${key}"`);
        } catch {
          // Expected
        }
      } else {
        assertEquals(actual[key], expected[key], `Mismatch on key "${key}"`);
      }
    }
  }

  toHaveProperty(key: string, value?: unknown): void {
    const actual = this.actual as Record<string, unknown>;
    if (this.isNot) {
      if (value !== undefined) {
        assertFalse(key in actual && actual[key] === value);
      } else {
        assertFalse(key in actual);
      }
    } else {
      assert(key in actual, `Expected object to have property "${key}"`);
      if (value !== undefined) {
        assertEquals(actual[key], value);
      }
    }
  }

  // deno-lint-ignore no-explicit-any
  toBeInstanceOf(expected: new (...args: any[]) => any): void {
    if (this.isNot) {
      assertFalse(this.actual instanceof expected);
    } else {
      assertInstanceOf(this.actual, expected);
    }
  }

  toThrow(expected?: string | RegExp | Error): void {
    const fn = this.actual as () => void;
    if (this.isNot) {
      try {
        fn();
      } catch {
        throw new Error("Expected function not to throw");
      }
    } else {
      if (expected instanceof Error) {
        assertThrows(fn, Error, expected.message);
      } else if (typeof expected === "string") {
        assertThrows(fn, Error, expected);
      } else if (expected instanceof RegExp) {
        try {
          fn();
          throw new Error("Expected function to throw");
        } catch (e) {
          assertMatch((e as Error).message, expected);
        }
      } else {
        assertThrows(fn);
      }
    }
  }

  toHaveBeenCalled(): void {
    const mock = this.actual as MockFn;
    if (this.isNot) {
      assertEquals(mock.mock.calls.length, 0);
    } else {
      assert(mock.mock.calls.length > 0, "Expected function to have been called");
    }
  }

  toHaveBeenCalledTimes(count: number): void {
    const mock = this.actual as MockFn;
    assertEquals(mock.mock.calls.length, count);
  }

  toHaveBeenCalledWith(...args: unknown[]): void {
    const mock = this.actual as MockFn;
    const found = mock.mock.calls.some(call => {
      try {
        assertEquals(call, args);
        return true;
      } catch {
        return false;
      }
    });
    if (this.isNot) {
      assertFalse(found);
    } else {
      assert(found, `Expected function to have been called with ${JSON.stringify(args)}`);
    }
  }
}

class RejectsChain {
  private promise: Promise<unknown>;

  constructor(promise: Promise<unknown>) {
    this.promise = promise;
  }

  async toThrow(expected?: string | RegExp): Promise<void> {
    const fn = () => this.promise;
    if (typeof expected === "string") {
      await assertRejects(fn, Error, expected);
    } else {
      await assertRejects(fn, Error);
    }
  }
}

/**
 * Mock function type
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

/**
 * Jest-like jest object
 */
// Forward declaration - actual timer methods assigned after their definitions below
export const jest = {
  fn,
} as {
  fn: typeof fn;
  useFakeTimers: () => void;
  useRealTimers: () => void;
  setSystemTime: (time: number | Date) => void;
};

/**
 * Extended mock function with restore capability
 */
interface SpyFn extends MockFn {
  mockRestore(): void;
}

/**
 * Spy on an object's method
 * Note: ES module exports cannot be mocked - use dependency injection or
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

/**
 * Fake timers support
 */
let realDateNow: () => number;
let realSetTimeout: typeof setTimeout;
let fakeTime: number | null = null;

export const useFakeTimers = (): void => {
  realDateNow = Date.now;
  realSetTimeout = globalThis.setTimeout;
  fakeTime = Date.now();
  Date.now = () => fakeTime!;
};

export const useRealTimers = (): void => {
  if (realDateNow) {
    Date.now = realDateNow;
  }
  if (realSetTimeout) {
    globalThis.setTimeout = realSetTimeout;
  }
  fakeTime = null;
};

export const setSystemTime = (time: number | Date): void => {
  fakeTime = typeof time === "number" ? time : time.getTime();
};

// Extend jest object with timer functions
jest.useFakeTimers = useFakeTimers;
jest.useRealTimers = useRealTimers;
jest.setSystemTime = setSystemTime;
