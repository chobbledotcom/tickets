import { account } from "#shared/ledger/account.ts";
import type { Transfer } from "#shared/ledger/types.ts";

/** Build a {@link Transfer} for tests with sensible defaults; override any field. */
export const makeTransfer = (overrides: Partial<Transfer> = {}): Transfer => ({
  amount: 1000,
  currency: "GBP",
  destination: account("revenue", 1),
  eventGroup: "evt",
  id: 1,
  occurredAt: "2026-01-01T00:00:00.000Z",
  postedBy: "system",
  recordedAt: "2026-01-01T00:00:00.000Z",
  reference: "ref",
  source: account("attendee", 1),
  ...overrides,
});
