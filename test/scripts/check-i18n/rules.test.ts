import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import {
  isI18nScanTarget,
  leftoverBudget,
  leftoverLiterals,
} from "#scripts/check-i18n/rules.ts";

describe("leftoverLiterals", () => {
  test("object copy properties are scanned in TS and TSX without false positives", () => {
    const dollar = String.fromCodePoint(36);
    const nameExpression = `${dollar}{name}`;
    const translationExpression = `${dollar}{t("common.name")}`;
    expect(
      leftoverLiterals(
        'const table = { header: "Name", empty: "No rows", emptyText: `No results` };',
        false,
      ),
    ).toEqual([
      'L1 header: "Name"',
      'L1 empty: "No rows"',
      'L1 emptyText: "No results"',
    ]);
    expect(
      leftoverLiterals(
        'const field = { label: "Name", header: "Value" };',
        true,
      ),
    ).toEqual(['L1 label: "Name"', 'L1 header: "Value"']);
    expect(
      leftoverLiterals(
        `const table = { header: \`Keep (${nameExpression})\` };`,
        false,
      ),
    ).toEqual([`L1 header: "Keep (${nameExpression})"`]);
    expect(
      leftoverLiterals(
        `const table = { header: t("common.name"), empty: "", emptyText: \`${translationExpression}: ${nameExpression}\` };`,
        false,
      ),
    ).toEqual([]);
  });

  test("table template strings are scanned in TS as well as TSX", () => {
    expect(
      leftoverLiterals("const table = { header: `No results` };", true),
    ).toEqual(['L1 header: "No results"']);
  });

  test("a quoted fallback inside a template interpolation is scanned once", () => {
    const nameFallback = `${String.fromCodePoint(36)}{name ?? "unknown"}`;
    const line = `const table = { header: \`Status: ${nameFallback}\` };`;
    expect(leftoverLiterals(line, false)).toEqual([
      `L1 header: "Status: ${nameFallback}"`,
    ]);
    expect(leftoverLiterals(line, true)).toEqual([
      `L1 header: "Status: ${nameFallback}"`,
    ]);
  });

  test("a table template spanning lines keeps its opening line", () => {
    const multiline = "const table = {\n  header: `No\n  results`,\n};";
    expect(leftoverLiterals(multiline, false)).toEqual([
      'L2 header: "No results"',
    ]);
    expect(leftoverLiterals(multiline, true)).toEqual([
      'L2 header: "No results"',
    ]);
  });

  test("a newline right after the opening backtick is still scanned", () => {
    const afterNewline = "const table = { header: `\nNo results` };";
    expect(leftoverLiterals(afterNewline, false)).toEqual([
      'L1 header: "No results"',
    ]);
  });

  test("a template example inside a comment is not copy", () => {
    const commented = "// e.g. header: `No results`\nconst table = {};";
    expect(leftoverLiterals(commented, false)).toEqual([]);
  });
});

describe("isI18nScanTarget", () => {
  test("covers the template tree and the copy-bearing form modules", () => {
    expect(isI18nScanTarget("src/ui/templates/public/news.tsx")).toBe(true);
    expect(isI18nScanTarget("src/ui/templates/email/defaults.ts")).toBe(true);
    expect(isI18nScanTarget("src/shared/forms/validation.ts")).toBe(true);
    expect(isI18nScanTarget("src/ui/static/news.js")).toBe(false);
    expect(isI18nScanTarget("src/shared/dates.ts")).toBe(false);
    expect(isI18nScanTarget("scripts/grade-code/checks.ts")).toBe(false);
  });
});

describe("leftoverBudget", () => {
  test("reads the file's ratchet entry, defaulting to zero", () => {
    expect(leftoverBudget("src/ui/templates/fields/modifier.ts")).toBe(20);
    expect(leftoverBudget("src/ui/templates/public/news.tsx")).toBe(0);
    expect(leftoverBudget("scripts/grade-code/checks.ts")).toBe(0);
  });
});
