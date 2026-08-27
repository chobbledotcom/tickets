import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { scannedFixture } from "#test/scripts/unread-fields/fixture/build.ts";

/**
 * How a field is written down, and what keeps two of one name apart.
 */
describe("how a field is named", () => {
  const { verdictOf } = scannedFixture();

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

  test("keeps a class's static side apart from a value of it", () => {
    // Only the class side is read. One line for both would call the field on
    // a value read, and send nobody to the dead one.
    expect(verdictOf("typeof BothSides", "heldByTheClass")).toBe("read");
    expect(verdictOf("BothSides", "heldByAValue")).toBe("never read");
  });

  test("tells a call signature's result from a property of one name", () => {
    // A callable shape can hold `id` and hand back an `id`, and the two are
    // different fields. One line for both would let the read speak for both.
    expect(verdictOf("Callable", "sharedByBothWays")).toBe("read");
    expect(verdictOf('Callable["()"]', "sharedByBothWays")).toBe("never read");
  });

  test("sees a field a construct signature hands back", () => {
    expect(verdictOf('Constructable["new ()"]', "handedBackByNew")).toBe(
      "never read",
    );
  });

  test("tells two parameters of one method apart", () => {
    // Both parameters hold a field of the same name, and one line for the
    // two would let a read of either speak for both.
    expect(
      verdictOf("TakesTwoObjects.send.first", "sameNameInBothParameters"),
    ).toBe("never read");
    expect(
      verdictOf("TakesTwoObjects.send.second", "sameNameInBothParameters"),
    ).toBe("never read");
  });

  test("tells a parameter with no name of its own by its place", () => {
    expect(
      verdictOf(
        'TakesADestructuredObject.handle["0"]',
        "onlyInsideADestructured",
      ),
    ).toBe("never read");
  });

  test("puts a field a method takes under that method", () => {
    // Two methods can take an object with the same field name, and the two
    // are different fields. Under the class they would read as one.
    expect(
      verdictOf("TakesObjectsInMethods.send.value", "sameNameInBoth"),
    ).toBe("never read");
    expect(
      verdictOf("TakesObjectsInMethods.post.value", "sameNameInBoth"),
    ).toBe("never read");
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

  test("counts a read of the field the second tuple part writes", () => {
    // `pair[1].sharedByTupleParts` points at the second part, and the first
    // part writes a field of that name down too.
    expect(verdictOf("Pair", "sharedByTupleParts")).toBe("read");
  });
});
