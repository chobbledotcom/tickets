import {
  ATTENDEE,
  COST,
  MODIFIER,
  REVENUE,
  type RowAccountType,
} from "#accounting/accounts.ts";
import { listingNames } from "#db/listings/records.ts";
import { getModifierNamesByIds } from "#db/modifiers.ts";
import { mapNotNullish, unique } from "#fp";
import { loadAttendeeNames } from "#routes/admin/actions.ts";
import type { AccountRef, Transfer } from "#shared/ledger/types.ts";
import {
  type LedgerNames,
  ledgerNamesForAccountType,
} from "#templates/admin/ledger.tsx";

export const hasLedgerName = (
  type: RowAccountType,
  id: string,
  names: LedgerNames,
): boolean => ledgerNamesForAccountType(type, names).has(Number(id));

const referencedAccountIds = (
  accounts: AccountRef[],
  type: RowAccountType,
): number[] =>
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
  const modifierIds = referencedAccountIds(accounts, MODIFIER);
  const [attendees, listings, modifiers] = await Promise.all([
    loadAttendeeNames(attendeeIds),
    listingNames.byIds(listingIds),
    getModifierNamesByIds(modifierIds),
  ]);
  return {
    attendees,
    listings,
    modifiers,
  };
};

export const loadLedgerNames = (transfers: Transfer[]): Promise<LedgerNames> =>
  loadLedgerNamesForAccounts(accountsOf(transfers));
