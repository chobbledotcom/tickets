import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import {
  classify,
  emptyAreaTally,
  formatReport,
  freshState,
  tallyDiff,
} from "../../scripts/diff-code-lines-lib.ts";

describe("diff-code-lines classify", () => {
  test("treats a multi-line import block as import across its lines", () => {
    const state = freshState();
    expect(classify("import {", state)).toBe("import");
    expect(state.inImport).toBe(true);
    expect(classify("  member,", state)).toBe("import");
    expect(classify('} from "./x.ts";', state)).toBe("import");
    expect(state.inImport).toBe(false);
  });

  test("treats a multi-line block comment as comment across its lines", () => {
    const state = freshState();
    expect(classify("/*", state)).toBe("comment");
    expect(state.inBlockComment).toBe(true);
    expect(classify(" * middle", state)).toBe("comment");
    expect(classify(" closing */", state)).toBe("comment");
    expect(state.inBlockComment).toBe(false);
  });

  test("classifies single-line kinds", () => {
    const state = freshState();
    expect(classify("/* one liner */", state)).toBe("comment");
    expect(state.inBlockComment).toBe(false);
    expect(classify("", state)).toBe("blank");
    expect(classify("// a note", state)).toBe("comment");
    expect(classify(" * jsdoc line", state)).toBe("comment");
    expect(classify("const x = 1;", state)).toBe("code");
  });

  test("recognises imports and re-exports, single- and multi-line", () => {
    const fresh = () => freshState();
    expect(classify('import { a } from "./a.ts";', fresh())).toBe("import");
    expect(classify('import defaultExport from "./d.ts";', fresh())).toBe(
      "import",
    );
    expect(classify('import "./side-effect.ts";', fresh())).toBe("import");
    expect(classify('export { a } from "./a.ts";', fresh())).toBe("import");
    expect(classify('export * from "./a.ts";', fresh())).toBe("import");
    expect(classify('export type { T } from "./t.ts";', fresh())).toBe(
      "import",
    );

    const barrel = freshState();
    expect(classify("export {", barrel)).toBe("import");
    expect(barrel.inImport).toBe(true);

    const typeBarrel = freshState();
    expect(classify("export type {", typeBarrel)).toBe("import");
    expect(typeBarrel.inImport).toBe(true);
  });

  test("does not mistake code that merely mentions `from` for an import", () => {
    // A re-export must start with `export {` / `export *` / `export type`, so an
    // exported helper with a `from` parameter, an export whose string value
    // contains "from", and a single-line local export block all stay as code.
    expect(
      classify("export const pick = (view, from) => view;", freshState()),
    ).toBe("code");
    expect(classify(`export const note = 'from "x"';`, freshState())).toBe(
      "code",
    );
    expect(classify("export { a };", freshState())).toBe("code");
  });

  test("treats import.meta and dynamic import() as code, not import", () => {
    // Static import declarations have a space or quote after `import`; the
    // `import.meta` property and a dynamic `import(...)` call are executable
    // code, so both stay classified as code.
    expect(classify("import.meta.url;", freshState())).toBe("code");
    expect(classify('const m = await import("./m.ts");', freshState())).toBe(
      "code",
    );
    expect(classify('import("./lazy.ts").then(run);', freshState())).toBe(
      "code",
    );
  });
});

describe("diff-code-lines tallyDiff", () => {
  const DIFF = [
    "diff --git a/src/foo.ts b/src/foo.ts",
    "new file mode 100644",
    "index 0000000..1111111",
    "--- /dev/null",
    "+++ b/src/foo.ts",
    "@@ -0,0 +1,4 @@",
    '+import { a } from "./a.ts";',
    "+const x = 1;",
    "+// note",
    "+",
    "diff --git a/test/bar.test.ts b/test/bar.test.ts",
    "deleted file mode 100644",
    "index 2222222..0000000",
    "--- a/test/bar.test.ts",
    "+++ /dev/null",
    "@@ -1,2 +0,0 @@",
    "-const y = 2;",
    "-const z = 3;",
    "\\ No newline at end of file",
    "diff --git a/other/baz.md b/other/baz.md",
    "index 3333333..4444444 100644",
    "--- a/other/baz.md",
    "+++ b/other/baz.md",
    "@@ -1 +1 @@",
    "-old line",
    "+new line",
    "@@ -5,0 +6 @@",
    "+extra line",
    "",
  ].join("\n");

  test("tallies added lines of a new file by kind under its area", () => {
    const counts = tallyDiff(DIFF);
    expect(counts.added.src).toEqual({
      blank: 1,
      code: 1,
      comment: 1,
      import: 1,
    });
    expect(counts.removed.src).toEqual({
      blank: 0,
      code: 0,
      comment: 0,
      import: 0,
    });
  });

  test("attributes a deleted file's removed lines to its real area", () => {
    // The deleted file names its path only on `--- a/test/…`; the `+dev/null`
    // side must not leave the removed lines under the previous file's area.
    const counts = tallyDiff(DIFF);
    expect(counts.removed.test.code).toBe(2);
    expect(counts.added.test.code).toBe(0);
  });

  test("resets state per hunk and tallies both sides of an edit", () => {
    const counts = tallyDiff(DIFF);
    expect(counts.added.other.code).toBe(2);
    expect(counts.removed.other.code).toBe(1);
  });

  test("classifies a dash-prefixed content line instead of dropping it", () => {
    // A removed SQL `-- comment` diffs to `--- comment`; outside the file
    // header it must be tallied as content, not mistaken for a `--- a/` header.
    const sqlDiff = [
      "diff --git a/src/q.sql b/src/q.sql",
      "index aaaaaaa..bbbbbbb 100644",
      "--- a/src/q.sql",
      "+++ b/src/q.sql",
      "@@ -1 +1 @@",
      "--- old sql comment",
      "+-- new sql comment",
      "",
    ].join("\n");
    const counts = tallyDiff(sqlDiff);
    expect(counts.removed.src.code).toBe(1);
    expect(counts.added.src.code).toBe(1);
  });
});

describe("diff-code-lines formatReport", () => {
  test("shows the test/src ratio when src code changed", () => {
    const counts = { added: emptyAreaTally(), removed: emptyAreaTally() };
    counts.added.src.code = 4;
    counts.added.test.code = 8;
    const out = formatReport(counts);
    expect(out).toContain("  src : 4");
    expect(out).toContain("  test: 8");
    expect(out).toContain("  test/src ratio: 2.00");
  });

  test("omits the ratio when no src code changed", () => {
    const counts = { added: emptyAreaTally(), removed: emptyAreaTally() };
    counts.added.test.code = 3;
    const out = formatReport(counts);
    expect(out).not.toContain("ratio");
    expect(out).toContain("  src : 0");
    expect(out).toContain("  test: 3");
  });
});
