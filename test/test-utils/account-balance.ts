import { readMeasuresByAccount } from "#accounting/measure-reads.ts";
import { balanceIn, oneAccount } from "#accounting/projection-sql.ts";
import type { AccountRef } from "#shared/ledger/types.ts";
import { requireValue } from "#shared/required-value.ts";

/** Balance of one account: money in as the destination, less money out as
 *  the source. Zero when the account has no transfers. */
export const accountBalance = async (acct: AccountRef): Promise<number> => {
  const read = await readMeasuresByAccount([acct.id], (id) => ({
    balance: balanceIn(oneAccount(acct.type, id)),
  }));
  // One account in the VALUES list gives one row, keyed by that id.
  const row = requireValue(
    read.get(acct.id),
    `accountBalance: no row for ${acct.type}:${acct.id}`,
  );
  return row.balance;
};
