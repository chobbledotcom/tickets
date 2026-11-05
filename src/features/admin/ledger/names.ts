import {
  ATTENDEE,
  COST,
  MODIFIER,
  REVENUE,
  type RowAccountType,
} from "#accounting/accounts.ts";
import { getModifierNamesByIds } from "#db/modifiers.ts";
import { mapNotNullish, unique } from "#fp";
import { loadAttendeeAndListingRefs } from "#routes/admin/actions.ts";
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
  const listingIds = unique([
    ...referencedAccountIds(accounts, REVENUE),
    ...referencedAccountIds(accounts, COST),
  ]);
  const modifierIds = referencedAccountIds(accounts, MODIFIER);
  const [named, modifiers] = await Promise.all([
    loadAttendeeAndListingRefs(
      referencedAccountIds(accounts, ATTENDEE),
      listingIds,
    ),
    getModifierNamesByIds(modifierIds),
  ]);
  return { ...named, modifiers };
};

export const loadLedgerNames = (transfers: Transfer[]): Promise<LedgerNames> =>
  loadLedgerNamesForAccounts(accountsOf(transfers));
