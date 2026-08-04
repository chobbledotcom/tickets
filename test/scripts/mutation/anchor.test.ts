import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { generateMutants } from "#scripts/mutation/generate.ts";

/** The anchors of every mutant a source produces, in source order. */
const anchorsOf = (source: string): string[] =>
  generateMutants(source, "/tmp/example.ts", true).map((m) => m.anchor);

/** Every `?? → ||` mutant a source produces, in source order. */
const nullishMutants = (source: string) =>
  generateMutants(source, "/tmp/example.ts", true).filter(
    (m) => m.operator === "??" && m.newOperator === "||",
  );

/** The anchor of the one `?? → ||` mutant in a source. */
const nullishAnchor = (source: string): string => {
  const found = nullishMutants(source);
  if (found.length !== 1) {
    throw new Error(`Expected one nullish mutant, found ${found.length}`);
  }
  return found[0]!.anchor;
};

describe("anchoring a mutant on what it sits inside", () => {
  test("names the function a mutant sits in", () => {
    expect(nullishAnchor("const read = (x) => x ?? 0;\n")).toBe("read");
  });

  test("names a plain function declaration", () => {
    expect(nullishAnchor("function read(x) { return x ?? 0; }\n")).toBe("read");
  });

  test("joins nested names outermost first", () => {
    expect(
      nullishAnchor("const outer = () => { const inner = (x) => x ?? 0; };\n"),
    ).toBe("outer.inner");
  });

  test("names a class method by its class and its own name", () => {
    expect(nullishAnchor("class Reader { read(x) { return x ?? 0; } }\n")).toBe(
      "Reader.read",
    );
  });

  test("names a method whose name is written as a string", () => {
    expect(
      nullishAnchor('class Reader { "read-it"(x) { return x ?? 0; } }\n'),
    ).toBe("Reader.read-it");
  });

  /** An empty name says nothing about where the mutant is, so the member
   * contributes nothing and the anchor falls back to its class. */
  test("skips a member whose written name is empty", () => {
    expect(nullishAnchor('class Reader { ""(x) { return x ?? 0; } }\n')).toBe(
      "Reader",
    );
  });

  test("anchors top-level code on the file itself", () => {
    expect(nullishAnchor("export default globalThis.x ?? 0;\n")).toBe("<file>");
  });

  /** The whole point: an edit above a recorded expression must not move it. */
  test("keeps the anchor when unrelated lines are added above", () => {
    const before = "const read = (x) => x ?? 0;\n";
    const after = `// a new comment\nimport "./elsewhere.ts";\nconst other = () => 1;\n${before}`;

    expect(nullishAnchor(after)).toBe(nullishAnchor(before));
  });

  test("keeps the anchor when the enclosing function grows above it", () => {
    const before = "const read = (x) => {\n  return x ?? 0;\n};\n";
    const after =
      "const read = (x) => {\n  const noted = String(x);\n  return x ?? 0;\n};\n";

    expect(nullishAnchor(after)).toBe(nullishAnchor(before));
  });

  test("numbers mutants of one kind that share a name, in source order", () => {
    const nullish = nullishMutants(
      "const read = (a, b) => [a ?? 0, b ?? 1];\n",
    );

    expect(nullish.map((m) => m.anchor)).toEqual(["read@1", "read@2"]);
  });

  /** Numbering is scoped to one `from → to`, so the numeric mutants sitting
   * beside these nullish ones are each unique and stay unnumbered. */
  test("leaves a kind with only one mutant in a name unnumbered", () => {
    const anchors = anchorsOf("const read = (a, b) => [a ?? 0, b ?? 1];\n");

    expect(anchors.filter((a) => a === "read").length).toBeGreaterThan(0);
  });

  test("leaves a lone mutant unnumbered", () => {
    expect(nullishAnchor("const read = (x) => x ?? 0;\n")).toBe("read");
  });

  /** Numbering is per kind, so a different mutation beside a recorded one
   * leaves its number alone. */
  test("numbers each kind of mutation separately", () => {
    const nullish = nullishMutants(
      "const read = (a, b) => [a ?? 0, b || 1];\n",
    );

    expect(nullish.map((m) => m.anchor)).toEqual(["read"]);
  });
});
