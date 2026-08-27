import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { scannedFixture } from "#test/scripts/unread-fields/fixture/build.ts";

/**
 * Which shapes the scan looks at, and where their fields come from.
 */
describe("what the scan counts as a shape", () => {
  const scanned = scannedFixture();
  const verdictOf = scanned.verdictOf;

  test("sees the fields of an alias that only names another type", () => {
    // `StripeRefund = StripeRefundFields` is seven of these in one real file.
    expect(verdictOf("Renamed", "reachedThroughAnAlias")).toBe("never read");
  });

  test("gives a field an intersection supplies twice one line", () => {
    const lines = scanned.all.filter((f) => f.owner === "AnsweredAgain");
    expect(lines.map((f) => f.field)).toEqual(["answeredTwice"]);
  });

  test("sees a public field of an exported class", () => {
    expect(verdictOf("Carrier", "onlyOnAClass")).toBe("never read");
  });

  test("sees a field the constructor declares as a parameter", () => {
    // `SafeHtml` writes its one field as `constructor(public html: string)`.
    expect(verdictOf("Carrier", "heldByTheConstructor")).toBe("never read");
  });

  test("does not count the constructor's own use of a parameter field", () => {
    // `super(value)` names the parameter, not the field. Counting it would
    // keep every parameter property of an Error subclass looking alive.
    expect(verdictOf("NamedItsParameter", "onlyTheConstructorNamesIt")).toBe(
      "never read",
    );
  });

  test("counts a parameter field a destructure takes out", () => {
    // `const { field } = held` never names a member, so the guard above must
    // not read it as the constructor's own mention of its parameter.
    expect(verdictOf("NamedItsParameter", "takenOutByADestructure")).toBe(
      "read",
    );
  });

  test("leaves out a plain constructor parameter", () => {
    expect(verdictOf("Carrier", "plainParameter")).toBeUndefined();
  });

  test("leaves out a field the class keeps to itself", () => {
    expect(verdictOf("Carrier", "notForOutside")).toBeUndefined();
  });

  test("sees a method an exported class hands out", () => {
    expect(verdictOf("Answerer", "answersAQuestion")).toBe("never read");
  });

  test("sees a getter an exported class hands out", () => {
    expect(verdictOf("Answerer", "readsLikeAField")).toBe("never read");
  });

  test("leaves out a method the class keeps to itself", () => {
    expect(verdictOf("Answerer", "keptInside")).toBeUndefined();
  });

  test("sees a field an alias reads off a list of objects", () => {
    // `AdminFeatureDefinition = (typeof ADMIN_FEATURES)[number]` is this
    // shape, and its fields are written down as object literal members.
    expect(verdictOf("FromAList", "writtenInAList")).toBe("never read");
  });

  test("gives a field both arms of a union write down one line", () => {
    const lines = scanned.all.filter((f) => f.owner === "EitherWay");
    expect(lines.map((f) => f.field).sort()).toEqual([
      "onlyOnTheFirst",
      "onlyOnTheSecond",
      "sharedByBothArms",
    ]);
  });

  test("sees the fields of a union whose arms are named types", () => {
    // `PaymentResult = PaymentSuccess | PaymentFailure` names two types its
    // own file keeps to itself, so nothing else reports their fields.
    const lines = scanned.all.filter((f) => f.owner === "EitherNamed");
    expect(lines.map((f) => f.field).sort()).toEqual([
      "onlyWhenItWentBadly",
      "onlyWhenItWentWell",
      "sharedByTheNames",
    ]);
  });

  test("gives a filtered shape one line per field, not two", () => {
    // `Extract<Result, { ok: true }>` writes the discriminant down as a
    // filter. Read as a member, it becomes a second line that disagrees with
    // the first about whether anything reads the field.
    const lines = scanned.all.filter((f) => f.owner === "PickedByAFilter");
    expect(lines.map((f) => f.field).sort()).toEqual([
      "onlyOnTheFirst",
      "sharedByBothArms",
    ]);
  });

  test("counts a shape exported under two names once", () => {
    const lines = scanned.all.filter((f) => f.owner === "OneShape");
    expect(lines.map((f) => f.field)).toEqual(["namedTwiceOverAllTheSame"]);
  });

  test("leaves alone a shape the file does not export", () => {
    expect(scanned.all.some((f) => f.owner === "NotExported")).toBe(false);
  });

  test("finds a field an exported shape takes from a hidden base", () => {
    expect(verdictOf("Extends", "fromABaseNobodySees")).toBe("never read");
  });

  test("counts a field the shape declares again only once", () => {
    expect(
      scanned.all.filter(
        (f) => f.owner === "Extends" && f.field === "shadowed",
      ),
    ).toHaveLength(1);
  });

  test("finds a field an exported alias takes from an intersection", () => {
    expect(verdictOf("Intersects", "fromAnIntersection")).toBe("never read");
  });

  test("finds a shape exported by a list at the foot of the file", () => {
    expect(verdictOf("ListExported", "onlyInAList")).toBe("never read");
  });

  test("counts a re-exported shape once, where it is declared", () => {
    const totals = scanned.all.filter(
      (f) => f.owner === "Sum" && f.field === "total",
    );
    expect(totals.map((f) => f.file)).toEqual(["src/shapes.ts"]);
  });

  test("finds a shape declared inside a namespace", () => {
    expect(verdictOf("Inner", "onlyInsideNamespace")).toBe("never read");
  });

  test("reports a field of an interface that nothing reads", () => {
    expect(verdictOf("Sum", "noOneReadsThis")).toBe("never read");
  });

  test("sees a field of an exported type alias", () => {
    expect(verdictOf("Report", "headline")).toBe("read");
  });

  test("sees a field of an object type nested in an exported shape", () => {
    expect(verdictOf("Report.nested", "deep")).toBe("read");
  });
});
