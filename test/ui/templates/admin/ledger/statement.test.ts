import { assert, assertStringIncludes } from "@std/assert";
import { expect } from "@std/expect";
import { beforeAll, describe, it as test } from "@std/testing/bdd";
import {
  ATTENDEE,
  COST,
  EXTERNAL,
  FEE_INCOME,
  MODIFIER,
  REVENUE,
  WRITEOFF_TYPE,
} from "#accounting/accounts.ts";
import { MANUAL_ATTENDEE_PAYMENT } from "#accounting/manual-entries.ts";
import { formatCurrency } from "#shared/currency.ts";
import { account } from "#shared/ledger/account.ts";
import { statementFor } from "#shared/ledger/project.ts";
import { statementBalanceKey } from "#templates/admin/ledger/formatting.tsx";
import {
  AccountStatementSection,
  adminAccountStatementPage,
} from "#templates/admin/ledger/statement.tsx";
import {
  OWNER_SESSION,
  setupAdminPageTest,
} from "#test-utils/admin-page-test.ts";
import { withEnv } from "#test-utils/env.ts";
import { featureSetting, useSetting } from "#test-utils/settings.ts";

import { names, transfer } from "./helpers.ts";

describe("statementBalanceKey", () => {
  beforeAll(setupAdminPageTest);

  test("maps every account type to its final balance label", () => {
    expect(
      [
        ATTENDEE,
        COST,
        EXTERNAL,
        FEE_INCOME,
        MODIFIER,
        REVENUE,
        WRITEOFF_TYPE,
        "future_account_type",
      ].map((type) => statementBalanceKey(account(type, "1"))),
    ).toEqual([
      "admin.ledger.amount_owed",
      "admin.ledger.total_costs",
      "admin.ledger.balance",
      "admin.ledger.balance",
      "admin.ledger.balance",
      "admin.ledger.income_balance",
      "admin.ledger.balance",
      "admin.ledger.balance",
    ]);
  });
});

describe("AccountStatementSection", () => {
  beforeAll(setupAdminPageTest);

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
      AccountStatementSection({
        ledger: { account: acct, lines: lines(), names: refs },
        returnUrl: "/admin/ledger/attendee/1",
      }),
    );
    assertStringIncludes(html, "<th>Other side</th>");
    // Leg 1: counterparty is the revenue listing (this account is the source).
    assertStringIncludes(html, '<a href="/admin/ledger?listing=1">Concert</a>');
    // Leg 2: counterparty is the card/bank singleton (this account received).
    assertStringIncludes(html, "Card / bank");
    // The ledger stores the sale as a -5000 debit and the payment as a +5000
    // credit against the attendee. The attendee view flips both: the sale reads
    // as a +5000 charge and the payment as a -5000 reduction.
    const rows = html.split("<tr>");
    assertStringIncludes(rows[2] ?? "", `+${formatCurrency(5000)}`); // sale: charge owed
    assertStringIncludes(rows[3] ?? "", `−${formatCurrency(5000)}`); // payment: brings it down
    // Running balance climbs to the +5000 owed after the sale, then settles at 0.
    assertStringIncludes(rows[2] ?? "", `>${formatCurrency(5000)}<`);
    assertStringIncludes(rows[3] ?? "", `>${formatCurrency(0)}<`);
  });

  test("keeps native ledger signs for a non-attendee (revenue) account", () => {
    // Reversal is attendee-only: a revenue account's statement still shows the
    // ledger's own signs, so the convention isn't flipped for every account.
    const revenue = account("revenue", 1);
    const html = String(
      AccountStatementSection({
        ledger: {
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
        },
        returnUrl: "/admin/ledger/revenue/1",
      }),
    );
    // Revenue received the sale: a +5000 credit and a +5000 running balance,
    // unflipped.
    assertStringIncludes(html, `+${formatCurrency(5000)}`);
    assert(!html.includes(`−${formatCurrency(5000)}`));
  });

  test("shows servicing costs as positive outgoings and reductions as negative", () => {
    const cost = account("cost", 1);
    const html = String(
      AccountStatementSection({
        ledger: {
          account: cost,
          lines: statementFor(cost)([
            transfer({
              amount: 5000,
              destination: account("external", "world"),
              id: 1,
              kind: "service_cost",
              source: cost,
            }),
            transfer({
              amount: 2000,
              destination: cost,
              id: 2,
              kind: "service_cost",
              source: account("external", "world"),
            }),
          ]),
          names: names({ listings: new Map([[1, "Concert"]]) }),
        },
        returnUrl: "/admin/ledger/cost/1",
      }),
    );
    const rows = html.split("<tr>");
    assertStringIncludes(rows[2] ?? "", "Service event cost added for");
    assertStringIncludes(rows[2] ?? "", "+£50");
    assertStringIncludes(rows[2] ?? "", ">£50<");
    assertStringIncludes(rows[3] ?? "", "Service event cost reduced for");
    assertStringIncludes(rows[3] ?? "", "−£20");
    assertStringIncludes(rows[3] ?? "", ">£30<");
  });

  test("renders the empty state row spanning all five columns", () => {
    const html = String(
      AccountStatementSection({
        ledger: { account: acct, lines: [], names: names() },
        returnUrl: "/admin/ledger/attendee/1",
      }),
    );
    assertStringIncludes(html, 'colspan="5"');
    assertStringIncludes(html, "No money changes yet.");
  });

  const renderStatement = (returnUrl: string): string =>
    String(
      AccountStatementSection({
        ledger: {
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
        },
        returnUrl,
      }),
    );

  test("links manual statement deltas to the edit page when a return URL is supplied", () => {
    const html = renderStatement("/admin/attendees/1");
    assertStringIncludes(
      html,
      'href="/admin/ledger/entries/1/edit?return_url=%2Fadmin%2Fattendees%2F1"',
    );
  });

  test("does not link checkout-event statement deltas to the maintenance route", () => {
    const html = String(
      AccountStatementSection({
        ledger: { account: acct, lines: lines(), names: names() },
        returnUrl: "/admin/attendees/1",
      }),
    );
    assert(!html.includes("/admin/ledger/entries/1/edit"));
    assert(!html.includes("/admin/ledger/entries/2/edit"));
    assertStringIncludes(html, `+${formatCurrency(5000)}`);
  });
});

describe("adminAccountStatementPage", () => {
  beforeAll(setupAdminPageTest);
  useSetting(featureSetting("money"));

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
    const html = adminAccountStatementPage(acct, lines, refs, OWNER_SESSION);
    assertStringIncludes(html, "Ada Lovelace");
    assertStringIncludes(html, `Amount still owed: ${formatCurrency(5000)}`);
    assert(!html.includes(`Amount still owed: −${formatCurrency(5000)}`));
    // The nav links back to the ledger; no separate back-link arrow is shown.
    assertStringIncludes(html, 'href="/admin/ledger"');
    assert(!html.includes("&larr;"));
    assertStringIncludes(html, '<th class="col-amount">Running total</th>');
    assertStringIncludes(
      html,
      'href="/admin/ledger/attendee/7/add?return_url=%2Fadmin%2Fledger%2Fattendee%2F7"',
    );
    assert(!html.includes("View all money changes"));
  });

  test("shows a zero balance for an account with no history", () => {
    const html = adminAccountStatementPage(acct, [], names(), OWNER_SESSION);
    assertStringIncludes(html, `Amount still owed: ${formatCurrency(0)}`);
    assertStringIncludes(html, "No money changes yet.");
    assert(!html.includes("/admin/ledger/attendee/7/add"));
  });

  test("suppresses add and edit actions in read-only mode", () => {
    using _env = withEnv({
      READ_ONLY_FROM: "2020-01-01T00:00:00.000Z",
    });
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
      OWNER_SESSION,
    );
    assert(!html.includes("/admin/ledger/attendee/7/add"));
    assert(!html.includes("/admin/ledger/entries/77/edit"));
  });

  test("keeps the full-ledger action for accounts that cannot add entries", () => {
    const html = String(
      AccountStatementSection({
        fullLedgerHref: "/admin/ledger/writeoff/default",
        ledger: {
          account: account("writeoff", "default"),
          lines: [],
          names: names(),
        },
        returnUrl: "/admin/listing/7",
      }),
    );
    assertStringIncludes(
      html,
      'href="/admin/ledger/writeoff/default"><span>View all money changes</span></a>',
    );
    assert(!html.includes("/admin/ledger/writeoff/default/add"));
  });
});
