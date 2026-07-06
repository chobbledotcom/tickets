import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { createRequestScoped } from "#shared/request-scoped.ts";

describe("createRequestScoped", () => {
  test("outside a scope, current() returns a stable ambient container", () => {
    const scoped = createRequestScoped<{ value: number }>(() => ({ value: 0 }));
    scoped.current().value = 7;
    // Same ambient container across calls, so mutations persist (the plain
    // synchronous set-then-read behaviour unit tests rely on).
    expect(scoped.current().value).toBe(7);
  });

  test("run() binds a fresh container isolated from the ambient one", () => {
    const scoped = createRequestScoped<{ value: number }>(() => ({ value: 0 }));
    scoped.current().value = 1; // ambient
    const seenInside = scoped.run(() => {
      scoped.current().value = 2; // scoped container, not the ambient one
      return scoped.current().value;
    });
    expect(seenInside).toBe(2);
    expect(scoped.current().value).toBe(1); // ambient untouched by the scope
  });

  test("each run() gets its own container (no reuse between scopes)", () => {
    const scoped = createRequestScoped<{ value: number }>(() => ({ value: 0 }));
    const first = scoped.run(() => {
      scoped.current().value = 42;
      return scoped.current().value;
    });
    const second = scoped.run(() => scoped.current().value); // fresh container
    expect(first).toBe(42);
    expect(second).toBe(0);
  });

  test("concurrent interleaved scopes do not leak state into each other", async () => {
    const scoped = createRequestScoped<{ value: string }>(() => ({
      value: "",
    }));

    const scopeA = () =>
      scoped.run(async () => {
        scoped.current().value = "A";
        await new Promise((r) => setTimeout(r, 20));
        return scoped.current().value; // must still be "A"
      });
    const scopeB = () =>
      scoped.run(async () => {
        await new Promise((r) => setTimeout(r, 5));
        scoped.current().value = "B"; // would clobber a shared global
        await new Promise((r) => setTimeout(r, 20));
        return scoped.current().value;
      });

    const [a, b] = await Promise.all([scopeA(), scopeB()]);
    expect(a).toBe("A");
    expect(b).toBe("B");
  });
});
