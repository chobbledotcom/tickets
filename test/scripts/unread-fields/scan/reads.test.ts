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
});
