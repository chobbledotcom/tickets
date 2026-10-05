import type { AccountRef } from "#shared/ledger/types.ts";
import { withReturnUrl } from "#shared/return-url-field.tsx";

/** The full-ledger view scoped to one listing's revenue and servicing costs. */
export const listingLedgerHref = (listingId: number): string =>
  `/admin/ledger?listing=${listingId}`;

/** One manual transfer's edit form, returning the operator to where they came
 * from. */
export const ledgerEntryEditHref = (
  transferId: number,
  returnUrl: string,
): string =>
  withReturnUrl(`/admin/ledger/entries/${transferId}/edit`, returnUrl);

/** The add-entry form for one account, returning the operator to where they
 * came from. */
export const ledgerEntryAddHref = (
  account: AccountRef,
  returnUrl: string,
): string =>
  withReturnUrl(`/admin/ledger/${account.type}/${account.id}/add`, returnUrl);
