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

/** One attendee's receivable/clearing account; its balance is what they owe. */
export const attendeeAccount = (id: number): AccountRef =>
  account(ATTENDEE, id);

/** Gross ticket revenue for one listing. */
export const revenueAccount = (listingId: number): AccountRef =>
  account(REVENUE, listingId);

/** One discount/surcharge modifier's net effect. */
export const modifierAccount = (modifierId: number): AccountRef =>
  account(MODIFIER, modifierId);
