import { expect } from "@std/expect";
import { afterEach, describe, it as test } from "@std/testing/bdd";
import { lazyRef } from "#fp";
import {
  type BddFunctions,
  createTestNameFilter,
  type FilteredBdd,
  parseNameFilter,
} from "#test-utils/test-name-filter.ts";

interface FakeStep {
  fn?: (t: Deno.TestContext) => unknown;
  name: string;
}

/** The fake context carries deno's TestContext shape plus a step that takes
 * the fake's minimal step definition, so one type serves both sides. */
type FakeContext = Deno.TestContext & {
  step: (step: FakeStep) => Promise<void>;
};

/** A context that records every step it entered, running the step's body. */
const fakeContext = (entered: string[]): FakeContext =>
  ({
    step: async (step: FakeStep) => {
      entered.push(step.name);
      await step.fn?.(fakeContext(entered));
    },
  }) as unknown as FakeContext;

/** The piece of std's bdd contract the filter leans on: a describe body runs
 * synchronously, a top-level suite registers one definition after its body,
 * a nested suite becomes a step of its parent, and a top-level hook creates
 * the hidden "global" suite that later top-level its join. */
const fakeBdd = (): BddFunctions => {
  const runSteps =
    (steps: FakeStep[]) =>
    async (t: FakeContext): Promise<void> => {
      // A suite runner reads the context it was handed before it steps; the
      // read drives the filtered context's property forwarding.
      void t.name;
      for (const step of steps) await t.step(step);
    };
  /** Adapts a fake runner to the `Deno.test` definition shape. */
  const denoFn =
    (fn: (t: FakeContext) => unknown) =>
    (t: Deno.TestContext): Promise<void> =>
      fn(t as unknown as FakeContext) as Promise<void>;
  const registerSuite = (
    nameOrBody: string | (() => void),
    maybeBody?: () => void,
  ): void => {
    // std's describe carries a name; a bare-function suite is the anonymous
    // shape the filter must still keep-able-track.
    const fn = maybeBody ?? (nameOrBody as () => void);
    const suiteName = maybeBody === undefined ? "" : (nameOrBody as string);
    const suite: FakeStep[] = [];
    const parent = current;
    if (parent === undefined) {
      current = suite;
      try {
        fn();
      } finally {
        current = undefined;
      }
      Deno.test({ fn: denoFn(runSteps(suite)), name: suiteName });
    } else {
      parent.push({ fn: denoFn(runSteps(suite)), name: suiteName });
      current = suite;
      try {
        fn();
      } finally {
        current = parent;
      }
    }
  };
  let current: FakeStep[] | undefined;
  const globalSteps: FakeStep[] = [];
  const bdd = {
    afterAll: (() => {}) as BddFunctions["afterAll"],
    afterEach: (() => {}) as BddFunctions["afterEach"],
    beforeAll: ((fn: () => void) => {
      if (current === undefined) {
        // A top-level hook creates std's hidden suite; its registration is
        // what the filter must hold back, and the hook runs in the body.
        Deno.test({
          fn: (t: Deno.TestContext): Promise<void> => {
            fn();
            return runSteps(globalSteps)(t as unknown as FakeContext);
          },
          name: "global",
        });
        current = globalSteps;
      }
    }) as BddFunctions["beforeAll"],
    beforeEach: ((fn: () => void) => {
      bdd.beforeAll(fn);
    }) as BddFunctions["beforeEach"],
    describe: registerSuite as unknown as BddFunctions["describe"],
    it: ((name: string, fn: () => void) => {
      if (current === undefined) Deno.test({ fn, name });
      else current.push({ fn, name });
    }) as BddFunctions["it"],
    test: ((name: string, fn: () => void) => {
      bdd.it(name, fn);
    }) as BddFunctions["test"],
  };
  return bdd;
};

const [getRestoreTest, setRestoreTest] = lazyRef<(() => void) | undefined>(
  () => undefined,
);

/** Deno's types mark `test` read-only, but the runtime property is writable;
 * this named const is how a test patches and later restores registration. */
const setDenoTest = (value: typeof Deno.test): void => {
  const writableTest = Deno as unknown as { test: typeof Deno.test };
  writableTest.test = value;
};

afterEach(() => {
  getRestoreTest()?.();
  setRestoreTest(undefined);
});

/** Installs the filter under a spec with fake bdd functions and hands back
 * the pruned wrappers and every `Deno.test` call that got through, as the
 * arguments the patch saw (std registers object definitions; plain tests may
 * register `(name, fn)`). */
const installFilter = (
  spec: string,
): { filtered: FilteredBdd; captured: RegistrationArgs[] } => {
  const captured: RegistrationArgs[] = [];
  const realTest = ((...args: unknown[]) => {
    captured.push(args);
  }) as unknown as typeof Deno.test;
  const originalTest = Deno.test;
  setRestoreTest(() => setDenoTest(originalTest));
  return {
    captured,
    filtered: createTestNameFilter(spec, fakeBdd(), realTest),
  };
};

type RegistrationArgs = readonly unknown[];

const registeredName = (args: RegistrationArgs): string =>
  typeof args[0] === "string" ? args[0] : (args[0] as { name: string }).name;

const registeredFn = (args: RegistrationArgs): ((t: FakeContext) => unknown) =>
  (args[0] as { fn?: (t: FakeContext) => unknown }).fn!;

const names = (captured: readonly RegistrationArgs[]): string[] =>
  captured.map(registeredName);

describe("parsing a --filter value", () => {
  test("matches a substring", () => {
    expect(parseNameFilter("formats date")("it formats date and time")).toBe(
      true,
    );
    expect(parseNameFilter("formats date")("renders date")).toBe(false);
  });

  test("matches a /regular expression/", () => {
    const matches = parseNameFilter("/^leaf (one|two)$/");
    expect(matches("leaf one")).toBe(true);
    expect(matches("a leaf one")).toBe(false);
  });

  test("treats an unterminated /pattern as a substring", () => {
    expect(parseNameFilter("/leaf")("a /leaf name")).toBe(true);
    expect(parseNameFilter("/leaf")("leaf name")).toBe(false);
  });
});

describe("an unset filter spec", () => {
  test("passes the bdd functions straight through", () => {
    const bdd = fakeBdd();
    const originalTest = Deno.test;
    setRestoreTest(() => setDenoTest(originalTest));
    const filtered = createTestNameFilter(undefined, bdd, originalTest);

    expect(filtered.describe).toBe(bdd.describe);
    expect(filtered.it).toBe(bdd.it);
    expect(filtered.test).toBe(bdd.test);
    expect(filtered.beforeAll).toBe(bdd.beforeAll);
    expect(Deno.test).toBe(originalTest);
  });
});

describe("a leaf-name filter", () => {
  /** Registers a group whose leaves record their names when they run. */
  const recordingGroup = (
    filtered: FilteredBdd,
    run: string[],
    name: string,
    leafNames: readonly string[],
  ): void => {
    filtered.describe(name, () => {
      for (const leaf of leafNames) {
        filtered.it(leaf, () => {
          run.push(leaf);
        });
      }
    });
  };

  /** Runs the first registered definition and asserts what ran. */
  const runCaptured = async (
    captured: readonly RegistrationArgs[],
    expectedNames: readonly string[],
    run: string[],
    expectedRun: readonly string[],
  ): Promise<void> => {
    expect(names(captured)).toEqual([...expectedNames]);
    await registeredFn(captured[0]!)(fakeContext([]));
    expect(run).toEqual([...expectedRun]);
  };

  test("registers a suite that keeps only its matching leaf", async () => {
    const run: string[] = [];
    const { filtered, captured } = installFilter("leaf alpha");
    recordingGroup(filtered, run, "outer group", ["leaf alpha", "leaf beta"]);

    await runCaptured(captured, ["outer group"], run, ["leaf alpha"]);
  });

  test("runs a matched describe whole and drops sibling suites", async () => {
    const run: string[] = [];
    const { filtered, captured } = installFilter("outer group");
    recordingGroup(filtered, run, "outer group", ["leaf alpha", "leaf beta"]);
    recordingGroup(filtered, run, "other group", ["leaf gamma"]);

    await runCaptured(captured, ["outer group"], run, [
      "leaf alpha",
      "leaf beta",
    ]);
  });

  test("matches a leaf through a /regular expression/", async () => {
    const run: string[] = [];
    const { filtered, captured } = installFilter("/leaf (alpha|gamma)/");
    recordingGroup(filtered, run, "outer group", [
      "leaf alpha",
      "leaf beta",
      "leaf gamma",
    ]);

    await runCaptured(captured, ["outer group"], run, [
      "leaf alpha",
      "leaf gamma",
    ]);
  });

  test("never registers a suite whose subtree matched nothing", () => {
    const run: string[] = [];
    const { filtered, captured } = installFilter("leaf alpha");
    recordingGroup(filtered, run, "outer group", ["leaf alpha"]);
    recordingGroup(filtered, run, "other group", ["leaf gamma"]);

    expect(names(captured)).toEqual(["outer group"]);
  });

  test("skips an empty nested suite without entering it", async () => {
    const { filtered, captured } = installFilter("leaf alpha");
    filtered.describe("outer group", () => {
      filtered.describe("inner group", () => {
        filtered.it("leaf alpha", () => {});
      });
      filtered.describe("empty middle", () => {
        filtered.describe("empty inner", () => {
          filtered.it("leaf gamma", () => {});
        });
      });
    });

    const entered: string[] = [];
    await registeredFn(captured[0]!)(fakeContext(entered));
    expect(entered).toEqual(["inner group", "leaf alpha"]);
  });

  test("runs a nested matched group inside an unmatched suite", async () => {
    const run: string[] = [];
    const { filtered, captured } = installFilter("inner group");
    filtered.describe("outer group", () => {
      recordingGroup(filtered, run, "inner group", ["leaf alpha", "leaf beta"]);
      filtered.it("leaf gamma", () => {
        run.push("leaf gamma");
      });
    });

    await runCaptured(captured, ["outer group"], run, [
      "leaf alpha",
      "leaf beta",
    ]);
  });

  test("runs a matched suite's own nested groups whole", async () => {
    const run: string[] = [];
    const { filtered, captured } = installFilter("inner group");
    filtered.describe("outer group", () => {
      filtered.describe("inner group", () => {
        filtered.describe("deepest group", () => {
          filtered.it("leaf alpha", () => {
            run.push("leaf alpha");
          });
        });
      });
    });

    await runCaptured(captured, ["outer group"], run, ["leaf alpha"]);
  });

  test("keeps an anonymous suite when a leaf below it matches", () => {
    const { filtered, captured } = installFilter("leaf alpha");
    filtered.describe(() => {
      filtered.it("leaf alpha", () => {});
    });

    expect(captured).toHaveLength(1);
  });

  test("drops plain and ignored Deno.test declarations that do not match", () => {
    const { captured } = installFilter("kept");
    Deno.test("kept plain", () => {});
    Deno.test("dropped plain", () => {});
    Deno.test({ fn: () => {}, ignore: true, name: "kept ignored" });
    Deno.test({ fn: () => {}, ignore: true, name: "dropped ignored" });

    expect(names(captured)).toEqual(["kept plain", "kept ignored"]);
  });

  test("drops a nameless plain test and a nameless it", () => {
    const { captured, filtered } = installFilter("kept");
    Deno.test(() => {});
    filtered.it(() => {});

    expect(captured).toEqual([]);
  });

  test("holds a top-level hook's hidden suite until a leaf needs it", async () => {
    const run: string[] = [];
    const { filtered, captured } = installFilter("standalone alpha");
    filtered.beforeAll(() => {
      run.push("global hook");
    });
    filtered.it("standalone alpha", () => {
      run.push("standalone alpha");
    });
    filtered.it("standalone beta", () => {
      run.push("standalone beta");
    });

    // After a top-level hook, the file's its join the hidden suite, so one
    // definition carries them and only the matching leaf stays a step.
    await runCaptured(captured, ["global"], run, [
      "global hook",
      "standalone alpha",
    ]);
  });

  test("never registers the hidden suite when nothing below it is kept", () => {
    const { filtered, captured } = installFilter("no such leaf");
    filtered.beforeAll(() => {});
    filtered.it("standalone alpha", () => {});

    expect(captured).toEqual([]);
  });

  test("runs a kept nested group through the hidden suite", async () => {
    const run: string[] = [];
    const { filtered, captured } = installFilter("inner leaf");
    filtered.beforeAll(() => {
      run.push("global hook");
    });
    filtered.it("standalone alpha", () => {
      run.push("alpha");
    });
    filtered.describe("hooked group", () => {
      filtered.it("inner leaf", () => {
        run.push("inner leaf");
      });
      filtered.it("other leaf", () => {
        run.push("other leaf");
      });
    });

    await runCaptured(captured, ["global"], run, ["global hook", "inner leaf"]);
  });
});
