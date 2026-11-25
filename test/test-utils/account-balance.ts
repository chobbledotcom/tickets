import {
  balanceIn,
  foldOf,
  ledgerLegs,
  oneAccount,
} from "#accounting/projection-sql.ts";
import { requireOne } from "#db/client.ts";
import type { AccountRef } from "#shared/ledger/types.ts";

/** Balance of one account: money in as the destination, less money out as
 *  the source. Zero when the account has no transfers. */
export const accountBalance = async (acct: AccountRef): Promise<number> => {
  const balance = balanceIn(oneAccount(acct.type, acct.id));
  const row = await requireOne(
    ledgerLegs()
      .where(balance.rows)
      .select((leg) => ({ balance: foldOf(balance, leg, false) })),
  );
  return Number(row.balance);
};
