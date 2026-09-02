import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { fieldsOf, pathsOf } from "./fields-of-source.ts";

/**
 * How the walk follows a reference: what it does when the compiler cannot
 * see the target, and what it supplies when a shape asks for arguments the
 * caller does not give it.
 */
describe("what the walk does with a reference", () => {
  test("records the field and stops when the target has no shape", async () => {
    const paths = pathsOf(
      await fieldsOf(
        `
import type { NotThere } from "./missing.ts";

interface Targetless {
  unreachableInside: number;
}

export type UsesAMissingTarget = { gone: NotThere; kept: Targetless };
`,
      ),
    );

    expect(paths).toEqual([
      "UsesAMissingTarget.gone",
      "UsesAMissingTarget.kept",
      "UsesAMissingTarget.kept.unreachableInside",
    ]);
  });

  test("tolerates a name no file declares", async () => {
    const paths = pathsOf(
      await fieldsOf(
        `
export type NamesNowhere = { held: WrittenNowhereAtAll };
export type OtherSide = { read: number };
`,
      ),
    );

    expect(paths).toEqual(["NamesNowhere.held", "OtherSide.read"]);
  });

  test("answers a shape's default when the caller supplies nothing", async () => {
    const paths = pathsOf(
      await fieldsOf(
        `
interface SuppliedByDefault {
  reachedThroughTheDefault: number;
}

interface WithDefault<Value = SuppliedByDefault> {
  value: Value;
}

export type UsesTheDefault = WithDefault;
`,
      ),
    );

    expect(paths).toContain("UsesTheDefault.value.reachedThroughTheDefault");
  });

  test("skips the argument when neither supply nor default exists", async () => {
    const paths = pathsOf(
      await fieldsOf(
        `
interface WithoutDefault<Value> {
  value: Value;
}

interface ReachedWhenSupplied {
  onlySeenWhenGiven: number;
}

export type UsesNothing = WithoutDefault;
export type UsesSomething = WithoutDefault<ReachedWhenSupplied>;
`,
      ),
    );

    expect(paths).toContain("UsesSomething.value.onlySeenWhenGiven");
    expect(paths).toContain("UsesNothing.value");
    expect(paths).not.toContain("UsesNothing.value.onlySeenWhenGiven");
  });

  test("keeps standing when an inheritance clause names nothing", async () => {
    const paths = pathsOf(
      await fieldsOf(
        `
interface ReachedThroughAGhost {
  theOnlyField: number;
}

export class GhostBase extends NotWrittenAnywhere {}

export type UsesGhostAndReal = GhostBase | ReachedThroughAGhost;
`,
      ),
    );

    expect(paths).toContain("UsesGhostAndReal.theOnlyField");
  });

  test("counts no export from a file that is not a module", async () => {
    const paths = pathsOf(
      await fieldsOf(
        `
export type UsesAnAmbientTarget = { held: InAScriptFile };
`,
        {
          // No import and no export, so this file offers the walk nothing.
          "plain.ts": `
interface InAScriptFile {
  neverCountedAsExported: number;
}
`,
        },
      ),
    );

    expect(paths).toEqual([
      "UsesAnAmbientTarget.held",
      "UsesAnAmbientTarget.held.neverCountedAsExported",
    ]);
  });

  test("fails loudly when an asynchronous result holds no value", async () => {
    await expect(
      fieldsOf(`
export type HoldsABarePromise = { wrapped: Promise };
`),
    ).rejects.toThrow("The compiler had no asynchronous result type");
  });
});
