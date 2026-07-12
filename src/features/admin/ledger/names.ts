import { mapNotNullish, unique } from "#fp";
import { loadAttendeeNames } from "#routes/admin/actions.ts";
import {
  ATTENDEE,
  COST,
  MODIFIER,
  REVENUE,
  type RowAccountType,
} from "#shared/accounting/accounts.ts";
import { getListingNamesByIds } from "#shared/db/listings.ts";
import { getAllModifiers } from "#shared/db/modifiers.ts";
import type { AccountRef, Transfer } from "#shared/ledger/types.ts";
import type { LedgerNames } from "#templates/admin/ledger.tsx";

const ROW_ACCOUNT_NAMES: Record<
  RowAccountType,
  (names: LedgerNames) => Map<number, string>
> = {
  attendee: (names) => names.attendees,
  cost: (names) => names.listings,
  modifier: (names) => names.modifiers,
  revenue: (names) => names.listings,
};

export const hasLedgerName = (
  type: RowAccountType,
  id: string,
  names: LedgerNames,
): boolean => ROW_ACCOUNT_NAMES[type](names).has(Number(id));

const referencedAccountIds = (accounts: AccountRef[], type: string): number[] =>
  unique(
    mapNotNullish((account: AccountRef) =>
      account.type === type ? Number(account.id) : null,
    )(accounts),
  );

export const accountsOf = (transfers: Transfer[]): AccountRef[] =>
  transfers.flatMap((transfer) => [transfer.source, transfer.destination]);

export const loadLedgerNamesForAccounts = async (
  accounts: AccountRef[],
): Promise<LedgerNames> => {
  const attendeeIds = referencedAccountIds(accounts, ATTENDEE);
  const listingIds = unique([
    ...referencedAccountIds(accounts, REVENUE),
    ...referencedAccountIds(accounts, COST),
  ]);
  const modifierIds = new Set(referencedAccountIds(accounts, MODIFIER));
  const [attendees, listings, modifiers] = await Promise.all([
    loadAttendeeNames(attendeeIds),
    getListingNamesByIds(listingIds),
    modifierIds.size > 0 ? getAllModifiers() : Promise.resolve([]),
  ]);
  return {
    attendees,
    listings,
    modifiers: new Map(
      modifiers
        .filter((modifier) => modifierIds.has(modifier.id))
        .map((modifier) => [modifier.id, modifier.name]),
    ),
  };
};

export const loadLedgerNames = (transfers: Transfer[]): Promise<LedgerNames> =>
  loadLedgerNamesForAccounts(accountsOf(transfers));
