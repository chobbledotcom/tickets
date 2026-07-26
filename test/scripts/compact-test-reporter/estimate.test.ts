import { expect } from "@std/expect";
import { afterEach, beforeEach, describe, it as test } from "@std/testing/bdd";
import {
  FILE_ARG_VALUE_FLAGS,
  estimateTapEventCount,
} from "#scripts/compact-test-reporter.ts";
import { type TempPath, tempDir } from "#test-utils/files.ts";

/**
 * The estimate feeds the progress bar: it walks whatever paths the `deno test`
 * arguments name and counts the test declarations it finds in each file.
 */
describe("estimating how many tests a run will report", () => {
  let dir: TempPath;

  beforeEach(() => {
    dir = tempDir();
  });

  afterEach(() => {
    dir.dispose();
  });

  const write = (name: string, body: string): void => {
    const path = `${dir.path}/${name}`;
    Deno.mkdirSync(path.slice(0, path.lastIndexOf("/")), { recursive: true });
    Deno.writeTextFileSync(path, body);
  };

  const estimate = (args: string[]) => estimateTapEventCount(dir.path, args);

  test("counts declarations, object form, and steps in a named file", async () => {
    write(
      "a.test.ts",
      [
        'Deno.test("one", () => {});',
        'describe("group", () => {});',
        'it("two", () => {});',
        'test("three", () => {});',
        "Deno.test{",
        't.step("a step");',
      ].join("\n"),
    );

    expect(await estimate(["a.test.ts"])).toBe(6);
  });

  test("does not count a name that merely ends in one of the keywords", async () => {
    write("b.test.ts", ['myTest("x", () => {});', 'obj.it("y");'].join("\n"));

    expect(await estimate(["b.test.ts"])).toBeUndefined();
  });

  test("walks a folder, skipping non-test files", async () => {
    write("suite/one.test.ts", 'Deno.test("a", () => {});');
    write("suite/helper.ts", 'Deno.test("not a test file", () => {});');
    write("suite/__tests__/two.ts", 'Deno.test("b", () => {});');

    expect(await estimate(["suite"])).toBe(2);
  });

  test("skips node_modules and .git while walking", async () => {
    write("suite/one.test.ts", 'Deno.test("a", () => {});');
    write("suite/node_modules/dep.test.ts", 'Deno.test("b", () => {});');
    write("suite/.git/hook.test.ts", 'Deno.test("c", () => {});');

    expect(await estimate(["suite"])).toBe(1);
  });

  test("accepts an absolute path", async () => {
    write("c.test.ts", 'Deno.test("a", () => {});');

    expect(await estimate([`${dir.path}/c.test.ts`])).toBe(1);
  });

  test("ignores a path that does not exist", async () => {
    expect(await estimate(["missing.test.ts"])).toBeUndefined();
  });

  test("gives no estimate when no paths were named", async () => {
    expect(await estimate(["--filter", "name"])).toBeUndefined();
  });

  test("does not mistake any value-taking flag's value for a file", async () => {
    write("d.test.ts", 'Deno.test("a", () => {});');

    for (const flag of FILE_ARG_VALUE_FLAGS) {
      expect(await estimate([flag, "d.test.ts"])).toBeUndefined();
    }
  });

  test("still reads the file after a flag that has no value", async () => {
    write("d.test.ts", 'Deno.test("a", () => {});');

    expect(await estimate(["--filter", "--quiet", "d.test.ts"])).toBe(1);
  });

  test("stops reading paths after a bare --", async () => {
    write("e.test.ts", 'Deno.test("a", () => {});');

    expect(await estimate(["--", "e.test.ts"])).toBeUndefined();
  });

  test("gives no estimate when the named files declare no tests", async () => {
    write("f.test.ts", "export const value = 1;");

    expect(await estimate(["f.test.ts"])).toBeUndefined();
  });
});
