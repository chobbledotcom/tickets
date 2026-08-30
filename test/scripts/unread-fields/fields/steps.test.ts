import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { scannedFixture } from "#test/scripts/unread-fields/fixture/build.ts";

/**
 * The step a member with no name of its own adds, and what each step keeps
 * apart.
 */
describe("the steps a reader takes", () => {
  const scanned = scannedFixture();
  const verdictOf = scanned.verdictOf;

  test("counts a read of the field the second tuple part writes", () => {
    // `pair[1].sharedByTupleParts` points at the second part, and the first
    // part writes a field of that name down too. Each element is reached by
    // its place, so the two stay two lines.
    expect(verdictOf('Pair["1"]', "sharedByTupleParts")).toBe("read");
    expect(verdictOf('Pair["0"]', "sharedByTupleParts")).toBe("never read");
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
    expect(verdictOf('CarriesATuple["0"]', "sharedWithATuple")).toBe(
      "never read",
    );
  });

  test("tells two tuple elements of one name apart", () => {
    // `pair[0].id` and `pair[1].id` are two fields, and each element is
    // reached by its place, so a read of one never answers for the other.
    expect(verdictOf('CarriesTwoElementsOfOneName["0"]', "id")).toBe("read");
    expect(verdictOf('CarriesTwoElementsOfOneName["1"]', "id")).toBe(
      "never read",
    );
  });

  test("gives a property that holds a call the step a method takes", () => {
    // `run = (input) => x`, `send = function (input) { x }` and
    // `run(input) { return x }` name the input the same way, so every
    // spelling walks under the same `()` step.
    expect(verdictOf("RunsItAsAProperty", "run")).toBe("read");
    expect(
      verdictOf('RunsItAsAProperty.run["()"].input', "arrowSpelling"),
    ).toBe("never read");
    expect(verdictOf("RunsItAsAProperty", "send")).toBe("read");
    expect(
      verdictOf('RunsItAsAProperty.send["()"].input', "writtenOutSpelling"),
    ).toBe("never read");
  });

  test("gives a type written as a function the step a call takes", () => {
    // `takesAnObject: (made: { ... }) => void` holds a call in type
    // position, and its parameter's fields sit under it.
    expect(
      verdictOf(
        'HandsAnObjectOver.takesAnObject["()"].made',
        "insideAParameter",
      ),
    ).toBe("never read");
  });

  test("keeps a setter's quoted name in the path", () => {
    // `set ["settings"](held)` names the setter what the quotes say, so its
    // input walks under it exactly as a plain word's does.
    expect(
      verdictOf("ServesItThroughAQuotedName.value", "besideAQuotedSetter"),
    ).toBe("read");
    expect(
      verdictOf(
        "ServesItThroughAQuotedName.settings.held",
        "throughTheQuotedSetter",
      ),
    ).toBe("never read");
  });

  test("keeps a method's input under the call", () => {
    // A property and a method can share one name, and each holds an `input`
    // of its own. The data sits under the property and the method's input
    // under the call, so a read of one never answers for the other.
    expect(verdictOf("HasAPropertyAndAMethodOfOneName.run.input", "id")).toBe(
      "read",
    );
    expect(
      verdictOf('HasAPropertyAndAMethodOfOneName.run["()"].input', "id"),
    ).toBe("never read");
  });

  test("keeps a getter's value on the property's own path", () => {
    // A reader writes `s.config.dead`, so the getter's return type walks
    // under the property with nothing between.
    expect(verdictOf("ServesItsValueThroughAGetter.config", "dead")).toBe(
      "read",
    );
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

  test("still sees a field a readonly array hands out", () => {
    // `readonly` is a type operator too, and this one does hand a field out.
    // The list still takes its step, because a reader writes `kept[0]`.
    expect(verdictOf('StillHandsOneOut["[]"]', "keptByReadonly")).toBe(
      "never read",
    );
  });

  test("sees a field of an object type a generic holds", () => {
    // `Array<{ id }>` and `Record<string, { id }>` both hand the inner shape
    // on, and a reader reaches it as `rows.inAnArray[0].insideAnArray`.
    expect(
      verdictOf('HoldsThingsInGenerics.inAnArray["[]"]', "insideAnArray"),
    ).toBe("read");
    expect(
      verdictOf('HoldsThingsInGenerics.inARecord["[]"]', "insideARecord"),
    ).toBe("never read");
  });

  test("keeps a field and a list of the same name apart", () => {
    // `{ shared: string } & Array<{ shared: number }>` declares the name
    // twice. One is `h.shared` and the other is `h[0].shared`, so one line
    // for both would let the read of the first speak for the second.
    expect(verdictOf("HoldsAListOfTheSameName", "sharedWithAList")).toBe(
      "read",
    );
    expect(verdictOf('HoldsAListOfTheSameName["[]"]', "sharedWithAList")).toBe(
      "never read",
    );
  });

  test("gives a list the same step however it is written", () => {
    // `T[]`, `readonly T[]` and `ReadonlyArray<T>` all reach an element the
    // way `Array<T>` does, so each spelling has to take the step.
    expect(
      verdictOf('WritesAListEveryWay.withBrackets["[]"]', "insideBrackets"),
    ).toBe("never read");
    expect(
      verdictOf('WritesAListEveryWay.withReadonly["[]"]', "insideReadonly"),
    ).toBe("never read");
    expect(
      verdictOf(
        'WritesAListEveryWay.namedReadonly["[]"]',
        "insideNamedReadonly",
      ),
    ).toBe("never read");
  });

  test("gives a set and a map the step a list takes", () => {
    // Each holds many, so a field of the shape and a field of what it holds
    // are two fields, exactly as with a list. A map's value takes the
    // `values()` step, because that is how a reader reaches it.
    expect(verdictOf('HoldsManyOtherWays.inASet["[]"]', "insideASet")).toBe(
      "never read",
    );
    expect(
      verdictOf('HoldsManyOtherWays.inAMap["values()"]', "insideAMap"),
    ).toBe("never read");
    expect(
      verdictOf(
        'HoldsManyOtherWays.inAReadonlySet["[]"]',
        "insideAReadonlySet",
      ),
    ).toBe("never read");
    expect(
      verdictOf(
        'HoldsManyOtherWays.inAReadonlyMap["values()"]',
        "insideAReadonlyMap",
      ),
    ).toBe("never read");
  });

  test("gives a Record the step its index signature spelling takes", () => {
    // `Record<string, T>` and `{ [k: string]: T }` are one type written two
    // ways, so a reader writes `rec[key].inside` for both.
    expect(
      verdictOf('HoldsThingsInGenerics.inARecord["[]"]', "insideARecord"),
    ).toBe("never read");
  });
});
