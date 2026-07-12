import { signCsrfToken } from "#shared/csrf.ts";
import type { Transfer } from "#shared/ledger/types.ts";
import {
  adminLedgerPage,
  type LedgerNames,
  type LedgerPageData,
} from "#templates/admin/ledger.tsx";
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

export const renderLedger = (
  transfers: Transfer[],
  ledgerNames: LedgerNames = names(),
  view: "human" | "dual" = "human",
  returnUrl = "/admin/ledger",
): string => {
  const data: LedgerPageData = {
    dates: [],
    filters: {
      from: null,
      fromMonth: null,
      scope: { kind: "all" },
      to: null,
      toMonth: null,
      view,
    },
    groups: [],
    listings: [],
    names: ledgerNames,
    returnUrl,
    stats: [],
    statsHeading: null,
    today: "2026-06-21",
    transfers,
    truncated: false,
  };
  return adminLedgerPage(data, SESSION);
};

/** Rows from the money-history table, excluding unrelated page tables. */
export const ledgerRows = (html: string): string[] => {
  const header = html.indexOf("<th>Time</th>");
  const start = html.lastIndexOf("<table", header);
  const end = html.indexOf("</table>", start);
  return html.slice(start, end).split("<tr>");
};

/** Establish the crypto every ledger-page render needs (the encryption key
 * and a signed CSRF token). Each ledger test file calls this from its own
 * suite's beforeAll — a module-level hook here would be a *global* hook, which
 * cannot be registered once any other module's tests exist (files share an
 * isolate under the grouped runner). */
export const setUpLedgerPageCrypto = async (): Promise<void> => {
  setupTestEncryptionKey();
  await signCsrfToken();
};
