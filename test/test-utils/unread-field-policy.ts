import { expect } from "@std/expect";
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
