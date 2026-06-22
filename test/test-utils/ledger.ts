import { afterEach, beforeEach } from "@std/testing/bdd";
import { account } from "#shared/ledger/account.ts";
import type { TransferInput } from "#shared/ledger/types.ts";
import { setupTransactionalTestDb } from "#test-utils";

/** A {@link TransferInput} with sensible defaults; override any field. */
export const tx = (overrides: Partial<TransferInput> = {}): TransferInput => ({
  amount: 5000,
  currency: "GBP",
  destination: account("revenue", 1),
  eventGroup: "evt-1",
  occurredAt: "2026-06-21T00:00:00.000Z",
  reference: "ref-default",
  source: account("attendee", 1),
  ...overrides,
});

/** A sale plus its matching payment for one event (attendee owes nothing after). */
export const saleAndPayment = (): TransferInput[] => [
  tx({ reference: "sale-1", source: account("attendee", 1) }),
  tx({
    destination: account("attendee", 1),
    reference: "pay-1",
    source: account("external", "world"),
  }),
];

/** Run a promise expected to reject and return the thrown error. */
export const rejection = async (promise: Promise<unknown>): Promise<Error> => {
  try {
    await promise;
  } catch (error) {
    return error as Error;
  }
  throw new Error("expected the promise to reject, but it resolved");
};

/** Give each test in the current suite a fresh transactional test database. */
export const useTransactionalDb = (): void => {
  let cleanup: () => Promise<void>;
  beforeEach(async () => {
    cleanup = await setupTransactionalTestDb();
  });
  afterEach(async () => {
    await cleanup();
  });
};
