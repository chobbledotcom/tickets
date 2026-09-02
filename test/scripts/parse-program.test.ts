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
});
