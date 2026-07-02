/**
 * Pure transfer factories shared by every ledger test — deliberately free of
 * database/app imports so the pure `test/lib/ledger` suites can use them
 * without dragging in the DB module graph. `tx` builds the input shape the
 * store accepts; `makeTransfer` extends it with the stored-row fields, so the
 * two can never drift on what a default transfer looks like.
 */

import { account } from "#shared/ledger/account.ts";
import type { Transfer, TransferInput } from "#shared/ledger/types.ts";

/** A {@link TransferInput} with sensible defaults; override any field. */
export const tx = (overrides: Partial<TransferInput> = {}): TransferInput => ({
  amount: 5000,
  destination: account("revenue", 1),
  eventGroup: "evt-1",
  occurredAt: "2026-06-21T00:00:00.000Z",
  reference: "ref-default",
  source: account("attendee", 1),
  ...overrides,
});

/** Build a {@link Transfer} for tests with sensible defaults; override any field. */
export const makeTransfer = (overrides: Partial<Transfer> = {}): Transfer => ({
  ...tx({
    amount: 1000,
    eventGroup: "evt",
    occurredAt: "2026-01-01T00:00:00.000Z",
    reference: "ref",
  }),
  id: 1,
  postedBy: "system",
  recordedAt: "2026-01-01T00:00:00.000Z",
  ...overrides,
});
