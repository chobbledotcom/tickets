import {
  accountsOf,
  loadLedgerNamesForAccounts,
} from "#routes/admin/ledger/names.ts";
import { ownerTypeRefHtml } from "#routes/admin/ledger/route-helpers.ts";
import type { TypedRouteHandler } from "#routes/router.ts";
import {
  isRowAccountType,
  isSingletonAccountType,
  ROW_ACCOUNT_CONSTRUCTORS,
  SINGLETON_ACCOUNTS,
} from "#shared/accounting/accounts.ts";
import { transfersByAccount } from "#shared/accounting/queries.ts";
import { statementFor } from "#shared/ledger/project.ts";
import type { AccountRef } from "#shared/ledger/types.ts";
import { parsePositiveIntId } from "#shared/validation/number.ts";
import type { AccountLedgerData } from "#templates/admin/ledger/statement.tsx";
import { adminAccountStatementPage } from "#templates/admin/ledger/statement.tsx";

export const accountFromRoute = (
  type: string,
  ref: string,
): AccountRef | null => {
  if (isSingletonAccountType(type)) return SINGLETON_ACCOUNTS[type];
  if (!isRowAccountType(type)) return null;
  const id = parsePositiveIntId(ref);
  return id === null ? null : ROW_ACCOUNT_CONSTRUCTORS[type](id);
};

export const loadAccountLedger = async (
  account: AccountRef,
): Promise<AccountLedgerData> => {
  const transfers = await transfersByAccount(account);
  return {
    account,
    lines: statementFor(account)(transfers),
    names: await loadLedgerNamesForAccounts([
      account,
      ...accountsOf(transfers),
    ]),
  };
};

export const handleAccountStatementGet: TypedRouteHandler<"GET /admin/ledger/:type/:ref"> =
  ownerTypeRefHtml(async (_request, session, { type, ref }) => {
    const account = accountFromRoute(type, ref);
    if (!account) return null;
    const { lines, names } = await loadAccountLedger(account);
    return adminAccountStatementPage(account, lines, names, session);
  });
