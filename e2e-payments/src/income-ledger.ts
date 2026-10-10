/**
 * The listing income ledger, read in the admin: its text on the current
 * page, and its "Total income earned" row parsed to minor units.
 */

import type { BrowserSession } from "./browser.ts";

/** The listing income ledger's text on the CURRENT admin listing page, or
 * null when no income was recognised (the section does not render). */
export const incomeLedgerText = async (
  session: BrowserSession,
): Promise<string | null> => {
  const ledger = session.page.locator("#income-ledger");
  return (await ledger.count()) === 0 ? null : await ledger.innerText();
};

/** The income ledger's own label for what a listing earned before refunds. */
const TOTAL_INCOME_EARNED = "Total income earned";

/**
 * What the ledger's "Total income earned" row reports, in minor units, or
 * null when the ledger carries no such row. Read from that one labelled row
 * rather than from the ledger text at large: the ledger also lists gross
 * sales, costs and refunds, so a plain search for an amount could be
 * satisfied by a different row that happens to carry the same figure. The
 * app writes a negative amount as U+2212 before the currency symbol
 * ("−£9.00"), so the sign is normalised and kept — a refund row can never
 * answer for income.
 */
export const totalIncomeEarnedMinor = (ledger: string): number | null => {
  const row = ledger
    .split("\n")
    .find((line) => line.includes(TOTAL_INCOME_EARNED));
  if (row === undefined) return null;
  const amount = row
    .slice(row.indexOf(TOTAL_INCOME_EARNED) + TOTAL_INCOME_EARNED.length)
    .replace(/−/g, "-")
    .replace(/[^\d.-]/g, "");
  const minor = Math.round(Number(amount) * 100);
  return amount === "" || Number.isNaN(minor) ? null : minor;
};
