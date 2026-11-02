import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { readQuintSource } from "#scripts/tla/quint.ts";

describe("Quint source evidence", () => {
  test("reads the header, the state keywords, and the comments", () => {
    const content = [
      "module Example {",
      "  // One line comment.",
      "  var held: bool",
      '  pure val label: str = "a \\"quoted\\" word"',
      "  pure val count: int = 12",
      "  /// Doc comment.",
      "  /* Block",
      "     comment. */",
      "}",
    ].join("\n");
    const source = readQuintSource("verification/Example.qnt", content);
    expect({ line: source.moduleLine, name: source.moduleName }).toEqual({
      line: 1,
      name: "Example",
    });
    expect(source.comments).toEqual([
      { line: 2, text: "// One line comment." },
      { line: 6, text: "/// Doc comment." },
      { line: 7, text: "/* Block\n     comment. */" },
    ]);
    expect(
      source.tokens
        .filter(
          (token) => token.kind === "identifier" || token.kind === "number",
        )
        .map((token) => token.text),
    ).toEqual([
      "module",
      "Example",
      "var",
      "held",
      "bool",
      "pure",
      "val",
      "label",
      "str",
      "pure",
      "val",
      "count",
      "int",
      "12",
    ]);
  });

  test("reads an unterminated comment to the end of the file", () => {
    for (const tail of ["// open", "/* open"]) {
      const source = readQuintSource(
        "verification/Example.qnt",
        `module Example {\n  pure val value: int = 1\n}\n${tail}`,
      );
      expect(source.comments).toEqual([{ line: 4, text: tail }]);
    }
  });

  test("rejects a missing header, a missing brace, and a broken string", () => {
    for (const content of [
      "",
      "pure val value: int = 1",
      "module Example {",
      "module 42 {",
      'module Example { pure val label: str = "unfinished }',
    ]) {
      expect(() =>
        readQuintSource("verification/Example.qnt", content),
      ).toThrow(/verification\/Example\.qnt/);
    }
  });
});
