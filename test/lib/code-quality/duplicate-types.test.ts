import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { blankSpans } from "#scripts/typescript-lex.ts";
import {
  extractTypeShapes,
  findDuplicateTypeShapes,
  type NamedTypeShape,
  splitTypeMembers,
  typeShapeSignature,
} from "./detectors.ts";

/**
 * Fixture-driven tests for the duplicate-type-shape detector. As with the other
 * detectors, the integration guard (`../code-quality.test.ts`) only asserts the
 * live tree is clean, so these examples feed each function known-bad and
 * known-good inputs to pin the extraction, normalization and grouping logic.
 */

describe("blankSpans", () => {
  test("blanks a line comment but keeps its length and newline", () => {
    expect(blankSpans("a // c\nb", false)).toBe("a     \nb");
  });

  test("blanks a block comment across a newline", () => {
    expect(blankSpans("a /* x\ny */ b", false)).toBe("a     \n     b");
  });

  test("keeps strings when blankStrings is false", () => {
    expect(blankSpans('x = "a;b"', false)).toBe('x = "a;b"');
  });

  test("blanks strings when blankStrings is true", () => {
    expect(blankSpans('x = "a;b"', true)).toBe("x =      ");
  });

  test("blanks a template literal, preserving embedded newlines", () => {
    expect(blankSpans("`a\nb`", true)).toBe("  \n  ");
  });
});

describe("splitTypeMembers", () => {
  const split = (body: string): string[] =>
    splitTypeMembers(body, body, 0, body.length);

  test("splits top-level members on semicolons", () => {
    expect(split("a: number; b: string")).toEqual(["a: number", "b: string"]);
  });

  test("does not split a comma inside a generic type argument", () => {
    expect(split("m: Map<number, string>; n: number")).toEqual([
      "m: Map<number, string>",
      "n: number",
    ]);
  });

  test("does not treat => as a closing angle bracket", () => {
    expect(split("f: (x: number) => void; g: string")).toEqual([
      "f: (x: number) => void",
      "g: string",
    ]);
  });

  test("collapses internal whitespace and drops empty members", () => {
    expect(split("a:   number;\n  b: string;")).toEqual([
      "a: number",
      "b: string",
    ]);
  });

  test("keeps a nested object as a single member", () => {
    expect(split("a: { x: number; y: number }; b: string")).toEqual([
      "a: { x: number; y: number }",
      "b: string",
    ]);
  });

  test("takes member text from `text`, structure from `code`", () => {
    // A comma inside the string literal (blanked in `code`) must not split, and
    // the real string text is preserved from `text`.
    const text = 'kind: "a,b"; n: number';
    const code = blankSpans(text, true);
    expect(splitTypeMembers(code, text, 0, text.length)).toEqual([
      'kind: "a,b"',
      "n: number",
    ]);
  });
});

describe("extractTypeShapes", () => {
  test("extracts an object type alias", () => {
    expect(extractTypeShapes("type A = { a: number; b: string };")).toEqual([
      { kind: "type", members: ["a: number", "b: string"], name: "A" },
    ]);
  });

  test("extracts an interface, ignoring an extends clause", () => {
    expect(
      extractTypeShapes(
        "interface A extends Base<number> { x: number; y: number }",
      ),
    ).toEqual([
      { kind: "interface", members: ["x: number", "y: number"], name: "A" },
    ]);
  });

  test("handles type parameters on the alias name", () => {
    expect(
      extractTypeShapes("type Box<T> = { value: T; label: string };"),
    ).toEqual([
      { kind: "type", members: ["value: T", "label: string"], name: "Box" },
    ]);
  });

  test("handles arrow defaults inside alias type parameters", () => {
    expect(
      extractTypeShapes(
        "type Box<T = () => void> = { value: T; label: string };",
      ),
    ).toEqual([
      { kind: "type", members: ["value: T", "label: string"], name: "Box" },
    ]);
  });

  test("ignores a non-object alias (union)", () => {
    expect(extractTypeShapes('type A = "x" | "y";')).toEqual([]);
  });

  test("ignores a plain reference alias", () => {
    expect(extractTypeShapes("type A = OtherType;")).toEqual([]);
  });

  test("ignores an alias whose object is only part of the RHS", () => {
    expect(extractTypeShapes("type A = { a: number } | null;")).toEqual([]);
  });

  test("ignores import type and export-from re-exports", () => {
    const src = [
      'import type { A } from "./a.ts";',
      'export type { B } from "./b.ts";',
    ].join("\n");
    expect(extractTypeShapes(src)).toEqual([]);
  });

  test("does not match `type` as an object property name", () => {
    expect(extractTypeShapes("const o = { type: 1, name: 2 };")).toEqual([]);
  });

  test("keeps string-literal members distinct (not blanked away)", () => {
    const a = extractTypeShapes('type A = { kind: "listing"; id: number };');
    const b = extractTypeShapes('type B = { kind: "group"; id: number };');
    expect(a[0]!.members).not.toEqual(b[0]!.members);
  });

  test("ignores a brace and semicolon inside a string-literal member", () => {
    expect(extractTypeShapes('type A = { a: "{;}"; b: number };')).toEqual([
      { kind: "type", members: ['a: "{;}"', "b: number"], name: "A" },
    ]);
  });

  test("ignores a comment inside the body", () => {
    const src = "type A = {\n  a: number; // note\n  b: string;\n};";
    expect(extractTypeShapes(src)[0]!.members).toEqual([
      "a: number",
      "b: string",
    ]);
  });

  test("extracts an exported type", () => {
    expect(
      extractTypeShapes("export type A = { a: number; b: number };")[0],
    ).toEqual({ kind: "type", members: ["a: number", "b: number"], name: "A" });
  });
});

describe("typeShapeSignature", () => {
  test("is order-independent", () => {
    expect(typeShapeSignature(["b: string", "a: number"])).toBe(
      typeShapeSignature(["a: number", "b: string"]),
    );
  });

  test("joins sorted members with a semicolon separator", () => {
    expect(typeShapeSignature(["b: string", "a: number"])).toBe(
      "a: number; b: string",
    );
  });
});

describe("findDuplicateTypeShapes", () => {
  const def = (
    file: string,
    name: string,
    members: string[],
    kind: "type" | "interface" = "type",
  ): NamedTypeShape => ({ file, kind, members, name });

  test("flags two differently-named types with the same shape", () => {
    const defs = [
      def("a.ts", "A", ["x: number", "y: number"]),
      def("b.ts", "B", ["y: number", "x: number"]),
    ];
    expect(findDuplicateTypeShapes(defs, [])).toEqual([
      "duplicate type shape { x: number; y: number } — defined as type A (a.ts), type B (b.ts); extract one shared type or add it to the allow-list",
    ]);
  });

  test("does not flag a single type", () => {
    expect(
      findDuplicateTypeShapes(
        [def("a.ts", "A", ["x: number", "y: number"])],
        [],
      ),
    ).toEqual([]);
  });

  test("ignores shapes below the member threshold", () => {
    const defs = [
      def("a.ts", "A", ["id: number"]),
      def("b.ts", "B", ["id: number"]),
    ];
    expect(findDuplicateTypeShapes(defs, [])).toEqual([]);
  });

  test("respects the allow-list of accepted signatures", () => {
    const defs = [
      def("a.ts", "A", ["x: number", "y: number"]),
      def("b.ts", "B", ["x: number", "y: number"]),
    ];
    expect(findDuplicateTypeShapes(defs, ["x: number; y: number"])).toEqual([]);
  });

  test("collapses re-encounters of the same qualified type", () => {
    // The same file::name seen twice is not two distinct types.
    const defs = [
      def("a.ts", "A", ["x: number", "y: number"]),
      def("a.ts", "A", ["x: number", "y: number"]),
    ];
    expect(findDuplicateTypeShapes(defs, [])).toEqual([]);
  });

  test("reports the interface kind in the message", () => {
    const defs = [
      def("a.ts", "A", ["x: number", "y: number"], "interface"),
      def("b.ts", "B", ["x: number", "y: number"]),
    ];
    expect(findDuplicateTypeShapes(defs, [])[0]).toContain(
      "interface A (a.ts)",
    );
  });
});

describe("blankSpans — span boundaries", () => {
  test("blanks a single-quoted string", () => {
    expect(blankSpans("'a'", true)).toBe("   ");
  });

  test("continues scanning after a comment (adjacent block comments)", () => {
    // If the loop failed to resume at the comment's end, the second block
    // comment would go unblanked.
    expect(blankSpans("a/*x*//*y*/", false)).toBe("a          ");
  });

  test("blanks a comment then a following string (both, offset > 0)", () => {
    expect(blankSpans('ab/**/"y"', true)).toBe("ab       ");
  });

  test("blanks a string then a following comment (both, offset > 0)", () => {
    expect(blankSpans('a"y"/*z*/', true)).toBe("a        ");
  });
});

describe("splitTypeMembers — delimiters and nesting", () => {
  const split = (body: string): string[] =>
    splitTypeMembers(body, body, 0, body.length);

  test("splits on a top-level comma", () => {
    expect(split("a: number, b: string")).toEqual(["a: number", "b: string"]);
  });

  test("does not split a comma inside a tuple/array member", () => {
    expect(split("a: [number, string]; b: number")).toEqual([
      "a: [number, string]",
      "b: number",
    ]);
  });
});

describe("extractTypeShapes — parsing edge cases", () => {
  test("splits comma-separated interface-style members", () => {
    expect(
      extractTypeShapes("type A = { a: number, b: number };")[0]!.members,
    ).toEqual(["a: number", "b: number"]);
  });

  test("keeps a semicolon inside a string-literal member from splitting", () => {
    // Only correct because the object body is scanned with strings blanked.
    expect(
      extractTypeShapes('type A = { a: ";"; b: number };')[0]!.members,
    ).toEqual(['a: ";"', "b: number"]);
  });

  test("ignores a type alias with an unterminated object body", () => {
    expect(extractTypeShapes("type A = { a: number; b: number")).toEqual([]);
  });

  test("ignores an interface with an unterminated body", () => {
    expect(extractTypeShapes("interface A { a: number; b: number")).toEqual([]);
  });

  test("ignores an interface terminated by a semicolon before any body", () => {
    expect(
      extractTypeShapes(
        "interface A;\ninterface C { x: number; y: number }",
      ).map((s) => s.name),
    ).toEqual(["C"]);
  });

  test("ignores an interface with an '=' before any body", () => {
    expect(
      extractTypeShapes(
        "interface A = X;\ninterface C { x: number; y: number }",
      ).map((s) => s.name),
    ).toEqual(["C"]);
  });

  test("ignores an interface that never opens a body", () => {
    expect(extractTypeShapes("interface A extends B")).toEqual([]);
  });

  test("skips an arrow inside an interface's extends generics", () => {
    // The `>` of `=>` must not be treated as closing the `<…>`, or the body
    // brace would be missed.
    expect(
      extractTypeShapes(
        "interface A extends B<() => void> { x: number; y: number }",
      )[0],
    ).toEqual({
      kind: "interface",
      members: ["x: number", "y: number"],
      name: "A",
    });
  });

  test("accepts spaces between the object and the terminating semicolon", () => {
    expect(
      extractTypeShapes("type A = { a: number; b: number }  ;")[0]!.name,
    ).toBe("A");
  });

  test("accepts a tab between the object and the terminating semicolon", () => {
    expect(
      extractTypeShapes("type A = { a: number; b: number }\t;")[0]!.name,
    ).toBe("A");
  });

  test("accepts a newline immediately after the object (no semicolon)", () => {
    expect(
      extractTypeShapes("type A = { a: number; b: number }\n")[0]!.name,
    ).toBe("A");
  });

  test("accepts a CRLF immediately after the object", () => {
    expect(
      extractTypeShapes("type A = { a: number; b: number }\r\n")[0]!.name,
    ).toBe("A");
  });
});
