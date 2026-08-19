import { expect } from "@std/expect";
import { afterEach, beforeEach, describe, it as test } from "@std/testing/bdd";
import {
  CONFIG_PATH,
  readAliases,
  runImportCheck,
  SOURCE_DIRS,
} from "#scripts/check-imports/run.ts";

const write = async (dir: string, path: string, body: string) => {
  const full = `${dir}/${path}`;
  await Deno.mkdir(full.slice(0, full.lastIndexOf("/")), { recursive: true });
  await Deno.writeTextFile(full, body);
};

const CONFIG = JSON.stringify({
  imports: {
    "#db/": "./src/shared/db/",
    "#shared/": "./src/shared/",
    "#types": "./src/shared/types.ts",
    valibot: "npm:valibot@^1.4.1",
  },
});

describe("readAliases", () => {
  let dir = "";
  beforeEach(async () => (dir = await Deno.makeTempDir()));
  afterEach(async () => await Deno.remove(dir, { recursive: true }));

  test("keeps only the # aliases, so packages are not checked", async () => {
    await write(dir, "deno.json", CONFIG);
    expect(await readAliases(`${dir}/deno.json`)).toEqual([
      { name: "#db/", target: "./src/shared/db/" },
      { name: "#shared/", target: "./src/shared/" },
      { name: "#types", target: "./src/shared/types.ts" },
    ]);
  });

  test("returns null when the config is not there", async () => {
    expect(await readAliases(`${dir}/missing.json`)).toBeNull();
  });

  test("returns null when the config has no import table", async () => {
    await write(dir, "deno.json", JSON.stringify({ tasks: {} }));
    expect(await readAliases(`${dir}/deno.json`)).toBeNull();
  });
});

describe("runImportCheck", () => {
  let dir = "";
  let logs: string[] = [];
  let errors: string[] = [];
  const output = {
    log: (line: string) => logs.push(line),
    logError: (line: string) => errors.push(line),
  };

  beforeEach(async () => {
    dir = await Deno.makeTempDir();
    logs = [];
    errors = [];
    await write(dir, "deno.json", CONFIG);
  });
  afterEach(async () => await Deno.remove(dir, { recursive: true }));

  test("passes a clean tree and says what it enforced", async () => {
    await write(dir, "src/a.ts", 'import { a } from "#db/client.ts";\n');
    expect(
      await runImportCheck(`${dir}/deno.json`, [`${dir}/src`], output),
    ).toBe(0);
    expect(logs).toEqual([
      `Every import in ${dir}/src names its module once, by its shortest alias.`,
    ]);
    expect(errors).toEqual([]);
  });

  test("fails and names the file, line, and the spelling to use", async () => {
    await write(dir, "src/a.ts", 'import { a } from "#shared/types.ts";\n');
    expect(
      await runImportCheck(`${dir}/deno.json`, [`${dir}/src`], output),
    ).toBe(1);
    expect(errors[0]).toBe(
      `${dir}/src/a.ts:1 imports "#shared/types.ts" — write "#types" instead`,
    );
    expect(logs).toEqual([]);
  });

  test("reports a file that imports one module twice", async () => {
    const body =
      'import type { A } from "#types";\n' + 'import { b } from "#types";\n';
    await write(dir, "src/a.ts", body);
    expect(
      await runImportCheck(`${dir}/deno.json`, [`${dir}/src`], output),
    ).toBe(1);
    expect(errors[0]).toContain(`${dir}/src/a.ts:2`);
    expect(errors[0]).toContain('imports "#types" again');
  });

  test("checks every root it is given", async () => {
    await write(dir, "src/a.ts", 'import { a } from "#db/client.ts";\n');
    await write(dir, "test/b.ts", 'import { b } from "#shared/types.ts";\n');
    expect(
      await runImportCheck(
        `${dir}/deno.json`,
        [`${dir}/src`, `${dir}/test`],
        output,
      ),
    ).toBe(1);
    expect(errors[0]).toContain(`${dir}/test/b.ts:1`);
  });

  test("skips a file that is not TypeScript", async () => {
    await write(dir, "src/a.md", 'import { a } from "#shared/types.ts";\n');
    expect(
      await runImportCheck(`${dir}/deno.json`, [`${dir}/src`], output),
    ).toBe(0);
  });

  test("fails loudly when the alias table cannot be read", async () => {
    await write(dir, "src/a.ts", "export const a = 1;\n");
    expect(
      await runImportCheck(`${dir}/gone.json`, [`${dir}/src`], output),
    ).toBe(1);
    expect(errors).toEqual([
      `Cannot read the import aliases in ${dir}/gone.json.`,
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
