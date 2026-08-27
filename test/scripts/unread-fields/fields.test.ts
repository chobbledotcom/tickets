import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { scannedFixture } from "./fixture/build.ts";
import { EVERY_FIELD } from "./fixture/every-field.ts";

/**
 * Which shapes the scan looks at, and which of their fields it counts.
 */
describe("the shapes the scan finds", () => {
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

  test("reads a conditional type's answer, not the type it checks", () => {
    // `R extends { paid: number } ? { paid: string } : never` names `paid`
    // twice. Only the branch declares a member, so one line comes back.
    expect(verdictOf("OnlyWhenItFits", "answeredByTheBranch")).toBe(
      "never read",
    );
    expect(verdictOf("OnlyWhenItFits", "checkedNotDeclared")).toBeUndefined();
  });

  test("keeps a borrowed field a nested one shares a name with", () => {
    // The nested field and the borrowed one are different fields that happen
    // to share a name. Counting the nested one as the shape's own would hide
    // the borrowed one, which a reader reaches straight off the shape.
    const lines = scanned.all.filter((f) => f.owner === "NestsTheSameName");
    expect(lines.map((f) => f.field).sort()).toEqual([
      "inside",
      "sharedNameDifferentField",
    ]);
    expect(
      scanned.all.some(
        (f) =>
          f.owner === "NestsTheSameName.inside" &&
          f.field === "sharedNameDifferentField",
      ),
    ).toBe(true);
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

  test("leaves out a made-up field a mapped type renames into being", () => {
    // `catalog-fields/definition.ts` renames its keys this way. Such a field
    // is written down nowhere, so there is no identifier to look up.
    expect(scanned.all.filter((f) => f.owner === "Renamings")).toEqual([]);
  });

  test("leaves out the built-in members an alias to a number resolves to", () => {
    expect(scanned.all.filter((f) => f.owner === "ItsType")).toEqual([]);
  });

  test("leaves out a type a method declares inside its body", () => {
    // The method itself is a field of the class. The local type inside it
    // cannot leave the method, so it is not.
    const lines = scanned.all.filter(
      (f) => f.owner === "DeclaresATypeInAMethod",
    );
    expect(lines.map((f) => f.field)).toEqual(["measure"]);
  });

  test("sees a field inside a parameter of a function the shape hands out", () => {
    // Whoever calls it has to build that object, so its fields are reachable.
    expect(
      verdictOf("HandsAnObjectOver.takesAnObject", "insideAParameter"),
    ).toBe("never read");
  });

  test("leaves out a field that only a type parameter's constraint holds", () => {
    // `<T extends { id: number }>` describes T, exactly as a shape's own type
    // parameters do, so `id` is no field the shape hands out.
    expect(
      scanned.all.filter((f) => f.owner.startsWith("HandsAnObjectOver.mapped")),
    ).toEqual([]);
  });

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

  test("leaves out a type a class keeps to itself", () => {
    // Nobody outside reaches the private member, so nobody reaches its type
    // either. The public method beside it is still a field.
    const lines = scanned.all.filter((f) =>
      f.owner.startsWith("KeepsSecretsInside"),
    );
    expect(lines.map((f) => f.field)).toEqual(["read"]);
  });

  test("leaves out the fields a keyof only names", () => {
    // `keyof Row` is the words a shape's fields are called, not the fields.
    expect(scanned.all.filter((f) => f.owner.includes("Keys"))).toEqual([]);
  });

  test("still sees a field a readonly array hands out", () => {
    // `readonly` is a type operator too, and this one does hand a field out.
    expect(verdictOf("StillHandsOneOut", "keptByReadonly")).toBe("never read");
  });

  test("sees a field of an object type a generic holds", () => {
    // `Array<{ id }>` and `Record<string, { id }>` both hand the inner shape
    // on, and a reader reaches it as `rows.inAnArray[0].insideAnArray`.
    expect(verdictOf("HoldsThingsInGenerics.inAnArray", "insideAnArray")).toBe(
      "read",
    );
    expect(verdictOf("HoldsThingsInGenerics.inARecord", "insideARecord")).toBe(
      "never read",
    );
  });

  test("leaves out a field only a filter's argument names", () => {
    // `Extract<T, { picked: true }>` and `Exclude<T, { picked: true }>` say
    // which arms of T to keep. The argument is a filter, and no value of the
    // shape has its fields.
    const leaked = scanned.all.filter(
      (f) =>
        f.field.endsWith("OnlyNamedByAFilter") || f.field.endsWith("ByAFilter"),
    );
    expect(leaked).toEqual([]);
  });

  test("sees a static a class declares itself", () => {
    expect(verdictOf("HasAStaticAndAccessors", "madeOnTheClass")).toBe(
      "never read",
    );
    expect(verdictOf("HasAStaticAndAccessors", "make")).toBe("never read");
  });

  test("gives a getter and its setter one line, and counts the read", () => {
    expect(verdictOf("HasAStaticAndAccessors", "bothWays")).toBe("read");
  });

  test("leaves out an accessor that only takes a value in", () => {
    // `h.writeOnly = next` calls the setter, and the scan asks whether a
    // value comes out. A set-only accessor has none, so it is no field.
    expect(verdictOf("HasAStaticAndAccessors", "writeOnly")).toBeUndefined();
  });

  test("leaves out an arm a filter dropped", () => {
    // `Extract<A | B, { whichArm: "kept" }>` keeps one arm, so the other's
    // fields are no longer fields of the shape.
    expect(verdictOf("DroppedByAFilter", "keptByTheFilter")).toBe("never read");
    expect(verdictOf("DroppedByAFilter", "droppedByTheFilter")).toBeUndefined();
  });

  test("puts a field a method takes under that method", () => {
    // Two methods can take an object with the same field name, and the two
    // are different fields. Under the class they would read as one.
    expect(verdictOf("TakesObjectsInMethods.send", "sameNameInBoth")).toBe(
      "never read",
    );
    expect(verdictOf("TakesObjectsInMethods.post", "sameNameInBoth")).toBe(
      "never read",
    );
  });

  test("leaves out a type a hash-private member keeps to itself", () => {
    // `#kept` says it is private with its name rather than with a word, and
    // the type written inside it is out of reach for the same reason.
    const lines = scanned.all.filter((f) =>
      f.owner.startsWith("KeepsAHashPrivate"),
    );
    expect(lines.map((f) => f.field)).toEqual(["show"]);
  });

  test("tells a name that holds a dot from a path built with dots", () => {
    // `"a.b": string` and `a: { b: string }` read the same once the path is
    // joined, and they are two different fields.
    expect(verdictOf("NameHoldsADot", "hasADotInIts.name")).toBe("never read");
    expect(verdictOf("NameHoldsADot", "hasADotInIts")).toBe("never read");
    expect(verdictOf("NameHoldsADot.hasADotInIts", "name")).toBe("never read");
  });

  test("reports every field of every exported shape, and only those", () => {
    expect(scanned.all.map((f) => `${f.owner}.${f.field}`).sort()).toEqual([
      ...EVERY_FIELD,
    ]);
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
