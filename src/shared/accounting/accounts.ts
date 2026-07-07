/**
 * The chart of accounts — the small fixed set of account types and the builders
 * that map domain rows onto ledger accounts. The ledger itself is type-agnostic;
 * this module is where "attendee 3" becomes the account `attendee:3`.
 */

import * as v from "valibot";
import { account } from "#shared/ledger/account.ts";
import type { AccountRef } from "#shared/ledger/types.ts";
import { guardFor } from "#shared/validation/guard.ts";

/** The account `type` for an attendee's receivable/clearing account. Exported so
 *  the batch booking writer can tell which side of a leg is the attendee account
 *  and render its id as an in-batch subquery rather than a literal. */
export const ATTENDEE = "attendee";
export const COST = "cost";
export const REVENUE = "revenue";
export const MODIFIER = "modifier";
export const FEE_INCOME = "fee_income";
export const EXTERNAL = "external";
export const WRITEOFF_TYPE = "writeoff";

/**
 * The row-backed account types — each account of these types belongs to one
 * domain row (attendee/listing/modifier), with the stringified row id as the
 * account id. The picklist is the single source of truth: the TS union, the
 * runtime guard, and every exhaustive `Record` dispatcher (route parsing,
 * label/link resolution) derive from it, so a new account type is a compile
 * error in each dispatcher rather than a silently missing arm.
 */
export const RowAccountTypeSchema = v.picklist([
  ATTENDEE,
  COST,
  MODIFIER,
  REVENUE,
]);
export type RowAccountType = v.InferOutput<typeof RowAccountTypeSchema>;
export const isRowAccountType = guardFor(RowAccountTypeSchema);

/** The singleton account types — one fixed account per type (see
 *  {@link SINGLETON_ACCOUNTS}). Same picklist pattern as the row-backed types. */
export const SingletonAccountTypeSchema = v.picklist([
  EXTERNAL,
  FEE_INCOME,
  WRITEOFF_TYPE,
]);
export type SingletonAccountType = v.InferOutput<
  typeof SingletonAccountTypeSchema
>;
export const isSingletonAccountType = guardFor(SingletonAccountTypeSchema);

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

/** Operator-recorded servicing costs for one listing. */
export const costAccount = rowAccount(COST);

/** One discount/surcharge modifier's net effect. */
export const modifierAccount = rowAccount(MODIFIER);

/**
 * Every singleton account, keyed by its type — the one dispatch table for
 * resolving `external`/`fee_income`/`writeoff` (e.g. from a statement route).
 * Exhaustive over {@link SingletonAccountType}, so declaring a new singleton
 * type without its account is a compile error.
 */
export const SINGLETON_ACCOUNTS: Record<SingletonAccountType, AccountRef> = {
  [EXTERNAL]: WORLD,
  [FEE_INCOME]: BOOKING_FEE_INCOME,
  [WRITEOFF_TYPE]: WRITEOFF,
};

/**
 * The row-backed account constructor for each type — exhaustive over
 * {@link RowAccountType}, so a new row-backed type must declare how its rows
 * map to accounts before any dispatcher can forget it.
 */
export const ROW_ACCOUNT_CONSTRUCTORS: Record<
  RowAccountType,
  (id: number) => AccountRef
> = {
  [ATTENDEE]: attendeeAccount,
  [COST]: costAccount,
  [MODIFIER]: modifierAccount,
  [REVENUE]: revenueAccount,
};
