/**
 * Leaf-name filtering for `deno test --filter`.
 *
 * Deno's `--filter` matches only names registered with `Deno.test`, and
 * `@std/testing/bdd` registers one test per outermost `describe`, so a filter
 * that names a nested `it` matches nothing and the run reports success with
 * zero tests. The runners hand the filter to the test child through
 * `TICKETS_TEST_FILTER` instead (see scripts/name-filter.ts), and the bdd
 * wrapper (test/test-utils/bdd.ts) prunes the non-matching tests while they
 * register:
 *
 * - a leaf (`it`) whose name does not match is never registered;
 * - a `describe` whose name matches runs whole, with the filter suspended
 *   inside, so its every leaf registers;
 * - a top-level `describe` whose whole subtree matched nothing is never
 *   registered, so its `beforeAll`/`afterAll` never run;
 * - a kept `describe` whose own name does not match wraps its runner, so the
 *   run skips nested suites that kept nothing instead of reporting their
 *   empty pass events;
 * - a plain `Deno.test` whose name does not match is dropped, which is what
 *   Deno's own `--filter` does to top-level names.
 *
 * An unset spec returns the bdd functions untouched, so an unfiltered run
 * behaves exactly as before.
 */

/** The env var the runners set in the test child; the value is a Deno
 * `--filter` argument: a substring, or `/…/` for a regular expression. */
export const TEST_NAME_FILTER_ENV = "TICKETS_TEST_FILTER";

/** Deno's `--filter` rule: `/…/` is a regular expression, anything else a
 * case-sensitive substring. */
export const parseNameFilter = (spec: string): ((name: string) => boolean) => {
  if (spec.length > 2 && spec.startsWith("/") && spec.endsWith("/")) {
    const pattern = new RegExp(spec.slice(1, -1));
    return (name) => pattern.test(name);
  }
  return (name) => name.includes(spec);
};

/** The `@std/testing/bdd` surface this module wraps. */
export interface BddFunctions {
  afterAll: typeof import("jsr:@std/testing/bdd").afterAll;
  afterEach: typeof import("jsr:@std/testing/bdd").afterEach;
  beforeAll: typeof import("jsr:@std/testing/bdd").beforeAll;
  beforeEach: typeof import("jsr:@std/testing/bdd").beforeEach;
  describe: typeof import("jsr:@std/testing/bdd").describe;
  it: typeof import("jsr:@std/testing/bdd").it;
  test: typeof import("jsr:@std/testing/bdd").test;
}

/** The bdd export set a test isolate uses: the real functions when the run
 * carries no filter, pruned wrappers when it does. */
export type FilteredBdd = BddFunctions;

type HookFn = BddFunctions["beforeAll"];

/** A `describe` body on the registration stack. `args` is the definition the
 * suite handed `Deno.test` when it carries one; it registers only when the
 * body kept a matching leaf. A suite whose own name matched never reaches
 * the stack. */
interface DescribeFrame {
  args?: readonly unknown[];
  kept: boolean;
  name: string;
}

/** The name of a `describe`/`it`/`Deno.test` call, when the argument shape
 * carries one the repo writes: a leading name string or an options object.
 * The other shapes return undefined: an anonymous suite is kept when a leaf
 * below it matches, and a nameless plain test has nothing to match and is
 * dropped. */
const nameOf = (args: readonly unknown[]): string | undefined => {
  const first = args[0] as
    | string
    | { name?: unknown; symbol?: unknown }
    | undefined;
  if (typeof first === "string") return first;
  if (
    typeof first === "object" &&
    first !== null &&
    typeof first.symbol !== "symbol" &&
    typeof first.name === "string"
  ) {
    return first.name;
  }
  return;
};

export const createTestNameFilter = (
  spec: string | undefined,
  bdd: BddFunctions,
  realTest: typeof Deno.test,
): FilteredBdd => {
  if (spec === undefined) return { ...bdd };
  const matches = parseNameFilter(spec);

  /** Paths of the leaves and matched suites that survived pruning; a run-time
   * step is entered only when a kept path starts with the step's path. */
  const keptPaths: string[][] = [];
  const frames: DescribeFrame[] = [];
  let describeWindow = 0;
  let hookWindow = 0;
  let suspended = 0;
  /** A top-level hook's hidden `"global"` suite, which later top-level `it`s
   * join as steps. Its registration waits until something kept needs it, and
   * a run that kept nothing under it never registers it. */
  let pendingGlobal: readonly unknown[] | undefined;

  /** Names a suite this filter registered, for the compact runner's
   * zero-execution decision: the suite's own pass ran no test body. The
   * runner reads kept-suite lines from the marks file after the child exits;
   * console output does not survive the child's reporter. */
  const announceSuite = (name: string): void => {
    const marksPath = Deno.env.get("TICKETS_TEST_FILTER_MARKS");
    if (marksPath === undefined) return;
    Deno.writeTextFileSync(marksPath, `kept-suite ${name}\n`, {
      append: true,
    });
  };

  /** Records a kept path, marks every open suite as kept, and registers the
   * hidden global suite when a kept leaf just made it needed. The global
   * suite bypasses the patch's drop branch: its own name never matches a
   * leaf filter, but its kept steps must run. */
  const keep = (path: readonly string[]): void => {
    keptPaths.push([...path]);
    for (const frame of frames) frame.kept = true;
    if (pendingGlobal !== undefined) {
      const globalArgs = pendingGlobal;
      pendingGlobal = undefined;
      const definition = globalArgs[0] as Deno.TestDefinition;
      // The hidden suite's steps are the file's top-level describes and its,
      // so the same run-time filter applies inside it.
      announceSuite(definition.name!);
      realTest({
        ...definition,
        fn: (t: Deno.TestContext) => definition.fn!(filteredContext(t, [])),
      });
    }
  };

  /** A step the run must not enter: std's suite runner only awaits the
   * result, so a resolved promise reads as a step that never was. */
  const skippedStep = (): Promise<void> => Promise.resolve();

  /** Whether a kept leaf or matched suite lives at or below `path`. */
  const keeps = (path: readonly string[]): boolean =>
    keptPaths.some(
      (keptPath) =>
        path.length <= keptPath.length &&
        path.every((part, index) => keptPath[index] === part),
    );

  /** The test context a kept-but-unmatched suite runner sees: steps whose own
   * subtree kept nothing never reach Deno, so they leave no pass event and
   * their hooks never run. Steps whose name matches run whole, untouched. */
  const filteredContext = (
    context: Deno.TestContext,
    path: readonly string[],
  ): Deno.TestContext =>
    new Proxy(context, {
      get: (target, property, receiver) => {
        if (property !== "step") {
          return Reflect.get(target, property, receiver);
        }
        return (stepArg: unknown): unknown => {
          const step = stepArg as Deno.TestStepDefinition;
          if (matches(step.name)) return target.step(step);
          const stepPath = [...path, step.name];
          if (!keeps(stepPath)) return skippedStep();
          return target.step({
            ...step,
            fn: (stepContext) =>
              step.fn(filteredContext(stepContext, stepPath)),
          });
        };
      },
    });

  /** A suite whose own name matched runs whole: every leaf below registers,
   * and the recorded path lets the run-time step filter pass it through. */
  const describeMatched = (
    args: Parameters<BddFunctions["describe"]>,
    name: string,
  ): unknown => {
    keep([name]);
    announceSuite(name);
    suspended += 1;
    try {
      return bdd.describe(...args);
    } finally {
      suspended -= 1;
    }
  };

  /** Registers a kept suite's definition, or nothing for a nested suite; a
   * suite whose subtree kept nothing was never registered. */
  const registerKeptFrame = (frame: DescribeFrame): void => {
    if (!frame.kept || frame.args === undefined) return;
    keep([...frames.map((open) => open.name), frame.name]);
    announceSuite(frame.name);
    const definition = frame.args[0] as Deno.TestDefinition;
    // A kept suite's own name did not match, so its run-time steps go through
    // the filtered context and its empty nested suites stay out of the report.
    realTest({
      ...definition,
      fn: (t: Deno.TestContext) =>
        definition.fn!(filteredContext(t, [frame.name])),
    });
  };

  const describeWrapper = ((...args: Parameters<BddFunctions["describe"]>) => {
    if (suspended > 0) {
      // A nested suite of a matched suite is part of the same BDD subtree;
      // its own result is a container the runner may have to discount.
      const nested = nameOf(args);
      if (nested !== undefined) announceSuite(nested);
      return bdd.describe(...args);
    }
    const name = nameOf(args);
    if (name !== undefined && matches(name)) {
      return describeMatched(args, name);
    }
    frames.push({ kept: false, name: name ?? "" });
    describeWindow += 1;
    try {
      return bdd.describe(...args);
    } finally {
      describeWindow -= 1;
      registerKeptFrame(frames.pop()!);
    }
  }) as BddFunctions["describe"];

  const itWrapper = ((...args: Parameters<BddFunctions["it"]>) => {
    if (suspended > 0) return bdd.it(...args);
    const name = nameOf(args);
    if (name === undefined || !matches(name)) return;
    keep([...frames.map((frame) => frame.name), name]);
    return bdd.it(...args);
  }) as BddFunctions["it"];

  /** Wraps a hook registration so the patch knows a top-level hook is
   * creating std's hidden global suite. */
  const hookWrapper = (register: HookFn): HookFn =>
    ((fn: Parameters<HookFn>[0]) => {
      hookWindow += 1;
      try {
        return register(fn);
      } finally {
        hookWindow -= 1;
      }
    }) as HookFn;

  const patched = ((...args: Parameters<typeof Deno.test>): void => {
    if (describeWindow > 0) {
      // The suite registers itself as the last act of its `describe` call;
      // std never calls Deno.test for a nested suite.
      frames[frames.length - 1]!.args = args;
      return;
    }
    if (hookWindow > 0) {
      pendingGlobal = args;
      return;
    }
    const name = nameOf(args);
    if (name !== undefined && matches(name)) {
      realTest(...args);
    }
    // A plain test whose name does not match is dropped, like Deno's own
    // `--filter` drops top-level names.
  }) as typeof Deno.test;
  // Keep Deno.test's own API statics (`ignore`, `only`, the global hooks)
  // reachable through the patch; `length` and `name` are read-only.
  for (const key of Object.getOwnPropertyNames(realTest)) {
    const descriptor = Object.getOwnPropertyDescriptor(realTest, key);
    if (descriptor?.writable) {
      Object.defineProperty(patched, key, descriptor);
    }
  }
  // Deno's types mark `test` read-only; the runtime property is writable,
  // which is what lets the patch intercept registrations in this isolate.
  (Deno as unknown as { test: typeof Deno.test }).test = patched;

  // `only`/`ignore`/`skip` keep std's behavior: their registrations still
  // pass the patch, which drops plain unmatched tests.
  describeWrapper.only = bdd.describe.only;
  describeWrapper.ignore = bdd.describe.ignore;
  describeWrapper.skip = bdd.describe.skip;
  itWrapper.only = bdd.it.only;
  itWrapper.ignore = bdd.it.ignore;
  itWrapper.skip = bdd.it.skip;

  return {
    afterAll: hookWrapper(bdd.afterAll),
    afterEach: hookWrapper(bdd.afterEach),
    beforeAll: hookWrapper(bdd.beforeAll),
    beforeEach: hookWrapper(bdd.beforeEach),
    describe: describeWrapper,
    it: itWrapper,
    test: itWrapper as BddFunctions["test"],
  };
};
