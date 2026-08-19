import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import {
  LIMITS,
  runCommentCheck,
  SOURCE_DIR,
} from "#scripts/check-comments/run.ts";
import { checkScriptRun } from "#test-utils/check-script.ts";

describe("runCommentCheck", () => {
  const run = checkScriptRun();
  const tight = { maxColumns: 40, maxLines: 2 };
  const check = () => runCommentCheck(run.path, tight, run.output);

  test("passes a clean tree and says what it enforced", async () => {
    await run.write("src/a.ts", "// short\nexport const a = 1;\n");
    expect(await check()).toBe(0);
    expect(run.logs).toEqual([
      `Every comment in ${run.path} is at most 2 lines and 40 columns, and every {@link} names something that exists.`,
    ]);
    expect(run.errors).toEqual([]);
  });

  test("fails and names the offending file and line", async () => {
    await run.write("src/a.ts", "/**\n * a\n * b\n */\nexport const a = 1;\n");
    expect(await check()).toBe(1);
    expect(run.errors[0]).toContain(`${run.path}/src/a.ts:1`);
    expect(run.errors[0]).toContain("comment runs 4 lines (limit 2)");
    expect(run.errors.at(-1)).toContain("1 comment issue(s) found");
    expect(run.errors.at(-1)).toContain('"Comments are short" in AGENTS.md');
  });

  test("counts every issue across several files", async () => {
    await run.write("src/a.ts", "/**\n * a\n * b\n */\n");
    await run.write("src/b.ts", "/**\n * a\n * b\n */\n");
    expect(await check()).toBe(1);
    expect(run.errors.at(-1)).toContain("2 comment issue(s) found");
  });

  test("checks .tsx as well as .ts", async () => {
    await run.write("src/a.tsx", "/**\n * a\n * b\n */\n");
    expect(await check()).toBe(1);
  });

  test("skips files that are not TypeScript", async () => {
    await run.write("src/a.md", "/**\n * a\n * b\n */\n");
    await run.write("src/a.json", "{}\n");
    expect(await check()).toBe(0);
  });

  test("skips built client assets, which are generated", async () => {
    await run.write("ui/static/bundle.ts", "/**\n * a\n * b\n */\n");
    expect(await check()).toBe(0);
  });

  test("skips the deno doc barrels, whose prose is the published output", async () => {
    await run.write("doc.ts", "/**\n * a\n * b\n */\n");
    await run.write("docs/crypto.ts", "/**\n * a\n * b\n */\n");
    expect(await check()).toBe(0);
  });

  test("still checks a file whose name merely starts with doc", async () => {
    await run.write("docket.ts", "/**\n * a\n * b\n */\n");
    expect(await check()).toBe(1);
  });

  test("exempts the barrel by its whole name, not as a prefix", async () => {
    // Only `doc.ts` itself is published API prose. A file whose name merely
    // begins with it is ordinary source and stays under the limits.
    await run.write("doc.tsx", "/**\n * a\n * b\n */\n");
    expect(await check()).toBe(1);
  });

  test("skips a shipped migration, which is history and never changes", async () => {
    await run.write(
      "shared/db/migrations/2026-06-26_attendees_kind.ts",
      "/**\n * a\n * b\n */\n",
    );
    expect(await check()).toBe(0);
  });

  test("still checks the migration machinery beside them", async () => {
    await run.write("shared/db/migrations/runner.ts", "/**\n * a\n * b\n */\n");
    await run.write(
      "shared/db/migrations/schema-sync.ts",
      "/**\n * a\n * b\n */\n",
    );
    expect(await check()).toBe(1);
    expect(run.errors.at(-1)).toContain("2 comment issue(s) found");
  });

  test("fails a link naming something no file defines", async () => {
    await run.write("src/a.ts", "/** See {@link vanished}. */\n");
    expect(await check()).toBe(1);
    expect(run.errors[0]).toContain(`${run.path}/src/a.ts:1`);
    expect(run.errors[0]).toContain(
      "{@link vanished} names nothing in the tree",
    );
  });

  test("passes a link whose target lives in another file", async () => {
    await run.write("src/a.ts", "/** See {@link helper}. */\n");
    await run.write("src/b.ts", "export const helper = 1;\n");
    expect(await check()).toBe(0);
  });

  test("checks links in a file that no length limit applies to", async () => {
    // A dead link in the published docs is worse than one in ordinary source,
    // so the length exemption must not carry the link check with it.
    await run.write("doc.ts", "/**\n * a\n * b\n * {@link vanished}\n */\n");
    expect(await check()).toBe(1);
    expect(run.errors[0]).toContain(
      "{@link vanished} names nothing in the tree",
    );
    expect(run.errors[0]).not.toContain("comment runs");
  });

  test("reports a file's issues in line order", async () => {
    await run.write(
      "src/a.ts",
      `// {@link gone}\nconst a = 1;\n// ${"w".repeat(50)}\n`,
    );
    expect(await check()).toBe(1);
    expect(run.errors[0]).toContain("src/a.ts:1");
    expect(run.errors[1]).toContain("src/a.ts:3");
  });

  test("reports files in a stable order", async () => {
    await run.write("src/b.ts", "/**\n * a\n * b\n */\n");
    await run.write("src/a.ts", "/**\n * a\n * b\n */\n");
    await check();
    expect(run.errors[0]).toContain("/a.ts");
    expect(run.errors[1]).toContain("/b.ts");
  });
});

describe("SOURCE_DIR", () => {
  test("scans the source tree", () => {
    expect(SOURCE_DIR).toBe("src");
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
