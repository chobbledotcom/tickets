import {
  isRowAccountType,
  isSingletonAccountType,
  ROW_ACCOUNT_CONSTRUCTORS,
  SINGLETON_ACCOUNTS,
} from "#accounting/accounts.ts";
import { transfersByAccount } from "#accounting/queries.ts";
import { decrypt, ENCRYPTION_PREFIX } from "#crypto/encryption.ts";
import type { EnvKeyEncrypted } from "#crypto/sealed.ts";
import {
  accountsOf,
  loadLedgerNamesForAccounts,
} from "#routes/admin/ledger/names.ts";
import { ownerTypeRefHtml } from "#routes/admin/ledger/route-helpers.ts";
import type { TypedRouteHandler } from "#routes/router.ts";
import { statementFor } from "#shared/ledger/project.ts";
import type { AccountRef } from "#shared/ledger/types.ts";
import { parsePositiveInt as parsePositiveIntId } from "#shared/validation/number.ts";
import {
  type AccountLedgerData,
  adminAccountStatementPage,
} from "#templates/admin/ledger/statement.tsx";

export const accountFromRoute = (
  type: string,
  ref: string,
): AccountRef | null => {
  if (isSingletonAccountType(type)) return SINGLETON_ACCOUNTS[type];
  if (!isRowAccountType(type)) return null;
  const id = parsePositiveIntId(ref);
  return id === null ? null : ROW_ACCOUNT_CONSTRUCTORS[type](id);
};

/** A memo the statement can show the reader: plaintext stays as stored, and an
 * owner-key-encrypted memo (an operator-entered description) is decrypted for
 * display. The prefix check keeps a PII-free plaintext memo (a refund reason
 * code) from being parsed as ciphertext. */
export const readableMemo = async (
  memo: string | undefined,
): Promise<string | undefined> => {
  if (
    memo === undefined ||
    memo === "" ||
    !memo.startsWith(ENCRYPTION_PREFIX)
  ) {
    return memo;
  }
  return decrypt(memo as EnvKeyEncrypted<string>);
};

export const loadAccountLedger = async (
  account: AccountRef,
): Promise<AccountLedgerData> => {
  const transfers = await transfersByAccount(account);
  const readable = await Promise.all(
    transfers.map(async (transfer) => {
      const memo = await readableMemo(transfer.memo);
      // Keep a memo-less transfer untouched: `memo: undefined` must not become
      // an explicit property on a transfer that carries none.
      return memo === undefined ? { ...transfer } : { ...transfer, memo };
    }),
  );
  return {
    account,
    lines: statementFor(account)(readable),
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
