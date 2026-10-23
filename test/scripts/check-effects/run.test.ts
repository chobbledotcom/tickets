import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { runEffectsCheck } from "#scripts/check-effects/run.ts";
import type { CheckOutput } from "#scripts/check-report.ts";

const FIXTURES = "test/scripts/check-effects/fixtures";

const capture = (): CheckOutput & { errors: string[]; logs: string[] } => {
  const logs: string[] = [];
  const errors: string[] = [];
  return {
    errors,
    log: (line) => logs.push(line),
    logError: (line) => errors.push(line),
    logs,
  };
};

const checkOver = (
  output: CheckOutput,
  over: {
    effects?: Readonly<Record<string, readonly string[]>>;
    pureModules?: readonly string[];
  },
) => ({
  configPath: `${FIXTURES}/aliases.json`,
  effects: over.effects ?? { clock: ["#clock"], db: ["#io/client.ts"] },
  output,
  pureModules: over.pureModules ?? ["#pure/core.ts", "#pure/helper.ts"],
  treeRoot: FIXTURES,
});

describe("effects check", () => {
  test("passes when every pure module stays pure", async () => {
    const output = capture();
    const code = await runEffectsCheck(checkOver(output, {}));
    expect(code).toBe(0);
    expect(output.logs).toEqual(["Every one of 2 pure modules stays pure."]);
  });

  test("reports a pure module that reaches the database root", async () => {
    const output = capture();
    const code = await runEffectsCheck(
      checkOver(output, { pureModules: ["#pure/leaky.ts"] }),
    );
    expect(code).toBe(1);
    expect(output.errors).toEqual([
      `${FIXTURES}/pure/leaky.ts [pure-module]: reaches an effect root — ` +
        `db: ${FIXTURES}/pure/leaky.ts → ${FIXTURES}/io/store.ts → ` +
        `${FIXTURES}/io/client.ts — ` +
        "Split the IO shell out, or drop the pure entry.",
      '\n1 pure-module issue(s) found. See "Pure, functional" in docs/designing-systems.md.',
    ]);
  });

  test("reports a pure module that reaches a root through a dynamic import", async () => {
    const output = capture();
    const code = await runEffectsCheck(
      checkOver(output, { pureModules: ["#pure/late.ts"] }),
    );
    expect(code).toBe(1);
    expect(output.errors[0]).toContain(
      `db: ${FIXTURES}/pure/late.ts → ${FIXTURES}/io/store.ts`,
    );
  });

  test("reports a pure module that reaches the clock root", async () => {
    const output = capture();
    const code = await runEffectsCheck(
      checkOver(output, { pureModules: ["#pure/timed.ts"] }),
    );
    expect(code).toBe(1);
    expect(output.errors[0]).toContain("clock: ");
  });

  test("reports a pure entry that names no file", async () => {
    const output = capture();
    const code = await runEffectsCheck(
      checkOver(output, { pureModules: ["#pure/gone.ts"] }),
    );
    expect(code).toBe(1);
    expect(output.errors).toEqual([
      "#pure/gone.ts [pure-module]: names no file under the source tree — " +
        "Remove the stale pure entry.",
      '\n1 pure-module issue(s) found. See "Pure, functional" in docs/designing-systems.md.',
    ]);
  });

  test("reports an effect root that names no file", async () => {
    const output = capture();
    const code = await runEffectsCheck(
      checkOver(output, {
        effects: { clock: ["#clock"], db: ["#io/missing.ts"] },
        pureModules: ["#pure/core.ts"],
      }),
    );
    expect(code).toBe(1);
    expect(output.errors).toEqual([
      "#io/missing.ts [effect-roots]: carries db but names no file under " +
        `${FIXTURES} — Point the effect root at a real module.`,
    ]);
  });

  test("stops when the alias table cannot be read", async () => {
    const output = capture();
    const code = await runEffectsCheck({
      ...checkOver(output, {}),
      configPath: `${FIXTURES}/no-aliases.json`,
    });
    expect(code).toBe(1);
    expect(output.errors).toEqual([
      `Cannot read the import aliases in ${FIXTURES}/no-aliases.json.`,
    ]);
  });
});
