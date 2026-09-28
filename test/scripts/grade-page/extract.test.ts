import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { extractPage, pageKind } from "#scripts/grade-page/extract.ts";

const factsOf = (source: string, file = "src/features/admin/sample.ts") =>
  extractPage(file, source);

describe("extractPage", () => {
  test("reads the page's kind, line count, and comments", () => {
    const facts = factsOf("/** Doc. */\n// Load it.\nconst value = 1;\n");
    expect(facts.kind).toBe("feature");
    expect(facts.lines).toBe(3);
    expect(facts.comments.map((comment) => comment.text)).toEqual([
      "/** Doc. */",
      "// Load it.",
    ]);
  });

  test("drops tool directives from the comments", () => {
    const facts = factsOf("// deno-fmt-ignore\n// Real note.\nconst a = 1;\n");
    expect(facts.comments.map((comment) => comment.text)).toEqual([
      "// Real note.",
    ]);
  });

  test("collects ?? and || and ?. in code, not inside strings", () => {
    const facts = factsOf(
      'const a = b ?? c;\nconst d = e || f;\nconst g = h?.i;\nconst s = "?? || ?.";\n',
    );
    expect(facts.fallbacks.map((hit) => hit.line)).toEqual([1, 2, 3]);
  });

  test("collects catch clauses and forEach calls", () => {
    const facts = factsOf(
      "try { run(); } catch (error) { throw error; }\n" +
        "work().catch(() => {});\n" +
        "items.forEach((item) => save(item));\n",
    );
    expect(facts.catchClauses).toHaveLength(2);
    expect(facts.forEachCalls).toHaveLength(1);
  });

  test("collects non-null assertions and casts, but not as const", () => {
    const facts = factsOf(
      "const first = rows[0]!.name;\nconst wide = value as Row;\nconst frozen = value as const;\n",
    );
    expect(facts.nonNullAssertions).toHaveLength(1);
    expect(facts.asCasts).toHaveLength(1);
    expect(facts.asCasts[0]?.line).toBe(2);
  });

  test("finds exported functions that state no return type", () => {
    const facts = factsOf(
      [
        "export function loose(rows: string[]) {",
        "  return rows.length;",
        "}",
        "export function tight(rows: string[]): number {",
        "  return rows.length;",
        "}",
        "export const arrowed = (rows: string[]): number => rows.length;",
        "export const bare = (rows: string[]) => rows.length;",
        "const hidden = (rows: string[]) => rows.length;",
        "export class Keeper {}",
        "export let later;",
        "export { hidden };",
      ].join("\n"),
    );
    expect(facts.missingReturnTypes.map((hit) => hit.line)).toEqual([1, 8, 9]);
    expect(facts.missingReturnTypes[0]?.text).toBe(
      "export function loose(rows: string[]) {",
    );
    expect(facts.missingReturnTypes[2]?.text).toBe(
      "const hidden = (rows: string[]) => rows.length;",
    );
  });

  test("finds untyped functions exported from a list, renamed, or as the default", () => {
    const lines = (source: string[]): number[] =>
      factsOf(source.join("\n")).missingReturnTypes.map((hit) => hit.line);
    expect(
      lines([
        "function plain(value: number) {",
        "  return value;",
        "}",
        "const typed = (): number => 1;",
        "const held: () => number = () => 1;",
        "export { plain as renamed, typed, held };",
        'export { elsewhere } from "./other.ts";',
        'export { "quoted" } from "./other.ts";',
      ]),
    ).toEqual([1]);
    expect(
      lines(["export default function (value: number) {", "  return 1;", "}"]),
    ).toEqual([1]);
    expect(lines(["export default (value: number) => value;"])).toEqual([1]);
    expect(lines(["export default (value: number): number => value;"])).toEqual(
      [],
    );
    expect(lines(["const loose = () => 1;", "export default loose;"])).toEqual([
      1,
    ]);
    expect(lines(["export default class Keeper {}"])).toEqual([]);
  });

  test("keeps the last line's text when the page ends without a newline", () => {
    const facts = factsOf("const first = 1;\nconst last = a ?? b");
    expect(facts.fallbacks).toHaveLength(1);
    expect(facts.fallbacks[0]?.text).toBe("const last = a ?? b");
  });

  test("collects SQL statements, not strings that merely start with a keyword", () => {
    const interpolated =
      // biome-ignore lint/suspicious/noTemplateCurlyInString: the ${id} is page data, not a placeholder to interpolate.
      "const rows = query(`SELECT id FROM listings WHERE id = ${id}`);";
    const facts = factsOf(
      [
        'const route = "delete";',
        'const note = "Update the listing to confirm.";',
        interpolated,
      ].join("\n"),
    );
    expect(facts.sql).toHaveLength(1);
    expect(facts.sql[0]).toContain("SELECT id FROM listings");
  });

  test("collects href literals and expressions", () => {
    // biome-ignore lint/suspicious/noTemplateCurlyInString: the ${token} in this fixture is page data, not a placeholder to interpolate.
    const tokenLink = "const b = <a href={`/t/${token}`}>Ticket</a>;";
    const facts = extractPage(
      "src/ui/templates/sample.tsx",
      ['const a = <a href="/admin/guide">Help</a>;', tokenLink].join("\n"),
    );
    // biome-ignore lint/suspicious/noTemplateCurlyInString: the href the page renders carries a literal ${token}.
    const expected = "`/t/${token}`";
    expect(facts.hrefs).toEqual(["/admin/guide", expected]);
  });

  test("collects batch, transaction, and execute calls", () => {
    const facts = factsOf(
      "await executeBatch(statements);\nawait withTransaction(() => save(row));\n" +
        "await scope.execute(sql);\n",
    );
    expect(facts.writeCalls).toHaveLength(3);
  });

  test("collects table and helper writes, not reads", () => {
    const facts = factsOf(
      [
        "await answersTable.update(answer.id, { text });",
        "await setAnswerModifier(answer.id, modifierId);",
        "await answerAggregates.update(answer.id, input);",
        "await logActivity(`Answer updated`);",
        "await answersTable.insert(input);",
        "await answersTable.deleteById(id);",
        "const rows = await answersTable.findAll();",
        "const found = await getAnswer(id);",
      ].join("\n"),
    );
    expect(facts.writeCalls.map((hit) => hit.line)).toEqual([1, 2, 3, 4, 5, 6]);
  });

  test("collects computer-science jargon with its line", () => {
    const facts = factsOf("// The predicate decides.\nconst value = 1;\n");
    expect(facts.jargonHits).toEqual([{ line: 1, word: "predicate" }]);
  });

  test("collects the import specifiers", () => {
    const facts = factsOf('import { t } from "#i18n";\n');
    expect(facts.imports).toEqual(["#i18n"]);
  });
});

describe("pageKind", () => {
  test("maps each tree to its kind", () => {
    expect(pageKind("src/ui/templates/admin/guide.tsx")).toBe("template");
    expect(pageKind("src/ui/client/admin/nav.ts")).toBe("client");
    expect(pageKind("src/features/public/order.ts")).toBe("feature");
    expect(pageKind("src/shared/dates.ts")).toBe("shared");
    expect(pageKind("cli/api.ts")).toBe("other");
  });
});
