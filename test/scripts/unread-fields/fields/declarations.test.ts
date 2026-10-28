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

  test("reads the keys an object literal gives a class field", async () => {
    // `config = { dead: 1 }` puts `dead` in the public type, and a caller
    // reaches `holder.config.dead`, so the key is a field of its own, not
    // just `config` a line that stops.
    const paths = pathsOf(
      await fieldsOf(
        `
export class Holder {
  config = { dead: 1 };
}
`,
      ),
    );

    expect(paths).toEqual(["Holder.config", "Holder.config.dead"]);
  });

  test("reads the keys of a nested object literal", async () => {
    const paths = pathsOf(
      await fieldsOf(
        `
export class Holder {
  config = { nested: { deep: 1 } };
}
`,
      ),
    );

    expect(paths).toEqual([
      "Holder.config",
      "Holder.config.nested",
      "Holder.config.nested.deep",
    ]);
  });

  test("reads a quoted key of an object literal", async () => {
    const paths = pathsOf(
      await fieldsOf(
        `
export class Holder {
  config = { "quoted-name": 1 };
}
`,
      ),
    );

    expect(paths).toEqual(["Holder.config", 'Holder.config["quoted-name"]']);
  });

  test("leaves out a key a computed name works out", async () => {
    // `[key]` names the key only when the program runs, so there is no fixed
    // field to report.
    const paths = pathsOf(
      await fieldsOf(
        `
const key = "computed";
export class Holder {
  config = { [key]: 1 };
}
`,
      ),
    );

    expect(paths).toEqual(["Holder.config"]);
  });

  test("reads the keys an array literal holds one element step down", async () => {
    // `config = [{ id: 1 }]` reaches `config[0].id`, so the key sits under
    // the same `[]` step an `Array` type takes.
    const paths = pathsOf(
      await fieldsOf(
        `
export class Holder {
  config = [{ id: 1 }];
}
`,
      ),
    );

    expect(paths).toEqual(["Holder.config", 'Holder.config["[]"].id']);
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
