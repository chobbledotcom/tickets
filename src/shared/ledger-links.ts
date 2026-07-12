/** The full-ledger view scoped to one listing's revenue and servicing costs. */
export const listingLedgerHref = (listingId: number): string =>
  `/admin/ledger?listing=${listingId}`;
