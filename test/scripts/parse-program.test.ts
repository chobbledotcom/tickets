import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { parseProgram } from "#scripts/parse-program.ts";

describe("parseProgram", () => {
  test("returns a complete module tree", () => {
    expect(
      parseProgram("sample.ts", "export const value = 1;").body,
    ).toHaveLength(1);
  });

  test("rejects a recovered tree", () => {
    const source = 'import { value } from "./right.ts"; /* trailing note';

    expect(() => parseProgram("sample.ts", source)).toThrow(
      "sample.ts does not parse: Unterminated multiline comment",
    );
  });

  test("keeps spans on JavaScript string indices", () => {
    const source = "// caf\u00e9 \ud83d\ude00\nconst value = 1;";

    const declaration = parseProgram("sample.ts", source).body[0]!;
    expect(declaration.start).toBe(source.indexOf("const"));
    expect(declaration.end).toBe(source.indexOf(";") + 1);
    expect(source.slice(declaration.start, declaration.end)).toBe(
      "const value = 1;",
    );
  });
});
