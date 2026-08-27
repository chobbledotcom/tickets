import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { scannedFixture } from "./fixture.ts";

/**
 * Whether a mention takes the value out, and where the reader lives.
 */
describe("the reads the scan counts", () => {
  const scanned = scannedFixture();
  const verdictOf = scanned.verdictOf;

  test("does not count a mention that only borrows the field's type", () => {
    expect(verdictOf("Borrowed", "onlyItsTypeIsUsed")).toBe("never read");
  });

  test("does not count a delete as a reader", () => {
    expect(verdictOf("Borrowed", "takenAwayByDelete")).toBe("never read");
  });

  test("looks a field up in the file that declares it", () => {
    expect(verdictOf("ExtendsFarBase", "readFromFarAway")).toBe("read");
  });

  test("names the declaring file, not the shape that hands the field on", () => {
    expect(
      scanned.all.find(
        (f) => f.owner === "ExtendsFarBase" && f.field === "readFromFarAway",
      )?.file,
    ).toBe("src/inner/index.ts");
  });

  test("sees a field read through a directory import", () => {
    expect(verdictOf("Reached", "total")).toBe("read");
  });

  test("ignores a reader outside the folders it scans", () => {
    expect(verdictOf("Sum", "readOnlyFromOutside")).toBe("never read");
  });

  test("sees a field read through an import map alias", () => {
    expect(verdictOf("Sum", "total")).toBe("read");
  });

  test("counts only the tests when only the tests read a field", () => {
    expect(verdictOf("Report", "onlyTestsRead")).toBe("read only by tests");
  });

  test("counts a field taken out by a destructuring assignment as read", () => {
    expect(verdictOf("Sum", "takenOutByPattern")).toBe("read");
  });

  test("counts a field a rest pattern names as read", () => {
    expect(verdictOf("Passed", "kept")).toBe("read");
  });

  // The blind spot the README names first: a spread moves the field without
  // naming it, so there is no reference for the scan to find.

  test("cannot follow a field carried only by a spread", () => {
    expect(verdictOf("Passed", "carriedBySpread")).toBe("never read");
  });

  test("counts a JSX attribute as supplying the field, not reading it", () => {
    expect(verdictOf("BadgeProps", "supplied")).toBe("never read");
  });

  test("counts a prop the component destructures as read", () => {
    expect(verdictOf("BadgeProps", "label")).toBe("read");
  });

  test("counts an array rest target as supplying the field", () => {
    // `[...w.field] = from` puts a value in without a look at the old one.
    expect(verdictOf("WrittenByARest", "filledByAnArrayRest")).toBe(
      "never read",
    );
  });

  test("counts an object rest target as supplying the field", () => {
    expect(verdictOf("WrittenByARest", "filledByAnObjectRest")).toBe(
      "never read",
    );
  });

  test("counts a class built on a field as reading it", () => {
    // `class Child extends h.field {}` reads the field when the program runs,
    // although the compiler counts the clause it sits in as a type.
    expect(verdictOf("HoldsAClass", "builtOnByAChild")).toBe("read");
  });

  test("counts a read through one arm as a read of the union's field", () => {
    // Both arms write the field down, and the read points at the second one.
    expect(verdictOf("BothArmsWriteIt", "writtenByBothArms")).toBe("read");
  });

  test("counts a read of the field only one arm writes down", () => {
    expect(verdictOf("BothArmsWriteIt", "onlyOnTheSecondArm")).toBe("read");
  });

  test("does not count a use of the local a shorthand field is named by", () => {
    // `{ namedByALocal }` gives the field and the local one name, and the
    // compiler answers a lookup for either with both.
    expect(verdictOf("FromAShorthand", "namedByALocal")).toBe("never read");
  });

  test("does not count a shorthand field with no use at all", () => {
    expect(verdictOf("FromAShorthand", "readsLikeAField")).toBe("never read");
  });

  test("still counts a member read of a shorthand field", () => {
    expect(verdictOf("FromAShorthand", "writtenInFull")).toBe("read");
  });

  test("counts a member read inside the file the local lives in", () => {
    // The local is in reach here, so only the member read tells them apart.
    expect(verdictOf("FromAShorthand", "readInItsOwnFile")).toBe("read");
  });

  test("counts a parameter field the constructor reads through this", () => {
    // The parameter is in reach here, so only `this.` tells them apart.
    expect(verdictOf("Carrier", "readByThisInside")).toBe("read");
  });

  test("counts a field an assignment pattern takes out of this", () => {
    // `({ field: held } = this)` is built out of object-literal nodes, not
    // the binding elements a `const` pattern uses.
    expect(verdictOf("NamedItsParameter", "takenOutByAnAssignment")).toBe(
      "read",
    );
  });

  test("counts a read through one arm of an inline union", () => {
    // The arms of an inline union are one shape to the compiler, so a read
    // narrowed to the second arm still points at the field the first
    // declares. A union of *named* arms does not work that way, which is why
    // `BothArmsWriteIt` above needs every declaration on its line.
    expect(verdictOf("InlineArmsShareIt", "sharedByInlineArms")).toBe("read");
  });

  test("counts a field written through parentheses as supplied", () => {
    expect(verdictOf("WrittenThroughParens", "filledInsideParens")).toBe(
      "never read",
    );
  });
});
