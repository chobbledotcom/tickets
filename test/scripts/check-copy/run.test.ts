import { expect } from "@std/expect";
import { afterEach, beforeEach, describe, it as test } from "@std/testing/bdd";
import {
  CATALOG_DIR,
  readCatalog,
  runCopyCheck,
} from "#scripts/check-copy/run.ts";
import { type TempPath, tempDir } from "#test-utils/files.ts";

describe("check-copy runner", () => {
  let dir: TempPath;

  beforeEach(() => {
    dir = tempDir();
  });

  afterEach(() => {
    dir.dispose();
  });

  /** Write one catalog file, run the check over the temp folder, and hand back
   * the exit code plus the lines sent to each logger. */
  const checkCatalog = (
    fileName: string,
    contents: Record<string, unknown>,
  ) => {
    Deno.writeTextFileSync(`${dir.path}/${fileName}`, JSON.stringify(contents));
    const out: string[] = [];
    const errors: string[] = [];
    const code = runCopyCheck(
      dir.path,
      (l) => out.push(l),
      (l) => errors.push(l),
    );
    return { code, errors, out };
  };

  test("reads string values from every .json file, sorted, skipping the rest", () => {
    Deno.writeTextFileSync(
      `${dir.path}/b.json`,
      JSON.stringify({ "b.one": "first", "b.two": "second" }),
    );
    Deno.writeTextFileSync(
      `${dir.path}/a.json`,
      JSON.stringify({ "a.count": 3, "a.text": "hello" }),
    );
    Deno.writeTextFileSync(`${dir.path}/notes.txt`, "ignored");

    expect(readCatalog(dir.path)).toEqual([
      { file: "a.json", key: "a.text", value: "hello" },
      { file: "b.json", key: "b.one", value: "first" },
      { file: "b.json", key: "b.two", value: "second" },
    ]);
  });

  test("returns 0 and logs success when the catalog is clean", () => {
    const { code, out, errors } = checkCatalog("ok.json", {
      "ok.msg": "View your ticket now.",
    });

    expect(code).toBe(0);
    expect(errors).toEqual([]);
    expect(out).toEqual([
      `All user-facing copy in ${dir.path} passes the simple-language checks.`,
    ]);
  });

  test("returns 1 and logs each issue in rule order, then a summary", () => {
    const { code, out, errors } = checkCatalog("bad.json", {
      "bad.msg": "Please read this,  click here",
    });

    expect(code).toBe(1);
    expect(out).toEqual([]);
    expect(errors).toEqual([
      "bad.json bad.msg [double-space]: two or more spaces in a row — use a single space",
      'bad.json bad.msg [descriptive-links]: vague link text "click here" — name the destination, e.g. "View your ticket"',
      '\n2 simple-language issue(s) found. See the "Simple Language" section of AGENTS.md.',
    ]);
  });
});

describe("the real copy catalog", () => {
  test("holds the English copy the site shows people", () => {
    const catalog = readCatalog(CATALOG_DIR);
    expect(catalog.length).toBeGreaterThan(100);
    expect(catalog.map((e) => e.file)).toContain("common.json");
  });

  test("passes every mechanical simple-language check", () => {
    const errors: string[] = [];
    const code = runCopyCheck(
      CATALOG_DIR,
      () => {},
      (l) => errors.push(l),
    );
    expect(errors).toEqual([]);
    expect(code).toBe(0);
  });
});
