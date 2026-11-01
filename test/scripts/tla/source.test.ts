import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { readTlaSource } from "#scripts/tla/source.ts";

describe("TLA source evidence", () => {
  test("keeps comment locations without reading comment text from literals", () => {
    const content =
      '\\* Before the module.\n---- MODULE Example ----\nLabel == "(* not a comment *)"\n(* Outer (* nested *) comment. *)\n====\n';
    const source = readTlaSource("verification/Example.tla", content);
    expect({ line: source.moduleLine, name: source.moduleName }).toEqual({
      line: 2,
      name: "Example",
    });
    expect(source.comments).toEqual([
      { column: 1, line: 1, text: "\\* Before the module." },
      { column: 1, line: 4, text: "(* Outer (* nested *) comment. *)" },
    ]);
  });

  test("rejects missing headers, missing end markers, and broken lexical input", () => {
    for (const content of [
      "",
      "Value == 1\n====",
      "---- MODULE Example ----\nValue == 1",
      '---- MODULE Example ----\nLabel == "unfinished\n====',
    ]) {
      expect(() => readTlaSource("verification/Example.tla", content)).toThrow(
        /verification\/Example.tla/,
      );
    }
  });
});
