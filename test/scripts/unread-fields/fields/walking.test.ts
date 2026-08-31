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
    // to share a name. To count the nested one as the shape's own would hide
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
    // so a caller still has to supply what the parameter holds. The input
    // walks under `new ()`, because that is what supplies it.
    expect(verdictOf('Holder["new ()"].options', "suppliedByCallers")).toBe(
      "never read",
    );
  });

  test("stays out of the type of a property the class keeps to itself", () => {
    expect(verdictOf("Keeps.held", "keptInsideToo")).toBeUndefined();
  });

  test("reads the key an indexed access keeps, and not the one it drops", () => {
    // No value of `{ ... }["keptByTheKey"]` holds the dropped key, so the
    // walk stays out of both operands and the checker says what is left.
    expect(verdictOf("PickedByAKey", "keptInsideTheKey")).toBe("never read");
    expect(verdictOf("PickedByAKey", "droppedByTheKey")).toBeUndefined();
  });

  test("tells two parameters of one method apart", () => {
    // Both parameters hold a field of the same name, and one line for the
    // two would let a read of either speak for both. The inputs sit under
    // the call the method takes.
    expect(
      verdictOf('TakesTwoObjects.send["()"].first', "sameNameInBothParameters"),
    ).toBe("never read");
    expect(
      verdictOf(
        'TakesTwoObjects.send["()"].second',
        "sameNameInBothParameters",
      ),
    ).toBe("never read");
  });

  test("tells a parameter with no name of its own by its place", () => {
    expect(
      verdictOf(
        'TakesADestructuredObject.handle["()"]["0"]',
        "onlyInsideADestructured",
      ),
    ).toBe("never read");
  });

  test("puts a field a method takes under that method", () => {
    // Two methods can take an object with the same field name, and the two
    // are different fields. Under the class they would read as one.
    expect(
      verdictOf('TakesObjectsInMethods.send["()"].value', "sameNameInBoth"),
    ).toBe("never read");
    expect(
      verdictOf('TakesObjectsInMethods.post["()"].value', "sameNameInBoth"),
    ).toBe("never read");
  });

  test("walks only what an inferred conditional resolved to", () => {
    // The answer is the substituted type, so `held` is a field and `gone` is
    // a shape no value holds. Before, the walk took the false arm and
    // invented it.
    expect(verdictOf("ResolvesThroughInfer", "held")).toBe("read");
    expect(verdictOf("ResolvesThroughInfer", "gone")).toBeUndefined();
  });

  test("walks a resolved arm that is itself a union", () => {
    // An arm written as a union equals the whole the checker answers with,
    // so the walk takes that arm only. The other arm's `ghost` is one no
    // value of this shape ever had.
    expect(verdictOf("AnswersWithAUnion", "liveA")).toBe("read");
    expect(verdictOf("AnswersWithAUnion", "liveB")).toBe("never read");
    expect(verdictOf("AnswersWithAUnion", "ghost")).toBeUndefined();
  });

  test("leaves out what a ReturnType's call takes as an input", () => {
    // `ReturnType` names a call whose answer is the shape. The input the
    // call takes is nobody's to read, and no value of the shape holds it:
    // walked by mistake, it would sit under the call the type spells.
    expect(verdictOf("WhatItGivesBack", "given")).toBe("read");
    expect(
      verdictOf('WhatItGivesBack["()"].input', "givenToTheCall"),
    ).toBeUndefined();
    expect(verdictOf("WhatItGivesBack", "givenToTheCall")).toBeUndefined();
  });

  test("leaves a generic's argument to the checker that resolves it", () => {
    // `Carries<What>` puts its argument under a named member of its own, so
    // the argument's field never joins the outer shape's path. Before, both
    // `shared` declarations shared one key and a read of either answered for
    // both.
    expect(verdictOf("ReachesThroughAGeneric", "shared")).toBe("read");
    expect(verdictOf("ReachesThroughAGeneric", "value")).toBe("never read");
    expect(
      verdictOf("ReachesThroughAGeneric", "keptInsideTheBox"),
    ).toBeUndefined();
  });

  test("keeps the members a pass-through generic hands on", () => {
    // `Partial`, `Required` and `Readonly` all keep every member of their
    // argument at the outer path, with no step between.
    expect(verdictOf("PassedThroughPartially", "carriedThroughUntouched")).toBe(
      "read",
    );
    expect(verdictOf("PassedThroughPartially", "keptCompletelyUnread")).toBe(
      "never read",
    );
    expect(
      verdictOf("PassedThroughPartially.carriedNested", "deepInsideThePartial"),
    ).toBe("read");
    expect(verdictOf("PassedThroughReadonly", "frozenButRead")).toBe(
      "never read",
    );
    expect(
      verdictOf("PassedThroughReadonly.heldNested", "deepInsideTheFreeze"),
    ).toBe("read");
    expect(
      verdictOf("PassedThroughRequired.maybeMissing", "readOnceFilled"),
    ).toBe("read");
  });

  test("keeps the arguments of the generics the walk holds", () => {
    // A map's value and an array's element stay within the walk's reach,
    // whatever other step their path takes.
    expect(
      verdictOf('HoldsManyOtherWays.inAMap["values()"]', "insideAMap"),
    ).toBe("never read");
    expect(
      verdictOf('HoldsThingsInGenerics.inAnArray["[]"]', "insideAnArray"),
    ).toBe("read");
  });

  test("does not take a borrowed name for the built-in it spells", () => {
    // The repository's own `Partial` is not the built-in: it hands its
    // argument on under a named member of its own, so the walk leaves the
    // argument to the checker and the outer field keeps its own line.
    expect(verdictOf("UsesABorrowedName", "shared")).toBe("read");
    expect(verdictOf("UsesABorrowedName", "held")).toBe("never read");
  });

  test("keeps every fixed-key symbol that shares one field line", () => {
    // The reader narrows to the second arm. Its synthetic symbol differs from
    // the first arm's, although both keys belong to one reported field.
    expect(verdictOf("FixedInTwoArms", "same")).toBe("read");
  });

  test("keeps the inputs of call types an alias borrows", () => {
    expect(verdictOf('BorrowsACall["()"].input', "onlyInBorrowedCall")).toBe(
      "never read",
    );
  });

  test("keeps the inputs of construct types an alias borrows", () => {
    expect(
      verdictOf(
        'BorrowsAConstruct["new ()"].options',
        "onlyInBorrowedConstruct",
      ),
    ).toBe("never read");
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
});
