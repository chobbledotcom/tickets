import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { scannedFixture } from "#test/scripts/unread-fields/fixture/build.ts";

/**
 * Which parts of a shape hold fields, and which hold none.
 */
describe("what the walk goes into", () => {
  const scanned = scannedFixture();
  const verdictOf = scanned.verdictOf;

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
    // The call is a step of its own: the field is not `takesAnObject.made`,
    // it is what a caller passes to `takesAnObject(...)`.
    expect(
      verdictOf(
        'HandsAnObjectOver.takesAnObject["()"].made',
        "insideAParameter",
      ),
    ).toBe("never read");
  });

  test("leaves out a field that only a type parameter's constraint holds", () => {
    // `<T extends { id: number }>` describes T, exactly as a shape's own type
    // parameters do, so `id` is no field the shape hands out.
    expect(
      scanned.all.filter((f) => f.owner.startsWith("HandsAnObjectOver.mapped")),
    ).toEqual([]);
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

  test("leaves out a field only a filter's argument names", () => {
    // `Extract<T, { picked: true }>` and `Exclude<T, { picked: true }>` say
    // which arms of T to keep. The argument is a filter, and no value of the
    // shape has its fields.
    const leaked = scanned.all.filter((f) => f.field.endsWith("ByAFilter"));
    expect(leaked).toEqual([]);
  });

  test("leaves out the arm a conditional does not answer with", () => {
    // `true extends true ? A : B` is only ever A, so no value holds a B field.
    expect(verdictOf("ResolvedByItsCheck", "keptByTheAnswer")).toBe(
      "never read",
    );
    expect(
      verdictOf("ResolvedByItsCheck", "droppedByTheAnswer"),
    ).toBeUndefined();
  });

  test("reads the repository's own compiler options", () => {
    // The fixture asks for strict, where `undefined extends string` is false.
    // Without those options the scan would answer with the other arm.
    expect(verdictOf("StrictnessDecides", "onlyWhenStrict")).toBe("never read");
    expect(verdictOf("StrictnessDecides", "onlyWhenLoose")).toBeUndefined();
  });

  test("leaves out a key that Omit removed", () => {
    expect(verdictOf("OmittedAway", "keptByOmit")).toBe("never read");
    expect(verdictOf("OmittedAway", "removedByOmit")).toBeUndefined();
  });

  test("leaves out a key that Pick did not take", () => {
    expect(verdictOf("PickedOut", "keptByPick")).toBe("never read");
    expect(verdictOf("PickedOut", "notPicked")).toBeUndefined();
  });

  test("leaves out a local inside a static block", () => {
    expect(
      verdictOf("RunsABlockWhenMade", "hiddenInsideTheBlock"),
    ).toBeUndefined();
    expect(verdictOf("RunsABlockWhenMade", "reachedOnAValue")).toBe(
      "never read",
    );
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

  test("leaves out a type a hash-private member keeps to itself", () => {
    // `#kept` says it is private with its name rather than with a word, and
    // the type written inside it is out of reach for the same reason.
    const lines = scanned.all.filter((f) =>
      f.owner.startsWith("KeepsAHashPrivate"),
    );
    expect(lines.map((f) => f.field)).toEqual(["show"]);
  });

  test("goes into the type of a parameter the class keeps to itself", () => {
    // The word hides the field, and the constructor stays everyone's to call,
    // so a caller still has to supply what the parameter holds.
    expect(verdictOf("Holder.options", "suppliedByCallers")).toBe("never read");
  });

  test("stays out of the type of a property the class keeps to itself", () => {
    expect(verdictOf("Keeps.held", "keptInsideToo")).toBeUndefined();
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
    // are two fields, exactly as with a list.
    expect(verdictOf('HoldsManyOtherWays.inASet["[]"]', "insideASet")).toBe(
      "never read",
    );
    expect(verdictOf('HoldsManyOtherWays.inAMap["[]"]', "insideAMap")).toBe(
      "never read",
    );
    expect(
      verdictOf(
        'HoldsManyOtherWays.inAReadonlySet["[]"]',
        "insideAReadonlySet",
      ),
    ).toBe("never read");
    expect(
      verdictOf(
        'HoldsManyOtherWays.inAReadonlyMap["[]"]',
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

  test("reads the key an indexed access keeps, and not the one it drops", () => {
    // No value of `{ ... }["keptByTheKey"]` holds the dropped key, so the
    // walk stays out of both operands and the checker says what is left.
    expect(verdictOf("PickedByAKey", "keptInsideTheKey")).toBe("never read");
    expect(verdictOf("PickedByAKey", "droppedByTheKey")).toBeUndefined();
  });
});
