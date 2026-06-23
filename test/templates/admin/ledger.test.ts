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
  type LedgerNames,
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

  test("shows the counterparty, signed change, and running balance per leg", () => {
    const refs = names({ listings: new Map([[1, "Concert"]]) });
    const html = String(
      AccountStatementTable({ account: acct, lines: lines(), names: refs }),
    );
    expect(html).toContain("<th>Counterparty</th>");
    // Leg 1: counterparty is the revenue listing (this account is the source).
    expect(html).toContain('<a href="/admin/listing/1">Concert</a>');
    // Leg 2: counterparty is the card/bank singleton (this account received).
    expect(html).toContain("Card / bank");
    // Signed deltas carry an explicit sign; the sale debits, the payment credits.
    expect(html).toContain(`+${formatCurrency(5000)}`);
    expect(html).toContain(`-${formatCurrency(5000)}`);
    // Running balance reaches 5000 after the sale, 0 after the payment.
    expect(html).toContain(formatCurrency(0));
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
  test("renders the Ledger heading, nav, and the transfer list", () => {
    const html = adminLedgerPage([transfer()], names(), false, SESSION);
    expect(html).toContain("Ledger");
    expect(html).toContain('href="/admin/ledger"');
    expect(html).toContain("<th>From → To</th>");
  });

  test("surfaces the 'showing recent' note only when truncated", () => {
    const shown = adminLedgerPage([transfer()], names(), true, SESSION);
    expect(shown).toContain("Showing the most recent 500 transfers");
    const all = adminLedgerPage([transfer()], names(), false, SESSION);
    expect(all).not.toContain("Showing the most recent 500 transfers");
  });
});

describe("adminAccountStatementPage", () => {
  const acct = account("attendee", 7);

  test("shows the account label, its balance, a back link, and the statement", () => {
    const refs = names({ attendees: new Map([[7, "Ada Lovelace"]]) });
    // A single payment credits the attendee account, so its final balance is
    // +5000; the heading must show the account's own label and that balance.
    const lines = statementFor(acct)([
      transfer({
        amount: 5000,
        destination: acct,
        source: account("external", "world"),
      }),
    ]);
    const html = adminAccountStatementPage(acct, lines, refs, SESSION);
    expect(html).toContain("Ada Lovelace");
    expect(html).toContain(`Balance: ${formatCurrency(5000)}`);
    // Back link to the historical ledger.
    expect(html).toContain('href="/admin/ledger"');
    expect(html).toContain('<th class="col-amount">Balance</th>');
  });

  test("shows a zero balance for an account with no history", () => {
    const html = adminAccountStatementPage(acct, [], names(), SESSION);
    expect(html).toContain(`Balance: ${formatCurrency(0)}`);
    expect(html).toContain("No transfers recorded yet");
  });
});
