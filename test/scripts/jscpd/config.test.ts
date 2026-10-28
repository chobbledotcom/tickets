import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { projectRoot } from "#scripts/project-root.ts";

/** The strict scans share one agreement: names, literals and annotations do
 * not make a clone, and only kind `exact` is reported. The four files repeat
 * the block by hand, so this test fails when one of them drifts. */
const strictScans = [
  ".jscpd.json",
  ".jscpd.test.json",
  ".jscpd.helpers.json",
  ".jscpd.support.json",
] as const;

describe("strict jscpd scans", () => {
  test("carry the Type-2 clone options and report only exact clones", async () => {
    for (const name of strictScans) {
      const config = JSON.parse(
        await Deno.readTextFile(`${projectRoot}/${name}`),
      ) as Record<string, unknown>;
      expect(config.ignoreIdentifiers, name).toBe(true);
      expect(config.ignoreLiterals, name).toBe(true);
      expect(config.ignoreAnnotations, name).toBe(true);
      expect(config.kind, name).toEqual(["exact"]);
    }
  });
});
