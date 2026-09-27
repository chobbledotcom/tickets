import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import type { Alias } from "#scripts/check-imports/rules.ts";
import {
  activeChecks,
  CHECKS,
  type GradeContext,
  runMechanical,
} from "#scripts/grade-page/checks.ts";
import { extractPage } from "#scripts/grade-page/extract.ts";

/** The alias table slice a page under test resolves through. */
const ALIASES: Alias[] = [
  { name: "#i18n", target: "./src/shared/i18n.ts" },
  { name: "#shared/", target: "./src/shared/" },
];

const ctxOf = (overLimit: Record<string, number> = {}): GradeContext => ({
  aliases: ALIASES,
  overLimit,
});

const verdictOf = (
  source: string,
  id: string,
  overLimit: Record<string, number> = {},
) => {
  const verdict = runMechanical(
    extractPage("src/features/admin/sample.ts", source),
    ctxOf(overLimit),
  )[id];
  if (verdict === undefined) throw new Error(`the ${id} check did not run`);
  return verdict;
};

describe("the check schema", () => {
  test("holds unique ids across both engines", () => {
    const ids = CHECKS.map((check) => check.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.length).toBeGreaterThanOrEqual(28);
  });

  test("keeps every mechanical check runnable", () => {
    for (const check of CHECKS) {
      if (check.engine === "code") expect(typeof check.fn).toBe("function");
    }
  });
});

describe("activeChecks", () => {
  const factsOf = (source: string, file = "src/features/admin/sample.ts") =>
    extractPage(file, source);

  test("drops template-only questions for a feature page", () => {
    const ids = activeChecks(factsOf("const a = 1;\n")).map(
      (check) => check.id,
    );
    expect(ids).not.toContain("hard_coded_copy");
    expect(ids).not.toContain("dead_links");
  });

  test("keeps template questions for a template page", () => {
    const ids = activeChecks(
      factsOf("const a = 1;\n", "src/ui/templates/a.tsx"),
    ).map((check) => check.id);
    expect(ids).toContain("hard_coded_copy");
    expect(ids).toContain("naming_matches_site");
  });

  test("keeps evidence-gated questions only when the evidence exists", () => {
    const plain = activeChecks(factsOf("const a = 1;\n")).map(
      (check) => check.id,
    );
    expect(plain).not.toContain("sql_needed_columns");
    expect(plain).not.toContain("transaction_shape");
    const withSql = activeChecks(
      factsOf("const q = `SELECT id FROM t`;\n"),
    ).map((check) => check.id);
    expect(withSql).toContain("sql_needed_columns");
    const withWrites = activeChecks(factsOf("await executeBatch([]);\n")).map(
      (check) => check.id,
    );
    expect(withWrites).toContain("transaction_shape");
  });
});

describe("file_length", () => {
  test("passes a short page", () => {
    expect(verdictOf("const a = 1;\n", "file_length").status).toBe("PASS");
  });

  test("warns on accepted debt and fails unaccepted growth", () => {
    const source = "const a = 1;\n".repeat(450);
    const warned = verdictOf(source, "file_length", {
      "src/features/admin/sample.ts": 500,
    });
    expect(warned.status).toBe("WARN");
    const failed = verdictOf(source, "file_length", {});
    expect(failed.status).toBe("FAIL");
  });
});

describe("comment_limits", () => {
  test("fails two over-limit comments and warns on one", () => {
    const long = `// ${"word ".repeat(20)}\n`;
    const one = verdictOf(long, "comment_limits");
    expect(one.status).toBe("WARN");
    const two = verdictOf(long + long, "comment_limits");
    expect(two.status).toBe("FAIL");
  });
});

describe("imports_one_way", () => {
  test("fails a second import of one module", () => {
    const source = [
      'import { t } from "#i18n";',
      'import type { Key } from "#i18n";',
      "export const value = 1;",
    ].join("\n");
    const verdict = verdictOf(source, "imports_one_way");
    expect(verdict.status).toBe("FAIL");
    expect(verdict.note).toContain("merge into one statement");
  });

  test("fails a spelling longer than the shortest alias", () => {
    const verdict = verdictOf(
      'import { t } from "#shared/i18n.ts";\n',
      "imports_one_way",
    );
    expect(verdict.status).toBe("FAIL");
    expect(verdict.note).toContain('write "#i18n"');
  });

  test("passes the shortest spelling once", () => {
    expect(
      verdictOf('import { t } from "#i18n";\n', "imports_one_way").status,
    ).toBe("PASS");
  });
});

describe("alias_exports", () => {
  test("fails an exported rename of an import", () => {
    const verdict = verdictOf(
      'import { t } from "#i18n";\nexport const translate = t;\n',
      "alias_exports",
    );
    expect(verdict.status).toBe("FAIL");
    expect(verdict.note).toContain("renames");
  });
});

describe("empty_catch", () => {
  test("fails a catch with no statement and no comment", () => {
    const verdict = verdictOf("try { run(); } catch {}\n", "empty_catch");
    expect(verdict.status).toBe("FAIL");
  });

  test("names the first findings and counts the rest", () => {
    const four = "try { a(); } catch {}\n".repeat(4);
    const verdict = verdictOf(four, "empty_catch");
    expect(verdict.note).toContain("+1 more");
  });
});

describe("select_star", () => {
  test("skips a page with no SQL", () => {
    expect(verdictOf("const a = 1;\n", "select_star").status).toBe("SKIP");
  });

  test("fails a statement that selects every column", () => {
    const verdict = verdictOf("const q = `SELECT * FROM t`;\n", "select_star");
    expect(verdict.status).toBe("FAIL");
  });

  test("passes a statement that names its columns", () => {
    const verdict = verdictOf(
      "const q = `SELECT id, name FROM t`;\n",
      "select_star",
    );
    expect(verdict.status).toBe("PASS");
  });
});

describe("count-based checks", () => {
  test("warns once and fails at the threshold", () => {
    expect(verdictOf("a();\n", "forEach_loops").status).toBe("PASS");
    expect(verdictOf("a.forEach(b);\n", "forEach_loops").status).toBe("WARN");
    expect(
      verdictOf(
        "a.forEach(b);\na.forEach(c);\na.forEach(d);\n",
        "forEach_loops",
      ).status,
    ).toBe("FAIL");
    expect(verdictOf("const v = a!;\n", "assertions_and_casts").status).toBe(
      "WARN",
    );
    expect(
      verdictOf(
        "const v = a!;\nconst w = b!;\nconst x = c!;\n",
        "assertions_and_casts",
      ).status,
    ).toBe("FAIL");
  });

  test("fails two exported functions without return types", () => {
    const source =
      "export function a() { return 1; }\nexport function b() { return 2; }\n";
    expect(verdictOf(source, "return_types").status).toBe("FAIL");
  });
});

describe("runMechanical", () => {
  test("marks the precommit-backed checks critical", () => {
    const results = runMechanical(
      extractPage(
        "src/features/admin/sample.ts",
        'import { t } from "#i18n";\n',
      ),
      ctxOf(),
    );
    expect(results.imports_one_way?.critical).toBe(true);
    expect(results.alias_exports?.critical).toBe(true);
    expect(results.empty_catch?.critical).toBe(true);
    expect(results.file_length?.critical).toBe(false);
    expect(results.file_length?.engine).toBe("code");
  });
});
