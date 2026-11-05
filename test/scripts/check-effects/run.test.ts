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

const CLEAN = "test/scripts/check-effects/clean-fixtures";

const checkOver = (
  output: CheckOutput,
  effects: Readonly<Record<string, readonly string[]>> = {
    clock: ["#clock"],
    db: ["#io/client.ts"],
  },
) => ({
  configPath: `${FIXTURES}/aliases.json`,
  effects,
  output,
  treeRoot: FIXTURES,
});

const fix = 'Split the IO shell out, or remove the "// effects: pure" line.';

describe("effects check", () => {
  test("checks only the modules that carry the pure line", async () => {
    const output = capture();
    const code = await runEffectsCheck({
      configPath: `${CLEAN}/aliases.json`,
      effects: { clock: ["#clock"] },
      output,
      treeRoot: CLEAN,
    });
    expect(code).toBe(0);
    expect(output.logs).toEqual(["Every one of 1 pure modules stays pure."]);
  });

  test("reports each marked module that reaches a root, with its chain", async () => {
    const output = capture();
    const code = await runEffectsCheck(checkOver(output));
    expect(code).toBe(1);
    const at = (name: string): string => `${FIXTURES}/${name}`;
    const finding = (name: string, effect: string, chain: string[]): string =>
      `${at(`pure/${name}`)} [pure-module]: reaches an effect root — ` +
      `${effect}: ${[`pure/${name}`, ...chain].map(at).join(" → ")} — ${fix}`;
    expect(output.errors).toEqual([
      finding("late.ts", "db", ["io/store.ts", "io/client.ts"]),
      finding("leaky.ts", "db", ["io/store.ts", "io/client.ts"]),
      finding("reexporter.ts", "db", ["io/client.ts"]),
      finding("timed.ts", "clock", ["clock.ts"]),
      '\n4 pure-module issue(s) found. See "Pure, functional" in docs/designing-systems.md.',
    ]);
  });

  test("reports an effect root that names no file", async () => {
    const output = capture();
    const code = await runEffectsCheck(
      checkOver(output, { clock: ["#clock"], db: ["#io/missing.ts"] }),
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
      ...checkOver(output),
      configPath: `${FIXTURES}/no-aliases.json`,
    });
    expect(code).toBe(1);
    expect(output.errors).toEqual([
      `Cannot read the import aliases in ${FIXTURES}/no-aliases.json.`,
    ]);
  });
});
