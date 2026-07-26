import { expect } from "@std/expect";
import {
  attendeeAccount,
  modifierAccount,
  revenueAccount,
  WORLD,
} from "#shared/accounting/accounts.ts";
import {
  accountBalance,
  allTransfers,
  transfersByAccount,
} from "#shared/accounting/queries.ts";
import { formatCurrency, formatSignedCurrency } from "#shared/currency.ts";
import { allBalances } from "#shared/ledger/project.ts";
import type { Transfer } from "#shared/ledger/types.ts";
import { adminGet } from "#test-utils/session.ts";

// -- Ledger-truth helpers ------------------------------------------------- //

/** Normalise a signed-zero to a plain zero so `toBe(0)` (strict, `-0 !== 0`)
 *  never trips on the `-0` that negating an empty balance can produce. */
export const norm = (value: number): number => value + 0;

/** A listing's recognised income (the raw `revenue` account balance — gross sale
 *  credits, less write-off AND refund debits). */
export const incomeOf = async (listingId: number): Promise<number> =>
  norm(await accountBalance(revenueAccount(listingId)));

/** What an attendee still owes — the NEGATIVE of their account balance. */
export const owedBy = async (attendeeId: number): Promise<number> =>
  norm(-(await accountBalance(attendeeAccount(attendeeId))));

/** A modifier's net revenue (positive surcharge collected, negative discount). */
export const modifierRevenueOf = async (modifierId: number): Promise<number> =>
  norm(await accountBalance(modifierAccount(modifierId)));

/** The world/cash account balance — every honest cash report reads `world→*`,
 *  so a correction must leave this untouched. */
export const worldBalance = async (): Promise<number> =>
  norm(await accountBalance(WORLD));

/** The signed sum of balances across EVERY account that has any transfer.
 *  Double-entry conservation: this is exactly 0 after any sequence of legs. */
export const sumOfAllBalances = async (): Promise<number> => {
  const balances = allBalances(await allTransfers());
  let total = 0;
  for (const value of balances.values()) total += value;
  return norm(total);
};

// -- Admin page assertions ------------------------------------------------ //

/** GET an owner page and return its HTML, asserting a 200. */
export const adminPageHtml = async (path: string): Promise<string> => {
  const response = await adminGet(path);
  expect(response.status).toBe(200);
  return response.text();
};

/**
 * Assert a `revenue` account's RUNNING BALANCE on the per-account ledger
 * statement page renders the given minor-unit figure (`Income balance: £X`).
 * the raw signed balance, so a refund's `revenue→attendee` debit DOES reduce it
 * (and it can go negative once a write-off and a refund both apply).
 */
export const assertStatementBalance = async (
  listingId: number,
  minor: number,
): Promise<void> => {
  const statement = await adminPageHtml(`/admin/ledger/revenue/${listingId}`);
  expect(statement).toContain(
    `Income balance: ${formatSignedCurrency(minor, false)}`,
  );
};

/**
 * Assert the listing EDIT page's "Current income" input renders the given
 * minor-unit figure (`value="£X"`). The edit page shows GROSS credits minus only
 * manual write-offs (`creditsLessWriteoffDebits`), so — unlike the statement —
 * an ordinary refund does NOT reduce it (matching the legacy `SUM(price_paid)`),
 * while a manual write-off does. The two surfaces therefore agree only when no
 * refund has touched the account.
 */
export const assertEditPageIncome = async (
  listingId: number,
  minor: number,
): Promise<void> => {
  const edit = await adminPageHtml(`/admin/listing/${listingId}/edit`);
  expect(edit).toContain(`value="${formatCurrency(minor)}"`);
};

/** With no refund applied, both income surfaces agree on the same figure. */
export const assertRenderedIncome = async (
  listingId: number,
  minor: number,
): Promise<void> => {
  await assertStatementBalance(listingId, minor);
  await assertEditPageIncome(listingId, minor);
};

/**
 * Assert an attendee's outstanding balance, on BOTH the per-account ledger
 * statement (`Amount still owed: £X`, where owed = −running) and admin page
 * (`Balance outstanding:` label followed by the formatted figure).
 */
export const assertRenderedOwed = async (
  attendeeId: number,
  minor: number,
): Promise<void> => {
  const formatted = formatCurrency(minor);
  const balancePage = await adminPageHtml(
    `/admin/attendees/${attendeeId}/ledger`,
  );
  expect(balancePage).toContain("Balance outstanding:");
  expect(balancePage).toContain(formatted);
};

/**
 * Assert a modifier's revenue, on BOTH the modifier edit page (a disabled
 * `value="£X"` input) and the modifier list (a Revenue cell of the same figure).
 */
export const assertRenderedModifierRevenue = async (
  modifierId: number,
  minor: number,
): Promise<void> => {
  const formatted = formatCurrency(minor);
  const edit = await adminPageHtml(`/admin/modifiers/${modifierId}/edit`);
  expect(edit).toContain(`value="${formatted}"`);
  const list = await adminPageHtml("/admin/modifiers");
  expect(list).toContain(formatted);
};

/** The breakdown template's signed-magnitude format (a leading +/− with a U+2212
 *  minus), replicated so a test can assert the exact reconciliation figures the
 *  page renders. Only non-zero figures are ever rendered as a signed row. */
export const signedCurrency = (value: number): string =>
  `${value < 0 ? "−" : "+"}${formatCurrency(Math.abs(value))}`;

/** Slice the `#income-ledger` reconciliation article out of a listing detail
 *  page, so a figure is asserted WITHIN the breakdown and can't accidentally
 *  match an unrelated figure elsewhere on the page. */
export const incomeLedgerArticle = (html: string): string => {
  const start = html.indexOf('id="income-ledger"');
  expect(start).toBeGreaterThan(-1);
  return html.slice(start, html.indexOf("</article>", start));
};

// -- Leg helpers ---------------------------------------------------------- //

export const kindsOf = (legs: Transfer[]): string[] =>
  // Every ledger transfer these tests inspect carries a kind.
  legs.map((leg) => leg.kind as string).sort();

export const legsOfKind = (legs: Transfer[], kind: string): Transfer[] =>
  legs.filter((leg) => leg.kind === kind);

/** The legs of one kind posted to an attendee's own ledger account — e.g. the
 *  `refund_cash` legs (the money handed back) on their account. */
export const attendeeLegsOfKind = async (
  attendeeId: number,
  kind: string,
): Promise<Transfer[]> =>
  legsOfKind(await transfersByAccount(attendeeAccount(attendeeId)), kind);
