import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import {
  createBooleanScope,
  createScope,
  createScopedValue,
} from "#shared/request-scoped.ts";

describe("shared > request scoped > createBooleanScope", () => {
  test("reads false outside any scope", () => {
    const flag = createBooleanScope();
    expect(flag.read()).toBe(false);
  });

  test("holds the switch on for the calls inside the scope, and only there", () => {
    const flag = createBooleanScope();
    let readInside: boolean | undefined;

    flag.runUnder(() => {
      readInside = flag.read();
    });

    expect(readInside).toBe(true);
    expect(flag.read()).toBe(false);
  });

  test("each runUnder hold is independent of the others", () => {
    const flag = createBooleanScope();
    const reads: boolean[] = [];

    flag.runUnder(() => {
      reads.push(flag.read());
    });
    reads.push(flag.read());

    expect(reads).toContain(true);
    expect(reads).toContain(false);
  });

  test("a scoped value answers its own false, not the fallback", () => {
    const value = createScopedValue<boolean>(() => true);
    expect(value.run(false, () => value.read())).toBe(false);
  });

  test("a scope store cannot run twice", () => {
    const scope = createScope<{ tag: string }>();
    // Strongly referenced by this test, so collection cannot remove the
    // ended-store tracking between the runs.
    const store = { tag: "one" };
    let seen: string | undefined;
    scope.run(store, () => {
      seen = scope.current()?.tag;
    });

    expect(seen).toBe("one");
    // Reusing the store must fail loudly instead of silently carrying a
    // stale value into an unrelated run.
    expect(() => scope.run(store, () => {})).toThrow(/reused/);
  });
});
