import { assert, assertArrayIncludes } from "@std/assert";
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

    assertArrayIncludes(paths, [
      "UsesTheClass.heldByAParameter.insideAParameter",
    ]);
    assert(!paths.includes("UsesTheClass.hiddenByAParameter"));
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

    assertArrayIncludes(paths, [
      'typeof HoldsAMadeClass.made["new ()"].result.configured.insideTheProperty',
    ]);
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

    assertArrayIncludes(paths, ["typeof HoldsAMadeClass.made.builtOn"]);
  });

  test("keeps a field a repository declaration file writes down", async () => {
    // A `.d.ts` file inside the repository is the repository's own code, not
    // a library. Its `isDeclarationFile` flag is set all the same, so the
    // ownership question has to be a path check, not a flag. The base is a
    // script's declaration, so it is no exported shape and nothing but the
    // borrowed-field walk reports its member.
    const paths = pathsOf(
      await fieldsOf(
        `
export interface ExtendsADeclaredBase extends Base {}
`,
        { "globals.d.ts": "interface Base { declaredField: number }\n" },
      ),
    );

    expect(paths).toEqual(["ExtendsADeclaredBase.declaredField"]);
  });

  test("keeps a call signature a repository declaration file writes down", async () => {
    const paths = pathsOf(
      await fieldsOf(
        `
export type UsesACall = Callable;
`,
        {
          "globals.d.ts":
            "interface Callable { (input: { onlyInCall: number }): void }\n",
        },
      ),
    );

    expect(paths).toEqual(['UsesACall["()"].input.onlyInCall']);
  });
});
