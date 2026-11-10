import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import {
  type FindingIdentity,
  findingIdentityKey,
} from "#scripts/unread-fields/identity.ts";

export const expectStableUniqueIdentities = (
  identities: readonly FindingIdentity[],
): void => {
  const keys = identities.map(findingIdentityKey);
  expect(keys.length).toBeGreaterThan(0);
  expect(new Set(keys).size).toBe(keys.length);
  expect(keys).toEqual([...keys].toSorted());
};

/** One test for each malformed entry. The reader must refuse the manifest that
 * holds the entry, and the message must name the place of the entry. */
export const testRefusedEntries = (
  parse: (manifest: unknown) => unknown,
  entry: object,
  cases: readonly [name: string, changed: object, message: string][],
): void => {
  for (const [name, changed, message] of cases) {
    test(`refuses ${name}`, () => {
      expect(() =>
        parse({ "src/shared/api.ts": [{ ...entry, ...changed }] }),
      ).toThrow(`src/shared/api.ts / 0 / ${message}`);
    });
  }
};
