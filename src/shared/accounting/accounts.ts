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

/** The outside world — cash in via cards/bank, the source of every payment. */
export const WORLD: AccountRef = account(EXTERNAL, "world");

/** The operator's booking-fee income. */
export const BOOKING_FEE_INCOME: AccountRef = account(FEE_INCOME, "booking");

/**
 * Row-backed accounts key off a real table id. A zero, negative, fractional, or
 * unsafe-integer id would mint a phantom account (e.g. `attendee:1.5`) that the
 * ledger accepts — its account ids are only checked for non-emptiness — silently
 * diverting money from the real row's balance, statements, and refunds. Reject
 * such ids at construction.
 */
const rowId = (kind: string, id: number): number => {
  if (!Number.isSafeInteger(id) || id <= 0) {
    throw new Error(
      `${kind} account id must be a positive safe integer: ${id}`,
    );
  }
  return id;
};

/** One attendee's receivable/clearing account; its balance is what they owe. */
export const attendeeAccount = (id: number): AccountRef =>
  account(ATTENDEE, rowId(ATTENDEE, id));

/** Gross ticket revenue for one listing. */
export const revenueAccount = (listingId: number): AccountRef =>
  account(REVENUE, rowId(REVENUE, listingId));

/** One discount/surcharge modifier's net effect. */
export const modifierAccount = (modifierId: number): AccountRef =>
  account(MODIFIER, rowId(MODIFIER, modifierId));
