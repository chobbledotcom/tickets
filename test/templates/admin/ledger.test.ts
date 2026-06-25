import { expect } from "@std/expect";
import { beforeAll, describe, it as test } from "@std/testing/bdd";
import {
  MANUAL_ATTENDEE_CHARGE,
  MANUAL_ATTENDEE_PAYMENT,
  MANUAL_ATTENDEE_WRITEOFF,
} from "#shared/accounting/manual-entries.ts";
import { signCsrfToken } from "#shared/csrf.ts";
import { formatCurrency } from "#shared/currency.ts";
import { account } from "#shared/ledger/account.ts";
import { statementFor } from "#shared/ledger/project.ts";
import type { Transfer } from "#shared/ledger/types.ts";
import {
  AccountStatementSection,
  AccountStatementTable,
  adminAccountStatementPage,
  adminLedgerEntryAddPage,
  adminLedgerPage,
  HumanLedgerTable,
  type LedgerEntryAddOption,
  type LedgerFilterState,
  type LedgerNames,
  type LedgerPageData,
  LedgerTable,
  resolveAccountLabel,
} from "#templates/admin/ledger.tsx";
import { setTestEnv, setupTestEncryptionKey } from "#test-utils";

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

  test("links a revenue leg to its listing and a modifier leg to its edit page", () => {
    const refs = names({
      listings: new Map([[3, "Summer Concert"]]),
      modifiers: new Map([[5, "Early bird"]]),
    });
    expect(resolveAccountLabel(account("revenue", 3), refs)).toEqual({
      href: "/admin/listing/3",
      text: "Summer Concert",
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

  test("renders an empty kind as an empty cell, not the no-kind placeholder", () => {
    const html = String(
      LedgerTable({
        names: names(),
        transfers: [transfer({ kind: "" })],
      }),
    );
    expect(html).toContain("<td></td>");
    expect(html).not.toContain("<td>—</td>");
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

  test("links manual-entry amounts to the edit page when a return URL is supplied", () => {
    const html = String(
      LedgerTable({
        names: names(),
        returnUrl: "/admin/ledger?listing=1",
        transfers: [transfer({ id: 77, kind: MANUAL_ATTENDEE_PAYMENT })],
      }),
    );
    expect(html).toContain(
      'href="/admin/ledger/entries/77/edit?return_url=%2Fadmin%2Fledger%3Flisting%3D1"',
    );
    expect(html).toContain(formatCurrency(5000));
  });

  test("does not link manual-entry amounts without a return URL", () => {
    const html = String(
      LedgerTable({
        names: names(),
        transfers: [transfer({ id: 77, kind: MANUAL_ATTENDEE_PAYMENT })],
      }),
    );
    expect(html).not.toContain("/admin/ledger/entries/77/edit");
    expect(html).toContain(`>${formatCurrency(5000)}<`);
  });

  test("does not link checkout-event amounts to the maintenance edit route", () => {
    const html = String(
      LedgerTable({
        names: names(),
        returnUrl: "/admin/ledger?listing=1",
        transfers: [transfer({ id: 77, kind: "sale" })],
      }),
    );
    expect(html).not.toContain("/admin/ledger/entries/77/edit");
    expect(html).toContain(`>${formatCurrency(5000)}<`);
  });
});

describe("HumanLedgerTable", () => {
  test("renders plain-language descriptions for every known ledger event family", () => {
    const refs = names({
      attendees: new Map([[1, "Ada"]]),
      listings: new Map([[1, "Concert"]]),
      modifiers: new Map([[1, "Helmet hire"]]),
    });
    const html = String(
      HumanLedgerTable({
        names: refs,
        transfers: [
          transfer({
            destination: account("attendee", 1),
            id: 1,
            kind: "payment",
            source: account("external", "world"),
          }),
          transfer({
            destination: account("revenue", 1),
            id: 2,
            kind: "payment",
            source: account("external", "world"),
          }),
          transfer({
            destination: account("external", "world"),
            id: 3,
            kind: "refund_cash",
            source: account("attendee", 1),
          }),
          transfer({
            destination: account("attendee", 1),
            id: 4,
            kind: "refund_sale",
            source: account("revenue", 1),
          }),
          transfer({
            destination: account("fee_income", "booking"),
            id: 5,
            kind: "fee",
            source: account("attendee", 1),
          }),
          transfer({
            destination: account("attendee", 1),
            id: 6,
            kind: "refund_fee",
            source: account("fee_income", "booking"),
          }),
          transfer({
            destination: account("revenue", 1),
            id: 7,
            kind: "adjustment",
            source: account("writeoff", "default"),
          }),
          transfer({
            destination: account("writeoff", "default"),
            id: 8,
            kind: "adjustment",
            source: account("revenue", 1),
          }),
          transfer({
            destination: account("revenue", 1),
            id: 9,
            kind: "adjustment",
            source: account("attendee", 1),
          }),
          transfer({
            destination: account("attendee", 1),
            id: 10,
            kind: "manual_attendee_payment",
            source: account("external", "world"),
          }),
          transfer({
            destination: account("writeoff", "default"),
            id: 11,
            kind: "manual_attendee_charge",
            source: account("attendee", 1),
          }),
          transfer({
            destination: account("attendee", 1),
            id: 12,
            kind: "manual_attendee_writeoff",
            source: account("writeoff", "default"),
          }),
          transfer({
            destination: account("revenue", 1),
            id: 13,
            kind: "manual_listing_income",
            source: account("external", "world"),
          }),
          transfer({
            destination: account("external", "world"),
            id: 14,
            kind: "manual_listing_cost",
            source: account("revenue", 1),
          }),
          transfer({
            destination: account("modifier", 1),
            id: 15,
            kind: "manual_modifier_income",
            source: account("writeoff", "default"),
          }),
          transfer({
            destination: account("writeoff", "default"),
            id: 16,
            kind: "manual_modifier_reduction",
            source: account("modifier", 1),
          }),
          transfer({
            destination: account("revenue", 1),
            id: 17,
            kind: "future_kind",
            source: account("attendee", 1),
          }),
        ],
      }),
    );

    for (const phrase of [
      "Payment received for",
      "Refund paid to",
      "Refund removed income from",
      "Booking fee recorded",
      "Booking fee refunded",
      "Manual correction increased",
      "Manual correction reduced",
      "Transfer from",
      "Payment received outside checkout for",
      "Extra amount now owed by",
      "Amount waived from the balance for",
      "Income received outside checkout for",
      "Cost paid outside checkout for",
      "Modifier income added for",
      "Modifier income reduced for",
    ]) {
      expect(html).toContain(phrase);
    }
    expect(html).toContain("Ada");
    expect(html).toContain("Concert");
    expect(html).toContain("Helmet hire");
    expect(html).toContain(
      'Payment received for <a href="/admin/attendees/1">Ada</a>',
    );
    expect(html).toContain(
      'Manual correction reduced <a href="/admin/listing/1">Concert</a>',
    );
  });

  test("uses attendee-balance wording for adjustment legs against writeoff", () => {
    const refs = names({ attendees: new Map([[1, "Ada"]]) });
    const html = String(
      HumanLedgerTable({
        names: refs,
        transfers: [
          transfer({
            destination: account("writeoff", "default"),
            id: 1,
            kind: "adjustment",
            source: account("attendee", 1),
          }),
          transfer({
            destination: account("attendee", 1),
            id: 2,
            kind: "adjustment",
            source: account("writeoff", "default"),
          }),
        ],
      }),
    );
    expect(html).toContain("Extra amount now owed by");
    expect(html).toContain("Amount waived from the balance for");
    expect(html).toContain("Ada");
    expect(html).not.toContain("Manual correction reduced");
    expect(html).not.toContain("Manual correction increased");
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

  test("links manual statement deltas to the edit page when a return URL is supplied", () => {
    const html = String(
      AccountStatementTable({
        account: acct,
        lines: statementFor(acct)([
          transfer({
            destination: account("attendee", 1),
            id: 1,
            kind: MANUAL_ATTENDEE_PAYMENT,
            source: account("external", "world"),
          }),
        ]),
        names: names(),
        returnUrl: "/admin/attendees/1",
      }),
    );
    expect(html).toContain(
      'href="/admin/ledger/entries/1/edit?return_url=%2Fadmin%2Fattendees%2F1"',
    );
  });

  test("does not link manual statement deltas without a return URL", () => {
    const html = String(
      AccountStatementTable({
        account: acct,
        lines: statementFor(acct)([
          transfer({
            destination: account("attendee", 1),
            id: 1,
            kind: MANUAL_ATTENDEE_PAYMENT,
            source: account("external", "world"),
          }),
        ]),
        names: names(),
      }),
    );
    expect(html).not.toContain("/admin/ledger/entries/1/edit");
    expect(html).toContain(`-${formatCurrency(5000)}`);
  });

  test("does not link checkout-event statement deltas to the maintenance route", () => {
    const html = String(
      AccountStatementTable({
        account: acct,
        lines: lines(),
        names: names(),
        returnUrl: "/admin/attendees/1",
      }),
    );
    expect(html).not.toContain("/admin/ledger/entries/1/edit");
    expect(html).not.toContain("/admin/ledger/entries/2/edit");
    expect(html).toContain(`+${formatCurrency(5000)}`);
  });
});

describe("adminLedgerPage", () => {
  const NO_FILTERS: LedgerFilterState = {
    from: null,
    fromMonth: null,
    listingId: null,
    to: null,
    toMonth: null,
    view: "human",
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
    returnUrl: "/admin/ledger",
    stats: [{ key: "Total income", value: "£25.00" }],
    statsHeading: "All listings",
    today: "2026-06-23",
    transfers: [transfer()],
    truncated: false,
    ...overrides,
  });

  test("renders the Ledger heading, nav, stats, filters, and the plain-language transfer list", () => {
    const html = adminLedgerPage(pageData(), SESSION);
    expect(html).toContain("Ledger");
    expect(html).toContain('href="/admin/ledger"');
    expect(html).toContain("<th>Activity</th>");
    expect(html).toContain("Plain-language log");
    expect(html).toContain("Double-entry view");
    expect(html).toContain("Transfer from");
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
    expect(html).toContain(
      '<option selected value="/admin/ledger">All listings</option>',
    );
  });

  test("can switch to the double-entry transfer list", () => {
    const html = adminLedgerPage(
      pageData({ filters: { ...NO_FILTERS, view: "dual" } }),
      SESSION,
    );
    expect(html).toContain("<th>From → To</th>");
    expect(html).toContain('href="/admin/ledger">Plain-language log</a>');
    expect(html).toContain("<strong>Double-entry view</strong>");
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

  test("filter links preserve dual view and paged calendar state", () => {
    const html = adminLedgerPage(
      pageData({
        filters: {
          ...NO_FILTERS,
          from: "2026-06-20",
          fromMonth: "2026-05",
          listingId: 1,
          to: "2026-06-22",
          toMonth: "2026-07",
          view: "dual",
        },
      }),
      SESSION,
    );
    expect(html).toContain(
      'value="/admin/ledger?from=2026-06-20&amp;to=2026-06-22&amp;view=dual&amp;fromCal=2026-05&amp;toCal=2026-07"',
    );
    expect(html).toContain("view=dual");
    expect(html).toContain("toCal=2026-07");
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
    expect(html).toContain(
      'href="/admin/ledger/attendee/7/add?return_url=%2Fadmin%2Fledger%2Fattendee%2F7"',
    );
    expect(html).not.toContain("View full ledger");
  });

  test("shows a zero balance for an account with no history", () => {
    const html = adminAccountStatementPage(acct, [], names(), SESSION);
    expect(html).toContain(`Balance: ${formatCurrency(0)}`);
    expect(html).toContain("No transfers recorded yet");
    expect(html).not.toContain("/admin/ledger/attendee/7/add");
  });

  test("suppresses add and edit actions in read-only mode", () => {
    const restore = setTestEnv({
      READ_ONLY_FROM: "2020-01-01T00:00:00.000Z",
    });
    try {
      const refs = names({ attendees: new Map([[7, "Ada Lovelace"]]) });
      const html = adminAccountStatementPage(
        acct,
        statementFor(acct)([
          transfer({
            destination: account("attendee", 7),
            id: 77,
            kind: MANUAL_ATTENDEE_PAYMENT,
            source: account("external", "world"),
          }),
        ]),
        refs,
        SESSION,
      );
      expect(html).not.toContain("/admin/ledger/attendee/7/add");
      expect(html).not.toContain("/admin/ledger/entries/77/edit");
    } finally {
      restore();
    }
  });

  test("keeps the full-ledger action for accounts that cannot add entries", () => {
    const html = String(
      AccountStatementSection({
        account: account("writeoff", "default"),
        fullLedgerHref: "/admin/ledger/writeoff/default",
        lines: [],
        names: names(),
        returnUrl: "/admin/listing/7",
      }),
    );
    expect(html).toContain(
      'href="/admin/ledger/writeoff/default"><span>View full ledger</span></a>',
    );
    expect(html).not.toContain("/admin/ledger/writeoff/default/add");
  });
});

describe("adminLedgerEntryAddPage", () => {
  test("preselects the posted entry type when redisplaying the add form", () => {
    const refs = names({ attendees: new Map([[7, "Ada Lovelace"]]) });
    const options: LedgerEntryAddOption[] = [
      {
        hint: "Money received",
        hintKey: "admin.ledger.add.option.attendee_payment.hint",
        label: "Payment",
        labelKey: "admin.ledger.add.option.attendee_payment.label",
        type: MANUAL_ATTENDEE_PAYMENT,
      },
      {
        hint: "New charge",
        hintKey: "admin.ledger.add.option.attendee_charge.hint",
        label: "Charge",
        labelKey: "admin.ledger.add.option.attendee_charge.label",
        type: MANUAL_ATTENDEE_CHARGE,
      },
      {
        hint: "Waive charge",
        hintKey: "admin.ledger.add.option.attendee_writeoff.hint",
        label: "Write-off",
        labelKey: "admin.ledger.add.option.attendee_writeoff.label",
        type: MANUAL_ATTENDEE_WRITEOFF,
      },
    ];
    const html = adminLedgerEntryAddPage({
      account: account("attendee", 7),
      names: refs,
      options,
      returnUrl: "/admin/attendees/7",
      session: SESSION,
      values: {
        amount: "5.00",
        entryType: MANUAL_ATTENDEE_CHARGE,
        occurredAt: "2026-06-22T09:30",
      },
    });
    expect(html).toContain(
      '<option selected value="manual_attendee_charge">Charge</option>',
    );
    expect(html).toContain(
      '<option value="manual_attendee_payment">Payment</option>',
    );
  });
});
