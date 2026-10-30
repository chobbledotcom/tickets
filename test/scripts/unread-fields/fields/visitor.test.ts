import { assert, assertArrayIncludes } from "@std/assert";
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

    assertArrayIncludes(paths, [
      "UsesTheDefault.value.reachedThroughTheDefault",
    ]);
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

    assertArrayIncludes(paths, ["UsesSomething.value.onlySeenWhenGiven"]);
    assertArrayIncludes(paths, ["UsesNothing.value"]);
    assert(!paths.includes("UsesNothing.value.onlySeenWhenGiven"));
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

    assertArrayIncludes(paths, ["UsesGhostAndReal.theOnlyField"]);
  });

  test("counts no export from a file that is not a module", async () => {
    const paths = pathsOf(
      await fieldsOf(
        `
export type UsesAnAmbientTarget = { held: InAScriptFile };
`,
        {
          // No import and no export, so this file is not a module: its
          // interface is never an exported target, and the field stays under
          // the caller that holds it.
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

  test("walks the members a repository declaration file declares", async () => {
    // A `.d.ts` file inside the repository is the repository's own code, so
    // the reference to its interface must walk its members, not drop them as
    // a library's. The base is a script's declaration, so it is no exported
    // shape and nothing else reports its member.
    const paths = pathsOf(
      await fieldsOf(
        `
export interface HoldsADeclaredShape {
  base: DeclaredBase;
}
`,
        {
          "globals.d.ts": "interface DeclaredBase { declaredMember: number }\n",
        },
      ),
    );

    expect(paths).toEqual([
      "HoldsADeclaredShape.base",
      "HoldsADeclaredShape.base.declaredMember",
    ]);
  });

  test("walks a repository-declared container as a shape, not a built-in", async () => {
    // A repository `.d.ts` that merges a member into `Set` is repository
    // code. Its `Set` is a shape the walk enters, not the language's element
    // container, so the borrowed member reports and the element step does not.
    const paths = pathsOf(
      await fieldsOf(
        `
export interface HoldsARepositorySet {
  bag: Set<{ insideABag: number }>;
}
`,
        { "globals.d.ts": "interface Set<T> { customField: number }\n" },
      ),
    );

    expect(paths).toEqual([
      "HoldsARepositorySet.bag",
      "HoldsARepositorySet.bag.customField",
    ]);
  });
});
