import { expect } from "@std/expect";
import { beforeAll, describe, it as test } from "@std/testing/bdd";
import { signCsrfToken } from "#shared/csrf.ts";
import { formatCurrency } from "#shared/currency.ts";
import { account } from "#shared/ledger/account.ts";
import { statementFor } from "#shared/ledger/project.ts";
import type { Transfer } from "#shared/ledger/types.ts";
import {
  AccountStatementTable,
  adminAccountStatementPage,
  adminLedgerPage,
  type LedgerFilterState,
  type LedgerNames,
  type LedgerPageData,
  LedgerTable,
  resolveAccountLabel,
} from "#templates/admin/ledger.tsx";
import { setupTestEncryptionKey } from "#test-utils";

const SESSION = { adminLevel: "owner" as const };

/** A persisted {@link Transfer} with sensible defaults; override any field. */
const transfer = (overrides: Partial<Transfer> = {}): Transfer => ({
  amount: 5000,
  destination: account("revenue", 1),
  eventGroup: "evt-1",
  id: 1,
  occurredAt: "2026-06-21T09:00:00.000Z",
  recordedAt: "2026-06-21T09:00:00.000Z",
  reference: "ref-1",
  source: account("attendee", 1),
  ...overrides,
});

/** Build a {@link LedgerNames} from id→name pairs for each entity kind. */
const names = (overrides: Partial<LedgerNames> = {}): LedgerNames => ({
  attendees: new Map(),
  listings: new Map(),
  modifiers: new Map(),
  ...overrides,
});

beforeAll(async () => {
  setupTestEncryptionKey();
  await signCsrfToken();
});

describe("resolveAccountLabel", () => {
  test("names singleton accounts from i18n with no link", () => {
    expect(resolveAccountLabel(account("external", "world"), names())).toEqual({
      text: "Card / bank",
    });
    expect(
      resolveAccountLabel(account("fee_income", "booking"), names()),
    ).toEqual({ text: "Booking fees" });
  });

  test("labels every writeoff account 'Write-off' regardless of id, no link", () => {
    // The chart of accounts treats writeoff as one logical contra account, so
    // the label is matched on the type alone — a stray id must not change it.
    expect(resolveAccountLabel(account("writeoff", "x"), names())).toEqual({
      text: "Write-off",
    });
  });

  test("links a row-backed account to its entity by name", () => {
    const refs = names({ attendees: new Map([[7, "Ada Lovelace"]]) });
    expect(resolveAccountLabel(account("attendee", 7), refs)).toEqual({
      href: "/admin/attendees/7",
      text: "Ada Lovelace",
    });
  });

  test("links listing-backed revenue and cost legs to the listing", () => {
    const refs = names({
      listings: new Map([[3, "Summer Concert"]]),
    });
    expect(resolveAccountLabel(account("revenue", 3), refs)).toEqual({
      href: "/admin/listing/3",
      text: "Summer Concert",
    });
    expect(resolveAccountLabel(account("cost", 3), refs)).toEqual({
      href: "/admin/listing/3",
      text: "Summer Concert",
    });
  });

  test("links modifier legs to their edit page", () => {
    const refs = names({
      modifiers: new Map([[5, "Early bird"]]),
    });
    expect(resolveAccountLabel(account("modifier", 5), refs)).toEqual({
      href: "/admin/modifiers/5/edit",
      text: "Early bird",
    });
  });

  test("shows an unrecognised account type as bare 'type:id' with no link", () => {
    // A future account kind the renderer doesn't know yet (e.g. psp:stripe) must
    // still render legibly rather than blank — as the raw key, no link.
    expect(resolveAccountLabel(account("psp", "stripe"), names())).toEqual({
      text: "psp:stripe",
    });
  });

  test("falls back to '<Entity> #<id>' with no link when the id is absent", () => {
    // A deleted entity keeps its ledger rows; its id outlives the name, so the
    // leg degrades to plain text rather than linking to a missing page.
    expect(resolveAccountLabel(account("attendee", 42), names())).toEqual({
      text: "Attendee #42",
    });
    expect(resolveAccountLabel(account("revenue", 9), names())).toEqual({
      text: "Listing #9",
    });
    expect(resolveAccountLabel(account("cost", 9), names())).toEqual({
      text: "Listing #9",
    });
    expect(resolveAccountLabel(account("modifier", 8), names())).toEqual({
      text: "Modifier #8",
    });
  });
});

describe("LedgerTable", () => {
  test("renders each transfer as From → To with kind, time and amount", () => {
    const refs = names({
      attendees: new Map([[1, "Ada"]]),
      listings: new Map([[1, "Concert"]]),
    });
    const html = String(
      LedgerTable({
        names: refs,
        transfers: [transfer({ amount: 2500, kind: "sale" })],
      }),
    );
    expect(html).toContain("table-scroll");
    expect(html).toContain("<th>Time</th>");
    expect(html).toContain("sale");
    // Both legs resolve to links, joined by an arrow (rendered as the glyph).
    expect(html).toContain('<a href="/admin/attendees/1">Ada</a>');
    expect(html).toContain('<a href="/admin/listing/1">Concert</a>');
    expect(html).toContain("→");
    expect(html).toContain(formatCurrency(2500));
  });

  test("shows an em dash for a transfer with no kind", () => {
    const html = String(
      LedgerTable({
        names: names(),
        transfers: [transfer({ kind: undefined })],
      }),
    );
    expect(html).toContain("<td>—</td>");
  });

  test("renders the empty state row spanning all four columns", () => {
    const html = String(LedgerTable({ names: names(), transfers: [] }));
    expect(html).toContain('colspan="4"');
    expect(html).toContain("No transfers recorded yet");
  });

  test("escapes a stored name so PII cannot inject markup", () => {
    const refs = names({ attendees: new Map([[1, "<script>x</script>"]]) });
    const html = String(LedgerTable({ names: refs, transfers: [transfer()] }));
    expect(html).toContain("&lt;script&gt;x&lt;/script&gt;");
    expect(html).not.toContain("<script>x</script>");
  });
});

describe("AccountStatementTable", () => {
  const acct = account("attendee", 1);

  /** Two legs against attendee 1: a 5000 sale (debit) then a 5000 payment
   * (credit), so the running balance rises to 5000 then settles at 0. */
  const lines = () =>
    statementFor(acct)([
      transfer({
        destination: account("revenue", 1),
        id: 1,
        kind: "sale",
        occurredAt: "2026-06-21T09:00:00.000Z",
        source: account("attendee", 1),
      }),
      transfer({
        destination: account("attendee", 1),
        id: 2,
        kind: "payment",
        occurredAt: "2026-06-21T10:00:00.000Z",
        source: account("external", "world"),
      }),
    ]);

  test("reverses the attendee figures so a charge reads positive and a payment brings it down", () => {
    const refs = names({ listings: new Map([[1, "Concert"]]) });
    const html = String(
      AccountStatementTable({ account: acct, lines: lines(), names: refs }),
    );
    expect(html).toContain("<th>Counterparty</th>");
    // Leg 1: counterparty is the revenue listing (this account is the source).
    expect(html).toContain('<a href="/admin/listing/1">Concert</a>');
    // Leg 2: counterparty is the card/bank singleton (this account received).
    expect(html).toContain("Card / bank");
    // The ledger stores the sale as a -5000 debit and the payment as a +5000
    // credit against the attendee. The attendee view flips both: the sale reads
    // as a +5000 charge and the payment as a -5000 reduction.
    const rows = html.split("<tr>");
    expect(rows[2]).toContain(`+${formatCurrency(5000)}`); // sale: charge owed
    expect(rows[3]).toContain(`-${formatCurrency(5000)}`); // payment: brings it down
    // Running balance climbs to the +5000 owed after the sale, then settles at 0.
    expect(rows[2]).toContain(`>${formatCurrency(5000)}<`);
    expect(rows[3]).toContain(`>${formatCurrency(0)}<`);
  });

  test("keeps native ledger signs for a non-attendee (revenue) account", () => {
    // Reversal is attendee-only: a revenue account's statement still shows the
    // ledger's own signs, so the convention isn't flipped for every account.
    const revenue = account("revenue", 1);
    const html = String(
      AccountStatementTable({
        account: revenue,
        lines: statementFor(revenue)([
          transfer({
            amount: 5000,
            destination: account("revenue", 1),
            kind: "sale",
            source: account("attendee", 1),
          }),
        ]),
        names: names(),
      }),
    );
    // Revenue received the sale: a +5000 credit and a +5000 running balance,
    // unflipped.
    expect(html).toContain(`+${formatCurrency(5000)}`);
    expect(html).not.toContain(`-${formatCurrency(5000)}`);
  });

  test("renders the empty state row spanning all five columns", () => {
    const html = String(
      AccountStatementTable({ account: acct, lines: [], names: names() }),
    );
    expect(html).toContain('colspan="5"');
    expect(html).toContain("No transfers recorded yet");
  });
});

describe("adminLedgerPage", () => {
  const NO_FILTERS: LedgerFilterState = {
    from: null,
    fromMonth: null,
    listingId: null,
    to: null,
    toMonth: null,
  };

  const pageData = (
    overrides: Partial<LedgerPageData> = {},
  ): LedgerPageData => ({
    dates: [
      { label: "Sat 20 June 2026", selectable: true, value: "2026-06-20" },
    ],
    filters: NO_FILTERS,
    listings: [{ id: 1, name: "Summer Concert" }],
    names: names(),
    stats: [{ key: "Total income", value: "£25.00" }],
    statsHeading: "All listings",
    today: "2026-06-23",
    transfers: [transfer()],
    truncated: false,
    ...overrides,
  });

  test("renders the Ledger heading, nav, stats, filters, and the transfer list", () => {
    const html = adminLedgerPage(pageData(), SESSION);
    expect(html).toContain("Ledger");
    expect(html).toContain('href="/admin/ledger"');
    expect(html).toContain("<th>From → To</th>");
    // The stats table and its heading render.
    expect(html).toContain("All listings");
    expect(html).toContain("Total income");
    expect(html).toContain("£25.00");
    // Both range pickers render with unique anchor ids.
    expect(html).toContain('id="ledger-from"');
    expect(html).toContain('id="ledger-to"');
    // The by-listing select lists every listing plus the "all" option.
    expect(html).toContain("All listings");
    expect(html).toContain("Summer Concert");
  });

  test("preselects the chosen listing in the by-listing select", () => {
    const html = adminLedgerPage(
      pageData({ filters: { ...NO_FILTERS, listingId: 1 } }),
      SESSION,
    );
    // The listing option carries `selected`; its value scopes the URL to it.
    expect(html).toContain(
      '<option selected value="/admin/ledger?listing=1">Summer Concert</option>',
    );
  });

  test("day links carry the from/to filters and the other side's state", () => {
    const html = adminLedgerPage(
      pageData({
        filters: { ...NO_FILTERS, from: "2026-06-20", listingId: 1 },
      }),
      SESSION,
    );
    // A "to" day link keeps the existing from + listing scope.
    expect(html).toContain("to=2026-06-20");
    expect(html).toContain("from=2026-06-20");
    expect(html).toContain("listing=1");
  });

  test("surfaces the 'showing recent' note only when truncated", () => {
    const shown = adminLedgerPage(pageData({ truncated: true }), SESSION);
    expect(shown).toContain("Showing the most recent 500 transfers");
    const all = adminLedgerPage(pageData({ truncated: false }), SESSION);
    expect(all).not.toContain("Showing the most recent 500 transfers");
  });
});

describe("adminAccountStatementPage", () => {
  const acct = account("attendee", 7);

  test("shows the account label, its reversed balance, a back link, and the statement", () => {
    const refs = names({ attendees: new Map([[7, "Ada Lovelace"]]) });
    // A single sale debits the attendee account, so the ledger holds -5000; the
    // attendee view flips it, showing the heading balance as the +5000 they owe.
    const lines = statementFor(acct)([
      transfer({
        amount: 5000,
        destination: account("revenue", 1),
        kind: "sale",
        source: acct,
      }),
    ]);
    const html = adminAccountStatementPage(acct, lines, refs, SESSION);
    expect(html).toContain("Ada Lovelace");
    expect(html).toContain(`Balance: ${formatCurrency(5000)}`);
    expect(html).not.toContain(`Balance: -${formatCurrency(5000)}`);
    // The nav links back to the ledger; no separate back-link arrow is shown.
    expect(html).toContain('href="/admin/ledger"');
    expect(html).not.toContain("&larr;");
    expect(html).toContain('<th class="col-amount">Balance</th>');
  });

  test("shows a zero balance for an account with no history", () => {
    const html = adminAccountStatementPage(acct, [], names(), SESSION);
    expect(html).toContain(`Balance: ${formatCurrency(0)}`);
    expect(html).toContain("No transfers recorded yet");
  });
});
