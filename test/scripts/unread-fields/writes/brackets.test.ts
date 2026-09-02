import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import ts from "typescript";
import { nodeAt, quotedInBrackets } from "#scripts/unread-fields/writes.ts";
import { parse, parsePlainTs, readsAt } from "./helpers.ts";

describe("nodeAt", () => {
  test("finds the identifier covering a position", () => {
    const source = parse("const total = 1;");
    expect(
      nodeAt(source, source.getFullText().indexOf("total"))?.getText(),
    ).toBe("total");
  });

  test("finds nothing past the end of the file", () => {
    const source = parse("const total = 1;");
    expect(nodeAt(source, 500)).toBeUndefined();
  });
});

describe("askAt", () => {
  test("says so, rather than asking nothing, when there is no mention", () => {
    // A question put to a mention that is not there would answer false and
    // read as a verdict. It throws instead.
    expect(() => readsAt("const x = 1;", "missing")).toThrow(
      "no node at -1 in const x = 1;",
    );
  });

  test("stops when the requested occurrence does not exist", () => {
    expect(() => readsAt("use(total);", "total", 2)).toThrow(
      "no node at -1 in use(total);",
    );
  });
});

describe("quotedInBrackets", () => {
  /** The name a computed property holds, whatever that name is spelled as,
   * so the question can be put to each spelling. A computed name in a
   * property assignment is enough, because the answer only looks at the
   * name node. */
  const bracketsHolding = (code: string): ts.ComputedPropertyName => {
    const source = parsePlainTs(`const x = { ${code}: 1 };`);
    const comma = source.getFullText().indexOf(": 1 }");
    let node = nodeAt(source, comma - 1);
    while (node && !ts.isComputedPropertyName(node)) node = node.parent;
    if (!node) throw new Error(`no computed property name in ${code}`);
    return node;
  };

  test("answers the quoted string the brackets hold", () => {
    const brackets = bracketsHolding('["total"]');
    expect(quotedInBrackets(brackets)?.getText()).toBe('"total"');
  });

  test("answers the number the brackets hold", () => {
    const brackets = bracketsHolding("[7]");
    expect(quotedInBrackets(brackets)?.getText()).toBe("7");
  });

  test("answers the template literal the brackets hold", () => {
    const brackets = bracketsHolding("[`total`]");
    expect(quotedInBrackets(brackets)?.getText()).toBe("`total`");
  });

  test("does not answer a name a variable works out", () => {
    const brackets = bracketsHolding("[worked_out]");
    expect(quotedInBrackets(brackets)).toBeUndefined();
  });

  test("does not answer a name a template's value goes into", () => {
    // The `${` is a literal part of the code under test, so the snippet is
    // built from pieces rather than written with an escape the formatter
    // rejects either way round.
    const aTemplate = "${";
    const brackets = bracketsHolding(`[\`tota${aTemplate}l}\`]`);
    expect(quotedInBrackets(brackets)).toBeUndefined();
  });
});
