import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import {
  freshCounts,
  loadContext,
  runInternalsCheck,
} from "#scripts/check-test-internals/run.ts";
import { capturedCheckOutput } from "#test-utils/check-script.ts";

const F = "test/scripts/check-test-internals/fixtures";

const source = {
  blackboxDir: `${F}/tests/blackbox/`,
  configPath: `${F}/aliases.json`,
  seam: [`${F}/src/app/request.ts`],
  skippedTrees: [`${F}/tests/scripts/`],
  sourceRoot: `${F}/src`,
};

describe("loadContext", () => {
  test("reads the aliases, the pure modules, and the seam", async () => {
    const context = await loadContext(source);
    expect([...context.pure]).toEqual([`${F}/src/pure/dates.ts`]);
    expect([...context.seam]).toEqual([`${F}/src/app/request.ts`]);
    expect(context.sourceRoot).toBe(`${F}/src/`);
    expect(context.skippedTrees).toEqual([`${F}/tests/scripts/`]);
    expect(context.blackboxDir).toBe(`${F}/tests/blackbox/`);
    expect(context.aliases).toEqual([{ name: "#test/", target: "./test/" }]);
  });

  test("stops when the alias file cannot be read", async () => {
    await expect(
      loadContext({ ...source, configPath: `${F}/missing.json` }),
    ).rejects.toThrow(`Cannot read the import aliases in ${F}/missing.json.`);
  });
});

describe("freshCounts", () => {
  test("counts each file's internals, and leaves out clean and skipped files", async () => {
    const context = await loadContext(source);
    expect(await freshCounts([`${F}/tests`], context)).toEqual({
      [`${F}/tests/blackbox/leaky.ts`]: 1,
      [`${F}/tests/orders.ts`]: 1,
    });
  });
});

describe("runInternalsCheck", () => {
  const output = capturedCheckOutput();

  test("reports the black-box import even when the registry covers the other file", async () => {
    output.lines.length = 0;
    const context = await loadContext(source);
    const code = await runInternalsCheck(context)(
      [`${F}/tests`],
      { [`${F}/tests/orders.ts`]: 1 },
      output,
    );
    expect(output.lines.some((line) => line.includes("blackbox-import"))).toBe(
      true,
    );
    expect(code).toBe(1);
  });

  test("reports a stale entry, a risen count, and the black-box import", async () => {
    output.lines.length = 0;
    const context = await loadContext(source);
    const code = await runInternalsCheck(context)(
      [`${F}/tests`],
      { [`${F}/tests/gone.ts`]: 1 },
      output,
    );
    expect(code).toBe(1);
    expect(output.lines).toEqual([
      `${F}/tests/blackbox/leaky.ts:1 [blackbox-import]: imports ${F}/src/app/db.ts: black-box tests use the driver only — drive the app through the driver`,
      `${F}/tests/gone.ts [stale-entry]: entry names nothing the check reads (scripts/check-test-internals/registry.json) — delete the entry`,
      `${F}/tests/orders.ts:1 [internal-import]: imports ${F}/src/app/db.ts, a src module that is not pure — drive the app through test/blackbox/driver.ts, or add the line "// effects: pure" to the module when it is pure`,
      '\n3 test-internals issue(s) found. See "Keep tests on the public surface" in AGENTS.md.',
    ]);
  });

  test("passes and says so when every file holds its recorded count", async () => {
    output.lines.length = 0;
    const context = await loadContext(source);
    const quiet = {
      ...context,
      skippedTrees: [...context.skippedTrees, `${F}/tests/blackbox/`],
    };
    const code = await runInternalsCheck(quiet)(
      [`${F}/tests`],
      { [`${F}/tests/orders.ts`]: 1 },
      output,
    );
    expect(code).toBe(0);
    expect(output.lines).toEqual([
      "No test file imports more src internals than its recorded count.",
    ]);
  });
});
