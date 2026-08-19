import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import {
  CONFIG_PATH,
  readAliases,
  runImportCheck,
  SOURCE_DIRS,
} from "#scripts/check-imports/run.ts";
import { checkScriptRun } from "#test-utils/check-script.ts";

const CONFIG = JSON.stringify({
  imports: {
    "#db/": "./src/shared/db/",
    "#shared/": "./src/shared/",
    "#types": "./src/shared/types.ts",
    valibot: "npm:valibot@^1.4.1",
  },
});

describe("readAliases", () => {
  const run = checkScriptRun();

  test("keeps only the # aliases, so packages are not checked", async () => {
    await run.write("deno.json", CONFIG);
    expect(await readAliases(`${run.path}/deno.json`)).toEqual([
      { name: "#db/", target: "./src/shared/db/" },
      { name: "#shared/", target: "./src/shared/" },
      { name: "#types", target: "./src/shared/types.ts" },
    ]);
  });

  test("returns null when the config is not there", async () => {
    expect(await readAliases(`${run.path}/missing.json`)).toBeNull();
  });

  test("returns null when the config has no import table", async () => {
    await run.write("deno.json", JSON.stringify({ tasks: {} }));
    expect(await readAliases(`${run.path}/deno.json`)).toBeNull();
  });
});

describe("runImportCheck", () => {
  const run = checkScriptRun();
  const check = (...roots: string[]) =>
    runImportCheck(`${run.path}/deno.json`, roots, run.output);

  /** Set the tree up with `source` as its only file, then check `src`. */
  const checkOnly = async (source: string) => {
    await run.write("deno.json", CONFIG);
    await run.write("src/a.ts", source);
    return await check(`${run.path}/src`);
  };
  const LONG_SPELLING = 'import { a } from "#shared/types.ts";\n';

  test("passes a clean tree and says what it enforced", async () => {
    expect(await checkOnly('import { a } from "#db/client.ts";\n')).toBe(0);
    expect(run.logs).toEqual([
      `Every import in ${run.path}/src names its module once, by its shortest alias.`,
    ]);
    expect(run.errors).toEqual([]);
  });

  test("fails and names the file, line, and the spelling to use", async () => {
    expect(await checkOnly(LONG_SPELLING)).toBe(1);
    expect(run.errors[0]).toBe(
      `${run.path}/src/a.ts:1 imports "#shared/types.ts" — write "#types" instead`,
    );
    expect(run.logs).toEqual([]);
  });

  test("reports a file that imports one module twice", async () => {
    const twice = [
      'import type { A } from "#types";',
      'import { b } from "#types";',
      "",
    ].join("\n");
    expect(await checkOnly(twice)).toBe(1);
    expect(run.errors[0]).toContain(`${run.path}/src/a.ts:2`);
    expect(run.errors[0]).toContain('imports "#types" again');
  });

  test("names the count and the rule it enforced", async () => {
    expect(await checkOnly(LONG_SPELLING)).toBe(1);
    expect(run.errors.at(-1)).toContain("1 import issue(s) found");
    expect(run.errors.at(-1)).toContain(
      '"Imports name a module one way" in AGENTS.md',
    );
  });

  test("lists every root it checked in the success line", async () => {
    await run.write("deno.json", CONFIG);
    await run.write("src/a.ts", 'import { a } from "#db/client.ts";\n');
    await run.write("test/b.ts", 'import { b } from "#db/client.ts";\n');
    expect(await check(`${run.path}/src`, `${run.path}/test`)).toBe(0);
    expect(run.logs).toEqual([
      `Every import in ${run.path}/src, ${run.path}/test names its module once, by its shortest alias.`,
    ]);
  });

  test("checks every root it is given", async () => {
    await run.write("deno.json", CONFIG);
    await run.write("src/a.ts", 'import { a } from "#db/client.ts";\n');
    await run.write("test/b.ts", 'import { b } from "#shared/types.ts";\n');
    expect(await check(`${run.path}/src`, `${run.path}/test`)).toBe(1);
    expect(run.errors[0]).toContain(`${run.path}/test/b.ts:1`);
  });

  test("skips a file that is not TypeScript", async () => {
    await run.write("deno.json", CONFIG);
    await run.write("src/a.md", LONG_SPELLING);
    expect(await check(`${run.path}/src`)).toBe(0);
  });

  test("fails loudly when the alias table cannot be read", async () => {
    await run.write("src/a.ts", "export const a = 1;\n");
    expect(
      await runImportCheck(
        `${run.path}/gone.json`,
        [`${run.path}/src`],
        run.output,
      ),
    ).toBe(1);
    expect(run.errors).toEqual([
      `Cannot read the import aliases in ${run.path}/gone.json.`,
    ]);
  });
});

describe("the checked trees", () => {
  test("read the alias table from the repository config", () => {
    expect(CONFIG_PATH).toBe("deno.json");
  });

  test("cover every tree that resolves through that table", () => {
    expect(SOURCE_DIRS).toEqual(["src", "test", "scripts", "cli"]);
  });
});
