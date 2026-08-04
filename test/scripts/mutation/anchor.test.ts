import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { generateMutants } from "#scripts/mutation/generate.ts";

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

/** Every statement-removal anchor a source produces, in source order. */
const removalAnchors = (source: string): string[] =>
  generateMutants(source, "/tmp/example.ts", true)
    .filter((m) => m.newOperator === "(removed)")
    .map((m) => m.anchor);

/** The name half of an anchor — what it sits inside, without the fingerprint
 * of the expression itself. */
const nameOf = (anchor: string): string => anchor.split("~")[0]!;

describe("naming what a mutant sits inside", () => {
  test("names the function a mutant sits in", () => {
    expect(nameOf(nullishAnchor("const read = (x) => x ?? 0;\n"))).toBe("read");
  });

  test("names a plain function declaration", () => {
    expect(nameOf(nullishAnchor("function read(x) { return x ?? 0; }\n"))).toBe(
      "read",
    );
  });

  test("joins nested names outermost first", () => {
    expect(
      nameOf(
        nullishAnchor(
          "const outer = () => { const inner = (x) => x ?? 0; };\n",
        ),
      ),
    ).toBe("outer.inner");
  });

  test("names a class method by its class and its own name", () => {
    expect(
      nameOf(nullishAnchor("class Reader { read(x) { return x ?? 0; } }\n")),
    ).toBe("Reader.read");
  });

  test("names a method whose name is written as a string", () => {
    expect(
      nameOf(
        nullishAnchor('class Reader { "read-it"(x) { return x ?? 0; } }\n'),
      ),
    ).toBe("Reader.read-it");
  });

  test("skips a member whose written name is empty", () => {
    expect(
      nameOf(nullishAnchor('class Reader { ""(x) { return x ?? 0; } }\n')),
    ).toBe("Reader");
  });

  test("names the object property a mutant sits in", () => {
    expect(nameOf(nullishAnchor("const o = { read: (x) => x ?? 0 };\n"))).toBe(
      "o.read",
    );
  });

  test("anchors code inside no declaration on the file itself", () => {
    expect(nameOf(nullishAnchor("export default globalThis.x ?? 0;\n"))).toBe(
      "%3cfile%3e",
    );
  });

  /** An anchor goes into a registry line, where a space would end it early and
   * a `#` would start its reason. */
  test("encodes a name holding a space", () => {
    expect(
      nameOf(nullishAnchor('class R { "read it"(x) { return x ?? 0; } }\n')),
    ).toBe("R.read%20it");
  });

  test("encodes a name holding a comment mark", () => {
    expect(
      nameOf(nullishAnchor('class R { "a#b"(x) { return x ?? 0; } }\n')),
    ).toBe("R.a%23b");
  });
});

describe("keeping an anchor still while code around it moves", () => {
  test("survives unrelated lines added above", () => {
    const before = "const read = (x) => x ?? 0;\n";
    const after = `// a new comment\nimport "./elsewhere.ts";\nconst other = () => 1;\n${before}`;

    expect(nullishAnchor(after)).toBe(nullishAnchor(before));
  });

  test("survives the enclosing function growing above it", () => {
    const before = "const read = (x) => {\n  return x ?? 0;\n};\n";
    const after =
      "const read = (x) => {\n  const noted = String(x);\n  return x ?? 0;\n};\n";

    expect(nullishAnchor(after)).toBe(nullishAnchor(before));
  });

  /**
   * The case an ordinal alone could not survive: another mutant of the same
   * kind appearing *earlier* in the same function. Numbering would shift every
   * anchor below it, quietly pointing each recorded entry at its neighbour.
   */
  test("survives a same-kind mutant inserted above it", () => {
    const before = "const read = (a, b) => [a ?? 0, b ?? 1];\n";
    const after = "const read = (a, b, c) => [c ?? 9, a ?? 0, b ?? 1];\n";

    const kept = nullishMutants(after).map((m) => m.anchor);

    for (const anchor of nullishMutants(before).map((m) => m.anchor)) {
      expect(kept).toContain(anchor);
    }
  });

  test("moves when the expression it names is edited", () => {
    const before = "const read = (x) => x ?? 0;\n";
    const after = "const read = (x) => x ?? 1;\n";

    expect(nullishAnchor(after)).not.toBe(nullishAnchor(before));
  });

  /**
   * A removed statement fills its own statement, so it is fingerprinted as
   * itself. Fingerprinting the block it shares would move every entry in that
   * block whenever any one line beside them was edited.
   */
  test("survives a statement being added beside a removed one", () => {
    const before = "const f = () => {\n  foo(1);\n  bar();\n};\n";
    const after = "const f = () => {\n  foo(1);\n  bar();\n  baz();\n};\n";

    expect(removalAnchors(after)).toContain(removalAnchors(before)[0]!);
  });

  test("moves when the function it sits in is renamed", () => {
    const before = "const read = (x) => x ?? 0;\n";
    const after = "const fetchIt = (x) => x ?? 0;\n";

    expect(nullishAnchor(after)).not.toBe(nullishAnchor(before));
  });
});

describe("telling apart mutants that share a name", () => {
  /** Two callbacks can hold the same words and mean different things — one
   * taking a string, its neighbour a number — so naming the property they sit
   * under is what keeps their anchors apart. */
  test("tells apart identical callbacks under different property names", () => {
    const anchors = nullishMutants(
      'const o = { first: (x) => x ?? "", second: (x) => x ?? "" };\n',
    ).map((m) => m.anchor);

    expect(anchors.map(nameOf)).toEqual(["o.first", "o.second"]);
    expect(anchors.filter((a) => a.includes("@"))).toEqual([]);
  });

  test("tells apart two statements removed from one block", () => {
    const removals = removalAnchors(
      "const f = () => {\n  foo(1);\n  foo(2);\n};\n",
    );

    expect(new Set(removals).size).toBe(removals.length);
  });

  test("gives different expressions different anchors", () => {
    const anchors = nullishMutants(
      "const read = (a, b) => [a ?? 0, b ?? 1];\n",
    ).map((m) => m.anchor);

    expect(new Set(anchors).size).toBe(2);
  });

  /** Character-identical expressions under one name are indistinguishable, so
   * they fall back to source order. */
  test("numbers expressions that are character-identical", () => {
    const anchors = nullishMutants(
      "const read = (a) => [a ?? 0, a ?? 0];\n",
    ).map((m) => m.anchor);

    expect(anchors.map((a) => a.slice(a.lastIndexOf("@")))).toEqual([
      "@1",
      "@2",
    ]);
  });

  test("leaves a lone mutant unnumbered", () => {
    expect(nullishAnchor("const read = (x) => x ?? 0;\n")).not.toContain("@");
  });

  /**
   * A file that is one statement: removing it covers the whole file, so no node
   * strictly contains the mutant. The fingerprint falls back to the statement
   * itself — never to a piece of it, which would leave `foo(1);` and `foo(2);`
   * sharing one anchor.
   */
  test("anchors a mutant that spans the whole file on that statement", () => {
    const [one] = removalAnchors("foo(1);");
    const [two] = removalAnchors("foo(2);");

    expect(one).toMatch(/^%3cfile%3e~/);
    expect(two).not.toBe(one);
  });
});
