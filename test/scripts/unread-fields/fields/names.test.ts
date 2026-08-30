import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
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
    expect(verdictOf('Callable["()"].result', "sharedByBothWays")).toBe(
      "never read",
    );
  });

  test("sees a field a construct signature hands back", () => {
    expect(verdictOf('Constructable["new ()"].result', "handedBackByNew")).toBe(
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
    // part writes a field of that name down too. Both sit under the step a
    // tuple element takes.
    expect(verdictOf('Pair["[]"]', "sharedByTupleParts")).toBe("read");
  });

  test("counts a read of the field two arms of four write down", () => {
    // `QuantityRule.qty` in `src/shared/booking/tree.ts` is this shape, and
    // the report called it never read while one line away production reads it.
    expect(verdictOf("OneArmOrTheOther", "declaredByTwoArms")).toBe("read");
  });

  test("keeps a field under the index off the shape's own path", () => {
    // `bag[key].sharedName` is a step away from `bag.sharedName`. Without the
    // step the two are one line, and a read of the named one covers both.
    expect(verdictOf('Indexed["[]"]', "sharedName")).toBe("never read");
  });

  test("keeps what a call hands back off the shape's own path", () => {
    // `held.sharedWithTheCall` and `held().sharedWithTheCall` are two fields.
    // Without the step through the call they are one line and one verdict.
    expect(verdictOf('CalledForIt["()"].result', "sharedWithTheCall")).toBe(
      "never read",
    );
  });

  test("keeps what a new hands back off the shape's own path", () => {
    expect(verdictOf('BuiltForIt["new ()"].result', "sharedWithTheNew")).toBe(
      "never read",
    );
  });

  test('tells a field called "()" from what the call hands back', () => {
    // Both lines carry the same label, and they are two fields. A read of the
    // one that is really called `"()"` must not answer for the call.
    const lines = scanned.all.filter(
      (f) =>
        (f.owner === 'CollidesWithItsCall["()"]' ||
          f.owner === 'CollidesWithItsCall["()"].result') &&
        f.field === "sharedWithTheLabel",
    );
    expect(lines.map((f) => f.verdict).sort()).toEqual(["never read", "read"]);
  });

  test("keeps a constructor input apart from a same-named field", () => {
    // The caller supplies the input through `new ()`, and the `id` the
    // field holds is not the `id` the caller supplies. One line for both
    // would let the read of the field speak for the input nothing reads.
    expect(verdictOf("AcceptsOptionsOfItsOwn.options", "id")).toBe("read");
    expect(verdictOf('AcceptsOptionsOfItsOwn["new ()"].options', "id")).toBe(
      "never read",
    );
  });

  test("keeps a setter's input under the setter's name", () => {
    // `value.kept` on the field and `value.kept` through the setter are two
    // fields, and only the step through the setter tells them apart.
    expect(verdictOf("ServesSettingsThroughASetter.value", "kept")).toBe(
      "read",
    );
    expect(
      verdictOf("ServesSettingsThroughASetter.settings.value", "kept"),
    ).toBe("never read");
  });

  test("walks a setter's input beside the class when its name is worked out", () => {
    // The setter's name only exists when the program runs, so there is no
    // word to walk under. The input takes the path of a plain parameter.
    expect(
      verdictOf("ServesThroughAWorkedOutName.held", "throughTheWorkedOutName"),
    ).toBe("never read");
  });

  test("tells a call's input from its result", () => {
    // The input walks under its parameter name and the result under
    // `result`, so a reader of the input cannot speak for the result.
    expect(verdictOf('CallsItBothWays["()"].input', "sameAtBothEnds")).toBe(
      "read",
    );
    expect(
      verdictOf('CallsItBothWays["()"].result.input', "sameAtBothEnds"),
    ).toBe("never read");
  });

  test("tells a map's keys from its values", () => {
    // `keys()` and `values()` reach two different fields, so a read of the
    // values cannot speak for the keys.
    expect(
      verdictOf('HoldsBothEndsOfAMap.bothEnds["values()"]', "sharedAtBothEnds"),
    ).toBe("read");
    expect(
      verdictOf('HoldsBothEndsOfAMap.bothEnds["keys()"]', "sharedAtBothEnds"),
    ).toBe("never read");
  });

  test("gives a mapped member its own step", () => {
    // `m.sharedWithAMapped` and `m.one.sharedWithAMapped` are two fields. The
    // mapped value takes the step an index signature takes.
    expect(verdictOf("MapsItsValues", "sharedWithAMapped")).toBe("read");
    expect(verdictOf('MapsItsValues["[]"]', "sharedWithAMapped")).toBe(
      "never read",
    );
  });

  test("gives a tuple element its own step", () => {
    // `c.sharedWithATuple` and `c[0].sharedWithATuple` are two fields. A
    // tuple reaches its elements exactly as a list does.
    expect(verdictOf("CarriesATuple", "sharedWithATuple")).toBe("read");
    expect(verdictOf('CarriesATuple["[]"]', "sharedWithATuple")).toBe(
      "never read",
    );
  });

  test("reads a member name a template literal spells", () => {
    // `` [`foo`]: number `` names the field `x.foo`, exactly as `"foo": number`
    // does, so it counts and its read counts.
    expect(verdictOf("NamedByALiteral", "templated")).toBe("read");
  });

  test("walks only what an inferred conditional resolved to", () => {
    // The answer is the substituted type, so `held` is a field and `gone` is
    // a shape no value holds. Before, the walk took the false arm and
    // invented it.
    expect(verdictOf("ResolvesThroughInfer", "held")).toBe("read");
    expect(verdictOf("ResolvesThroughInfer", "gone")).toBeUndefined();
  });
});
