import { expect } from "@std/expect";
import { afterEach, beforeEach, describe, it as test } from "@std/testing/bdd";
import { LIMITS, runCommentCheck } from "#scripts/check-comments/run.ts";

const write = async (dir: string, path: string, body: string) => {
  const full = `${dir}/${path}`;
  await Deno.mkdir(full.slice(0, full.lastIndexOf("/")), { recursive: true });
  await Deno.writeTextFile(full, body);
};

describe("runCommentCheck", () => {
  let dir = "";
  let logs: string[] = [];
  let errors: string[] = [];
  const output = {
    log: (line: string) => logs.push(line),
    logError: (line: string) => errors.push(line),
  };
  const tight = { maxColumns: 40, maxLines: 2 };

  beforeEach(async () => {
    dir = await Deno.makeTempDir();
    logs = [];
    errors = [];
  });
  afterEach(async () => await Deno.remove(dir, { recursive: true }));

  test("passes a clean tree and says what it enforced", async () => {
    await write(dir, "src/a.ts", "// short\nexport const a = 1;\n");
    expect(await runCommentCheck(dir, tight, output)).toBe(0);
    expect(logs).toEqual([
      `Every comment in ${dir} is at most 2 lines and 40 columns.`,
    ]);
    expect(errors).toEqual([]);
  });

  test("fails and names the offending file and line", async () => {
    await write(dir, "src/a.ts", "/**\n * a\n * b\n */\nexport const a = 1;\n");
    expect(await runCommentCheck(dir, tight, output)).toBe(1);
    expect(errors[0]).toContain(`${dir}/src/a.ts:1`);
    expect(errors[0]).toContain("comment runs 4 lines (limit 2)");
    expect(errors.at(-1)).toContain("1 comment issue(s) found");
  });

  test("counts every issue across several files", async () => {
    await write(dir, "src/a.ts", "/**\n * a\n * b\n */\n");
    await write(dir, "src/b.ts", "/**\n * a\n * b\n */\n");
    expect(await runCommentCheck(dir, tight, output)).toBe(1);
    expect(errors.at(-1)).toContain("2 comment issue(s) found");
  });

  test("checks .tsx as well as .ts", async () => {
    await write(dir, "src/a.tsx", "/**\n * a\n * b\n */\n");
    expect(await runCommentCheck(dir, tight, output)).toBe(1);
  });

  test("skips files that are not TypeScript", async () => {
    await write(dir, "src/a.md", "/**\n * a\n * b\n */\n");
    await write(dir, "src/a.json", "{}\n");
    expect(await runCommentCheck(dir, tight, output)).toBe(0);
  });

  test("skips built client assets, which are generated", async () => {
    await write(dir, "ui/static/bundle.ts", "/**\n * a\n * b\n */\n");
    expect(await runCommentCheck(dir, tight, output)).toBe(0);
  });

  test("skips the deno doc barrels, whose prose is the published output", async () => {
    await write(dir, "doc.ts", "/**\n * a\n * b\n */\n");
    await write(dir, "docs/crypto.ts", "/**\n * a\n * b\n */\n");
    expect(await runCommentCheck(dir, tight, output)).toBe(0);
  });

  test("still checks a file whose name merely starts with doc", async () => {
    await write(dir, "docket.ts", "/**\n * a\n * b\n */\n");
    expect(await runCommentCheck(dir, tight, output)).toBe(1);
  });

  test("skips a shipped migration, which is history and never changes", async () => {
    await write(
      dir,
      "shared/db/migrations/2026-06-26_attendees_kind.ts",
      "/**\n * a\n * b\n */\n",
    );
    expect(await runCommentCheck(dir, tight, output)).toBe(0);
  });

  test("still checks the migration machinery beside them", async () => {
    await write(
      dir,
      "shared/db/migrations/runner.ts",
      "/**\n * a\n * b\n */\n",
    );
    await write(
      dir,
      "shared/db/migrations/schema-sync.ts",
      "/**\n * a\n * b\n */\n",
    );
    expect(await runCommentCheck(dir, tight, output)).toBe(1);
    expect(errors.at(-1)).toContain("2 comment issue(s) found");
  });

  test("reports files in a stable order", async () => {
    await write(dir, "src/b.ts", "/**\n * a\n * b\n */\n");
    await write(dir, "src/a.ts", "/**\n * a\n * b\n */\n");
    await runCommentCheck(dir, tight, output);
    expect(errors[0]).toContain("/a.ts");
    expect(errors[1]).toContain("/b.ts");
  });
});

describe("LIMITS", () => {
  // Both numbers ratchet downward, so these pin the invariants that hold at
  // every step rather than the step we happen to be on.
  test("never holds a comment tighter than the formatter holds code", () => {
    expect(LIMITS.maxColumns).toBeGreaterThanOrEqual(80);
  });

  test("keeps a comment shorter than the screenful it replaces", () => {
    expect(LIMITS.maxLines).toBeGreaterThan(0);
    expect(LIMITS.maxLines).toBeLessThanOrEqual(20);
  });
});
