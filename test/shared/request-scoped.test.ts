import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import {
  createRequestScoped,
  createScope,
  createScopedValue,
} from "#shared/request-scoped.ts";

/** A gate the test opens by hand, so a continuation registered inside a scope
 * provably runs only after the scope has settled. */
const makeGate = (): { open: () => void; closed: Promise<void> } => {
  let open!: () => void;
  const closed = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { closed, open };
};

describe("createRequestScoped", () => {
  test("outside a scope, current() returns a stable ambient container", () => {
    const scoped = createRequestScoped<{ value: number }>(() => ({ value: 0 }));
    scoped.current().value = 7;
    // Same ambient container across calls, so mutations persist (the plain
    // synchronous set-then-read behaviour unit tests rely on).
    expect(scoped.current().value).toBe(7);
  });

  test("run() binds a fresh container isolated from the ambient one", async () => {
    const scoped = createRequestScoped<{ value: number }>(() => ({ value: 0 }));
    scoped.current().value = 1; // ambient
    const seenInside = await scoped.run(async () => {
      scoped.current().value = 2; // scoped container, not the ambient one
      return scoped.current().value;
    });
    expect(seenInside).toBe(2);
    expect(scoped.current().value).toBe(1); // ambient untouched by the scope
  });

  test("each run() gets its own container (no reuse between scopes)", async () => {
    const scoped = createRequestScoped<{ value: number }>(() => ({ value: 0 }));
    const first = await scoped.run(async () => {
      scoped.current().value = 42;
      return scoped.current().value;
    });
    const second = await scoped.run(async () => scoped.current().value); // fresh container
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

  test("a callback that inherits a finished scope's context reads the ambient container", async () => {
    const scoped = createRequestScoped<{ value: number }>(() => ({ value: 0 }));
    scoped.current().value = 9; // ambient marker

    // A continuation registered inside the scope keeps the scope's async
    // context when it runs later — the runtime can hand such a context to
    // work that starts long after the request finished. Gate the callback so
    // it provably runs after run() has settled.
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let afterScope!: Promise<number>;
    await scoped.run(async () => {
      scoped.current().value = 1;
      afterScope = (async () => {
        await gate;
        return scoped.current().value;
      })();
    });
    release();
    // The scope has ended, so its container is dead: the leaked context must
    // read as "outside a scope" (the ambient container), not the dead one.
    expect(await afterScope).toBe(9);
  });

  test("a scope that ends by throwing is also dead to leaked contexts", async () => {
    const scoped = createRequestScoped<{ value: number }>(() => ({ value: 0 }));
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let afterScope!: Promise<number>;
    await expect(
      scoped.run(async () => {
        scoped.current().value = 5;
        afterScope = (async () => {
          await gate;
          return scoped.current().value;
        })();
        throw new Error("request failed");
      }),
    ).rejects.toThrow("request failed");
    release();
    expect(await afterScope).toBe(0); // ambient, not the dead container's 5
  });
});

describe("createScope", () => {
  test("current() is the store inside a run and undefined outside", () => {
    const scope = createScope<{ n: number }>();
    expect(scope.current()).toBe(undefined);
    const seen = scope.run({ n: 1 }, () => scope.current()?.n);
    expect(seen).toBe(1);
    expect(scope.current()).toBe(undefined);
  });

  test("a continuation that outlives a sync run reads no store", async () => {
    const scope = createScope<{ n: number }>();
    const gate = makeGate();
    // The async callback inherits the scope's context and resumes only after
    // the sync run has returned — the leaked context must read as "outside".
    let afterScope!: Promise<{ n: number } | undefined>;
    scope.run({ n: 1 }, () => {
      afterScope = (async () => {
        await gate.closed;
        return scope.current();
      })();
    });
    gate.open();
    expect(await afterScope).toBe(undefined);
  });

  test("a sync callback that throws still ends its store", async () => {
    const scope = createScope<{ n: number }>();
    const gate = makeGate();
    let afterScope!: Promise<{ n: number } | undefined>;
    expect(() =>
      scope.run({ n: 1 }, () => {
        afterScope = (async () => {
          await gate.closed;
          return scope.current();
        })();
        throw new Error("sync failure");
      }),
    ).toThrow("sync failure");
    gate.open();
    expect(await afterScope).toBe(undefined);
  });

  test("reusing a store object across runs throws", async () => {
    const scope = createScope<{ n: number }>();
    const store = { n: 1 };
    await scope.run(store, async () => {});
    expect(() => scope.run(store, async () => {})).toThrow(
      "fresh store object",
    );
  });
});

describe("createScopedValue", () => {
  test("reads the scope's value inside and the fallback outside", () => {
    const port = createScopedValue(() => 3000);
    expect(port.read()).toBe(3000);
    const seen = port.run(8080, () => port.read());
    expect(seen).toBe(8080);
    expect(port.read()).toBe(3000);
  });

  test("a falsy value still wins over the fallback", () => {
    // Guards the ?? in read(): with || a scoped "" would leak the fallback.
    const label = createScopedValue(() => "fallback");
    expect(label.run("", () => label.read())).toBe("");
  });

  test("nested runs read the innermost value", () => {
    const label = createScopedValue(() => "outside");
    const seen = label.run("outer", () =>
      label.run("inner", () => label.read()),
    );
    expect(seen).toBe("inner");
  });

  test("a continuation that outlives the scope reads the fallback", async () => {
    const label = createScopedValue(() => "outside");
    const gate = makeGate();
    let afterScope!: Promise<string>;
    await label.run("scoped", async () => {
      afterScope = (async () => {
        await gate.closed;
        return label.read();
      })();
    });
    gate.open();
    expect(await afterScope).toBe("outside");
  });
});
