import * as v from "valibot";
import { generateSecureToken } from "#shared/crypto/utils.ts";
import { integerAtLeast } from "#shared/validation/number.ts";

export type DatabaseLease = { duration: number; token: string };

/** Validate a lease duration and create its one-use ownership token. */
export const newDatabaseLease = (leaseMs: number): DatabaseLease => ({
  duration: v.parse(integerAtLeast(1), leaseMs),
  token: generateSecureToken(),
});

/** Create a lease, claim one row, and build the domain claim when it exists. */
export const claimDatabaseRow =
  (leaseMs: number) =>
  async <Raw, Row, Claim>(
    find: (lease: DatabaseLease) => Promise<Raw | null>,
    read: (raw: Raw) => Row,
    makeClaim: (row: Row, leaseToken: string) => Claim,
  ): Promise<Claim | null> => {
    const lease = newDatabaseLease(leaseMs);
    const raw = await find(lease);
    return raw === null ? null : makeClaim(read(raw), lease.token);
  };
