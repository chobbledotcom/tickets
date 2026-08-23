import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import {
  attendeeOwedTx,
  listingIncomeTx,
  modifierRevenueTx,
} from "#accounting/queries.ts";
import { withTransaction } from "#db/client.ts";
import { useTransactionalDb } from "#test-utils/ledger.ts";

describe("db > accounting > transaction projections", () => {
  useTransactionalDb();

  const cases = [
    ["attendee owed", attendeeOwedTx],
    ["listing income", listingIncomeTx],
    ["modifier revenue", modifierRevenueTx],
  ] as const;

  for (const [label, read] of cases) {
    test(`${label} is zero without ledger rows`, async () => {
      expect(await withTransaction((tx) => read(tx, 404))).toBe(0);
    });
  }
});
