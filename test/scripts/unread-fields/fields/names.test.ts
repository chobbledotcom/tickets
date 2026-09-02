import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { reportLines } from "#scripts/unread-fields/findings.ts";
import { scannedFixture } from "#test/scripts/unread-fields/fixture/build.ts";

/**
 * How a field is written down, and what keeps two of one name apart.
 */
describe("how a field is named", () => {
  const scanned = scannedFixture();
  const verdictOf = scanned.verdictOf;

  test("sees a field written down with a quoted name", () => {
    // `n["quoted-name"]` reaches it, so it is a field like any other.
    expect(verdictOf("NamedByALiteral", "quoted-name")).toBe("read");
  });

  test("sees a field written down with a number", () => {
    expect(verdictOf("NamedByALiteral", "1")).toBe("never read");
  });

  test("sees a quoted name written inside brackets", () => {
    // `["quoted-in-brackets"]: string` declares the same field as
    // `"quoted-in-brackets": string`, and `n["quoted-in-brackets"]` reads it.
    expect(verdictOf("NamedByALiteral", "quoted-in-brackets")).toBe("read");
  });

  test("sees a number written inside brackets", () => {
    expect(verdictOf("NamedByALiteral", "2")).toBe("never read");
  });

  test("reads a negative number written inside brackets", () => {
    expect(verdictOf("NamedByALiteral", "-3")).toBe("read");
  });

  test("reads a negative number through a binding pattern", () => {
    expect(verdictOf("NamedByALiteral", "-4")).toBe("read");
  });

  test("reads a negative number through an assignment pattern", () => {
    expect(verdictOf("NamedByALiteral", "-5")).toBe("read");
  });

  test("reads a negative number through a nested assignment pattern", () => {
    expect(verdictOf("NamedByALiteral.nestedNegative", "-6")).toBe("read");
  });

  test("reads a negative number through a loop assignment pattern", () => {
    expect(verdictOf("NamedByALiteral", "-7")).toBe("read");
  });

  test("uses canonical names for negative numeric keys", () => {
    expect(verdictOf("NamedByALiteral", "-0")).toBe("read");
    expect(verdictOf("NamedByALiteral", "-10")).toBe("read");
    expect(verdictOf("NamedByALiteral", "-1000")).toBe("read");
  });

  test("uses zero for an inferred negative-zero property", () => {
    expect(verdictOf("FromInferredNegativeZero", "0")).toBe("read");
  });

  test("keeps negative zero for a type literal declaration", () => {
    expect(verdictOf("NegativeZeroTypeLiteral", "-0")).toBe("read");
  });

  test("keeps negative zero for a class declaration", () => {
    expect(verdictOf("NegativeZeroClass", "-0")).toBe("read");
  });

  test("leaves out a name a variable works out", () => {
    // The variable is not the field, so there is nothing to look up.
    expect(verdictOf("NamedByALiteral", "keptOut")).toBeUndefined();
  });

  test("sees a static a class declares itself", () => {
    // A static belongs to the class object, which TypeScript calls `typeof C`.
    expect(verdictOf("typeof HasAStaticAndAccessors", "madeOnTheClass")).toBe(
      "never read",
    );
    expect(verdictOf("typeof HasAStaticAndAccessors", "make")).toBe(
      "never read",
    );
  });

  test("sees a static a class borrows from a base it cannot see", () => {
    // The base is the file's own, so the walk cannot enter it, but the class
    // object holds the static and a reader writes `Child.staticFromABase`.
    expect(verdictOf("typeof HasAStatic", "passedDownToItsChildren")).toBe(
      "read",
    );
  });

  test("keeps a static the child declares itself apart from the base's", () => {
    // A static the child declares shadows the base's: they are two fields,
    // and a read of either speaks for its own.
    expect(verdictOf("typeof ShadowsItsBase", "writtenOnTheChild")).toBe(
      "read",
    );
    expect(verdictOf("typeof ShadowsItsBase", "writtenOnTheBase")).toBe(
      "never read",
    );
  });

  test("keeps a class's static side apart from a value of it", () => {
    // Only the class side is read. One line for both would call the field on
    // a value read, and send nobody to the dead one.
    expect(verdictOf("typeof BothSides", "heldByTheClass")).toBe("read");
    expect(verdictOf("BothSides", "heldByAValue")).toBe("never read");
  });

  test("keeps a nested class object's path for its static fields", () => {
    expect(verdictOf("typeof HoldsAClassInAStatic", "inner")).toBe("read");
    expect(verdictOf("typeof HoldsAClassInAStatic.inner", "dead")).toBe("read");
  });

  test("keeps a nested class instance apart from its static side", () => {
    const fields = scanned.all.filter(
      (finding) =>
        finding.owner.startsWith("typeof HoldsAClassInAStatic.inner") &&
        finding.field === "dead",
    );
    expect(fields.map(({ owner, verdict }) => ({ owner, verdict }))).toEqual([
      {
        owner: 'typeof HoldsAClassInAStatic.inner["new ()"].result',
        verdict: "never read",
      },
      { owner: "typeof HoldsAClassInAStatic.inner", verdict: "read" },
    ]);
    expect(fields.map(({ path }) => path)).toEqual([
      [
        { way: "typeof HoldsAClassInAStatic" },
        { name: "inner" },
        { way: "new ()" },
        { way: "result" },
      ],
      [{ way: "typeof HoldsAClassInAStatic" }, { name: "inner" }],
    ]);
    expect(reportLines(fields).slice(2)).toEqual([
      '  never read          typeof HoldsAClassInAStatic.inner["new ()"].result.dead  src/shapes.ts',
    ]);
  });

  test("keeps a nested constructor input apart from its instance field", () => {
    expect(
      verdictOf('typeof HoldsAClassInAStatic.inner["new ()"].options', "id"),
    ).toBe("never read");
    expect(
      verdictOf(
        'typeof HoldsAClassInAStatic.inner["new ()"].result.options',
        "id",
      ),
    ).toBe("read");
  });

  test("tells a name that holds a dot from a path built with dots", () => {
    // `"a.b": string` and `a: { b: string }` read the same once the path is
    // joined, and they are two different fields.
    expect(verdictOf("NameHoldsADot", "hasADotInIts.name")).toBe("never read");
    expect(verdictOf("NameHoldsADot", "hasADotInIts")).toBe("never read");
    expect(verdictOf("NameHoldsADot.hasADotInIts", "name")).toBe("never read");
  });

  test("counts a read of the field the second call signature writes", () => {
    // Two signatures write `sharedByOverloads` down. `Parameters` answers with
    // the last one, so the read points at the second of the two.
    expect(verdictOf('Formatter["()"].input', "sharedByOverloads")).toBe(
      "read",
    );
  });

  test("counts a read of the field two arms of four write down", () => {
    // `QuantityRule.qty` in `src/shared/booking/tree.ts` is this shape, and
    // the report called it never read while one line away production reads it.
    expect(verdictOf("OneArmOrTheOther", "declaredByTwoArms")).toBe("read");
  });

  test("reads a member name a template literal spells", () => {
    // `` [`foo`]: number `` names the field `x.foo`, exactly as `"foo": number`
    // does, so it counts and its read counts.
    expect(verdictOf("NamedByALiteral", "templated")).toBe("read");
  });
});
