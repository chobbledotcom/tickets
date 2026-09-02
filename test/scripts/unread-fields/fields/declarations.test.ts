import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { fieldsOf, pathsOf } from "./fields-of-source.ts";

/**
 * What the walk finds written inside a shape's walls: the members a class
 * keeps, and how a class expression hands a field to the value it builds.
 */
describe("what the walk finds inside a shape", () => {
  test("walks a class a type names, keeping its parameter fields", async () => {
    const paths = pathsOf(
      await fieldsOf(
        `
class CarriesParameterFields extends Object {
  static alsoOnTheClass = 1;

  constructor(
    public heldByAParameter: { insideAParameter: number },
    private hiddenByAParameter: { neverSeen: number },
    plainTakenIn: { neverSeenEither: number },
  ) {
    super();
  }
}

export type UsesTheClass = CarriesParameterFields;
`,
      ),
    );

    expect(paths).toContain("UsesTheClass.heldByAParameter.insideAParameter");
    expect(paths).not.toContain("UsesTheClass.hiddenByAParameter");
    expect(paths).toEqual([
      "UsesTheClass.heldByAParameter",
      "UsesTheClass.heldByAParameter.insideAParameter",
    ]);
  });

  test("walks the field a class expression builds for its holder", async () => {
    const paths = pathsOf(
      await fieldsOf(
        `
export class HoldsAMadeClass {
  static made = class {
    constructor(public configured: { insideTheProperty: number }) {}
  };
}
`,
      ),
    );

    expect(paths).toContain(
      'typeof HoldsAMadeClass.made["new ()"].result.configured.insideTheProperty',
    );
  });

  test("walks a static made inside an already-static holder", async () => {
    const paths = pathsOf(
      await fieldsOf(
        `
export class HoldsAMadeClass {
  static made = class {
    static builtOn = 1;
  };
}
`,
      ),
    );

    expect(paths).toContain("typeof HoldsAMadeClass.made.builtOn");
  });
});
