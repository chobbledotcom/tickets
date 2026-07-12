import { beforeAll } from "@std/testing/bdd";
import { signCsrfToken } from "#shared/csrf.ts";
import type { Transfer } from "#shared/ledger/types.ts";
import type { LedgerNames } from "#templates/admin/ledger.tsx";
import { setupTestEncryptionKey } from "#test-utils/env.ts";
import { makeTransfer } from "#test-utils/transfer-factory.ts";

export const SESSION = { adminLevel: "owner" as const };

/** Build a LedgerNames from id-to-name pairs for each entity kind. */
export const names = (overrides: Partial<LedgerNames> = {}): LedgerNames => ({
  attendees: new Map(),
  listings: new Map(),
  modifiers: new Map(),
  ...overrides,
});

/** A persisted transfer with the original template-test defaults. */
export const transfer = (overrides: Partial<Transfer> = {}): Transfer => {
  const { postedBy: _postedBy, ...defaults } = makeTransfer({
    amount: 5000,
    destination: { id: "1", type: "revenue" },
    eventGroup: "evt-1",
    id: 1,
    occurredAt: "2026-06-21T09:00:00.000Z",
    recordedAt: "2026-06-21T09:00:00.000Z",
    reference: "ref-1",
    source: { id: "1", type: "attendee" },
  });
  return { ...defaults, ...overrides };
};

beforeAll(async () => {
  setupTestEncryptionKey();
  await signCsrfToken();
});
