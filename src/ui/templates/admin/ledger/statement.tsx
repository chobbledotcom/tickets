import { t } from "#i18n";
import { formatCurrency, formatSignedCurrency } from "#shared/currency.ts";
import { sameAccount } from "#shared/ledger/account.ts";
import type { StatementLine } from "#shared/ledger/project.ts";
import type { AccountRef } from "#shared/ledger/types.ts";
import type { AdminSession } from "#shared/types.ts";
import {
  humanDescription,
  shownFigure,
  statementBalanceKey,
} from "#templates/admin/ledger/formatting.tsx";
import {
  accountCellFor,
  accountLabelText,
  adminLedgerShell,
  amountCell,
  amountColumn,
  canAddLedgerEntry,
  LedgerColumnsTable,
  type LedgerNames,
  ledgerEntryAddHref,
  timeColumn,
} from "#templates/admin/ledger.tsx";
import { ActionButton } from "#templates/components/actions.tsx";
import { PageBlock } from "#templates/components/page-structure.tsx";

const counterparty = (line: StatementLine, account: AccountRef): AccountRef =>
  sameAccount(line.transfer.destination, account)
    ? line.transfer.source
    : line.transfer.destination;

/** One account's running-balance statement. */
const AccountStatementTable = ({
  account,
  lines,
  names,
  returnUrl,
}: {
  account: AccountRef;
  lines: StatementLine[];
  names: LedgerNames;
  returnUrl?: string;
}): JSX.Element => {
  const accountCell = accountCellFor(names);
  return LedgerColumnsTable({
    columns: [
      timeColumn((line: StatementLine) => line.transfer.occurredAt),
      {
        cell: (line) => humanDescription(line.transfer, accountCell),
        headerKey: "admin.ledger.col.activity",
      },
      {
        cell: (line) => accountCell(counterparty(line, account)),
        headerKey: "admin.ledger.col.counterparty",
      },
      amountColumn<StatementLine>("admin.ledger.col.delta", (line) =>
        amountCell(
          line.transfer,
          formatSignedCurrency(shownFigure(line.signed, account)),
          returnUrl,
        ),
      ),
      amountColumn<StatementLine>("admin.ledger.col.balance", (line) =>
        formatCurrency(shownFigure(line.running, account)),
      ),
    ],
    rows: lines,
  });
};

const AccountStatementHeading = ({
  account,
  lines,
  names,
}: {
  account: AccountRef;
  lines: StatementLine[];
  names: LedgerNames;
}): JSX.Element => {
  const balance = lines.length > 0 ? lines[lines.length - 1]!.running : 0;
  return (
    <p class="ledger-balance">
      <strong>{accountLabelText(account, names)}</strong>{" "}
      {t(statementBalanceKey(account), {
        amount: formatSignedCurrency(shownFigure(balance, account), false),
      })}
    </p>
  );
};

export type AccountLedgerData = {
  account: AccountRef;
  lines: StatementLine[];
  names: LedgerNames;
};

const AccountStatementActions = ({
  account,
  names,
  fullLedgerHref,
  returnUrl,
}: {
  account: AccountRef;
  names: LedgerNames;
  fullLedgerHref?: string | undefined;
  returnUrl: string;
}): JSX.Element | null => {
  const showAdd = canAddLedgerEntry(account, names);
  if (!showAdd && !fullLedgerHref) return null;
  return (
    <p class="table-action-btns">
      {showAdd && (
        <ActionButton href={ledgerEntryAddHref(account, returnUrl)} icon="plus">
          {t("admin.ledger.add.link")}
        </ActionButton>
      )}
      {fullLedgerHref && (
        <ActionButton href={fullLedgerHref}>
          {t("attendee_detail.view_full_ledger")}
        </ActionButton>
      )}
    </p>
  );
};

/** Where a statement links back to: the page it returns to, and an optional
 * "see the full ledger" link. */
type StatementLinks = {
  returnUrl: string;
  fullLedgerHref?: string | undefined;
};

export const AccountStatementSection = ({
  account,
  lines,
  names,
  returnUrl,
  fullLedgerHref,
}: {
  account: AccountRef;
  lines: StatementLine[];
  names: LedgerNames;
} & StatementLinks): JSX.Element => (
  <PageBlock>
    <AccountStatementHeading account={account} lines={lines} names={names} />
    <AccountStatementActions
      account={account}
      fullLedgerHref={fullLedgerHref}
      names={names}
      returnUrl={returnUrl}
    />
    <AccountStatementTable
      account={account}
      lines={lines}
      names={names}
      returnUrl={returnUrl}
    />
  </PageBlock>
);

export const EmbeddedAccountStatementSection = ({
  id,
  ledger,
  returnUrl,
  fullLedgerHref,
}: {
  id?: string;
  ledger: AccountLedgerData;
} & StatementLinks): JSX.Element => (
  <PageBlock id={id}>
    <h2>{t("admin.ledger.statement_heading")}</h2>
    <AccountStatementSection
      account={ledger.account}
      fullLedgerHref={fullLedgerHref}
      lines={ledger.lines}
      names={ledger.names}
      returnUrl={returnUrl}
    />
  </PageBlock>
);

export const adminAccountStatementPage = (
  account: AccountRef,
  lines: StatementLine[],
  names: LedgerNames,
  session: AdminSession,
): string =>
  adminLedgerShell(
    "admin.ledger.statement_heading",
    session,
    <AccountStatementSection
      account={account}
      lines={lines}
      names={names}
      returnUrl={`/admin/ledger/${account.type}/${account.id}`}
    />,
  );
