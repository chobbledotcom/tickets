import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import {
  collectFeaturePaths,
  parseSpecOwners,
  readSpecCatalog,
} from "#scripts/specs/catalog.ts";

const FEATURE_PATH = "specs/payments/capacity-after-payment.feature";

describe("Cucumber story catalog", () => {
  test("reads the repository catalog from a directory or exact Feature", async () => {
    const complete = await readSpecCatalog();
    const focused = await readSpecCatalog([FEATURE_PATH]);

    expect(complete.stories).toEqual(focused.stories);
    expect(complete.stories.map(({ id }) => id)).toEqual([
      "payments.capacity-after-payment",
    ]);
  });

  test("sorts and removes duplicate Feature paths", async () => {
    const paths = await collectFeaturePaths([FEATURE_PATH, FEATURE_PATH]);
    expect(paths).toHaveLength(1);
    const path = paths[0];
    if (path === undefined) throw new Error("Expected one Feature path");
    expect(path.endsWith(FEATURE_PATH)).toBe(true);
  });

  test("rejects a requested path with no Features", async () => {
    expect(await collectFeaturePaths(["specs/owners.json"])).toEqual([]);
    await expect(readSpecCatalog(["specs/owners.json"])).rejects.toThrow(
      "No Cucumber Feature files found",
    );
  });

  test("validates the owner registry at its JSON boundary", () => {
    expect(parseSpecOwners({ owners: ["payments"] })).toEqual(["payments"]);
    for (const invalid of [
      {},
      { owners: [] },
      { owners: [""] },
      { owners: ["payments", "payments"] },
      { owners: ["   "] },
      { extra: true, owners: ["payments"] },
      null,
    ]) {
      expect(() => parseSpecOwners(invalid)).toThrow();
    }
  });
});
