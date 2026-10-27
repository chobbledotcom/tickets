import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import type { NameIndex } from "#db/name-registry.ts";
import {
  firstReferenceError,
  resolvedReference,
  resolveReferences,
  siteIdsOf,
  siteParentIdsOf,
} from "#routes/admin/catalog-transfer/bundle-refs.ts";

/** A site index with one listing and two legacy rows of one name. */
const siteIndex: NameIndex = new Map([
  ["stored", [5]],
  ["legacy", [8, 9]],
]);

describe("bundle reference resolution", () => {
  test("resolves a bundle item first, then a stored row", () => {
    const refs = resolveReferences(
      ["Own", "Stored"],
      new Map([["own", 3]]),
      siteIndex,
      "listing",
    );
    expect(refs.get("Own")).toEqual({ bundleKey: "own" });
    expect(refs.get("Stored")).toEqual({ siteId: 5 });
  });

  test("refuses a name the site does not hold", () => {
    const refs = resolveReferences(
      ["Missing"],
      new Map(),
      siteIndex,
      "listing",
    );
    expect(refs.get("Missing")).toEqual({
      error:
        'No listing named "Missing" exists — it must already exist to import this reference.',
    });
  });

  test("refuses an ambiguous stored name", () => {
    const refs = resolveReferences(["Legacy"], new Map(), siteIndex, "group");
    expect(refs.get("Legacy")).toEqual({
      error:
        'More than one group is named "Legacy"; names must be unique to import by name.',
    });
  });

  test("refuses a name the document references more than once", () => {
    const refs = resolveReferences(
      ["Own", "Own"],
      new Map([["own", 3]]),
      siteIndex,
      "listing",
    );
    const repeated = refs.get("Own")!;
    expect("error" in repeated && repeated.error).toContain(
      "referenced more than once",
    );
  });

  test("resolvedReference skips an error entry and an absent name", () => {
    const refs = resolveReferences(
      ["Stored", "Missing"],
      new Map(),
      siteIndex,
      "listing",
    );
    // Every name the map holds answers its reference or undefined — the
    // error entry itself never escapes.
    expect(
      [...refs.keys()].map((name) => resolvedReference(refs, name)),
    ).toEqual([{ siteId: 5 }, undefined]);
    // A name the map does not hold answers undefined too.
    expect(resolvedReference(refs, "Absent")).toEqual(undefined);
  });

  test("firstReferenceError returns the first refusal, or null", () => {
    const refs = resolveReferences(
      ["Missing", "Legacy"],
      new Map(),
      siteIndex,
      "listing",
    );
    expect(firstReferenceError(refs)).toContain("No listing named");
    expect(
      firstReferenceError(
        resolveReferences([], new Map(), siteIndex, "listing"),
      ),
    ).toBeNull();
  });

  test("siteIdsOf collects the stored ids and skips bundle keys", () => {
    const refs = resolveReferences(
      ["Stored", "Own", "Legacy"],
      new Map([["own", 3]]),
      siteIndex,
      "listing",
    );
    expect(siteIdsOf(refs)).toEqual([5]);
    expect(
      siteParentIdsOf(new Map([["item", { groups: refs, parents: refs }]])),
    ).toEqual([5]);
  });
});
