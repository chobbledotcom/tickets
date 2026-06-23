/**
 * The chart of accounts — the small fixed set of account types and the builders
 * that map domain rows onto ledger accounts. The ledger itself is type-agnostic;
 * this module is where "attendee 3" becomes the account `attendee:3`.
 */

import { account } from "#shared/ledger/account.ts";
import type { AccountRef } from "#shared/ledger/types.ts";

const ATTENDEE = "attendee";
const REVENUE = "revenue";
const MODIFIER = "modifier";
const FEE_INCOME = "fee_income";
const EXTERNAL = "external";
const WRITEOFF_TYPE = "writeoff";

/** The outside world — cash in via cards/bank, the source of every payment. */
export const WORLD: AccountRef = account(EXTERNAL, "world");

/** The operator's booking-fee income. */
export const BOOKING_FEE_INCOME: AccountRef = account(FEE_INCOME, "booking");

/**
 * Contra-revenue: manual corrections and comps source/sink here so cash reports
 * — `world→*` — stay honest. A manual money correction posts an `adjustment` leg
 * against this account (never external cash), so adjusting a listing's income, a
 * modifier's revenue, or an attendee's balance moves the recognised figure
 * without booking a phantom payment in or out of the world.
 */
export const WRITEOFF: AccountRef = account(WRITEOFF_TYPE, "default");

/**
 * Build the account constructor for one type of row-backed account. The row id
 * must be a positive safe integer: a zero, negative, fractional, or unsafe id
 * would mint a phantom account (e.g. `attendee:1.5`) that the ledger accepts —
 * its account ids are only checked for non-emptiness — silently diverting money
 * from the real row's balance, statements, and refunds. Reject such ids at
 * construction, so every row-backed type validates identically.
 */
const rowAccount =
  (kind: string) =>
  (id: number): AccountRef => {
    if (!Number.isSafeInteger(id) || id <= 0) {
      throw new Error(
        `${kind} account id must be a positive safe integer: ${id}`,
      );
    }
    return account(kind, id);
  };

/** One attendee's receivable/clearing account; its balance is what they owe. */
export const attendeeAccount = rowAccount(ATTENDEE);

/** Gross ticket revenue for one listing. */
export const revenueAccount = rowAccount(REVENUE);

/** One discount/surcharge modifier's net effect. */
export const modifierAccount = rowAccount(MODIFIER);
