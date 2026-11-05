import { ATTENDEE_KIND } from "#db/attendees/kind.ts";
import type { AttendeeLinkRefs } from "#shared/attendee-links.ts";
import type { Transfer } from "#shared/ledger/types.ts";
import {
  adminLedgerPage,
  type LedgerNames,
  type LedgerPageData,
} from "#templates/admin/ledger.tsx";
import { OWNER_SESSION } from "#test-utils/admin-page-test.ts";
import { makeTransfer } from "#test-utils/transfer-factory.ts";

/** Attendee link lookups for the rows a rendering test names, defaulting each
 *  row to the ordinary attendee kind. */
export const attendeeLinkRefs = (
  rows: readonly (readonly [id: number, name: string, kind?: string])[],
): AttendeeLinkRefs => ({
  kinds: new Map(rows.map(([id, , kind]) => [id, kind ?? ATTENDEE_KIND])),
  names: new Map(rows.map(([id, name]) => [id, name])),
});

/** Build a LedgerNames from id-to-name pairs for each entity kind. */
export const names = (overrides: Partial<LedgerNames> = {}): LedgerNames => ({
  attendees: attendeeLinkRefs([]),
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
  return adminLedgerPage(data, OWNER_SESSION);
};

/** Rows from the Money table, excluding unrelated page tables. */
export const ledgerRows = (html: string): string[] => {
  const header = html.indexOf("<th>Time</th>");
  const start = html.lastIndexOf("<table", header);
  const end = html.indexOf("</table>", start);
  return html.slice(start, end).split("<tr>");
};
