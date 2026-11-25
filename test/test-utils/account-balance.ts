import { readMeasuresByAccount } from "#accounting/measure-reads.ts";
import { balanceIn, oneAccount } from "#accounting/projection-sql.ts";
import { requiredMapValue } from "#fp";
import type { AccountRef } from "#shared/ledger/types.ts";

/** Balance of one account: money in as the destination, less money out as
 *  the source. Zero when the account has no transfers. */
export const accountBalance = async (acct: AccountRef): Promise<number> =>
  requiredMapValue(
    await readMeasuresByAccount([acct.id], (id) => ({
      balance: balanceIn(oneAccount(acct.type, id)),
    })),
    acct.id,
  ).balance;
