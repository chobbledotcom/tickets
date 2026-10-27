import { isManualLedgerEntryType } from "#accounting/manual-entries.ts";
import { t } from "#i18n";
import { formatCurrency, formatSignedCurrency } from "#shared/currency.ts";
import { sameAccount } from "#shared/ledger/account.ts";
import type { StatementLine } from "#shared/ledger/project.ts";
import type { AccountRef } from "#shared/ledger/types.ts";
import { ledgerEntryAddHref } from "#shared/ledger-links.ts";
import {
  type AccountCell,
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
  timeColumn,
} from "#templates/admin/ledger.tsx";
import { ActionButton } from "#templates/components/actions.tsx";
import { PageBlock } from "#templates/components/page-structure.tsx";
import type { AdminSession } from "#types";

const counterparty = (line: StatementLine, account: AccountRef): AccountRef =>
  sameAccount(line.transfer.destination, account)
    ? line.transfer.source
    : line.transfer.destination;

/** One statement row's activity line: the human description, plus the
 * operator's own description when an owner-entered entry carries one (an
 * API-created adjustment). The loader decrypts the memo first. */
const statementActivity = (
  line: StatementLine,
  accountCell: AccountCell,
): JSX.Element => {
  const { memo } = line.transfer;
  return (
    <>
      {humanDescription(line.transfer, accountCell)}
      {memo && isManualLedgerEntryType(line.transfer.kind ?? "") ? (
        <> {memo}.</>
      ) : null}
    </>
  );
};

export type AccountLedgerData = {
  account: AccountRef;
  lines: StatementLine[];
  names: LedgerNames;
};

/** One account's running-balance statement. */
const AccountStatementTable = ({
  ledger: { account, lines, names },
  returnUrl,
}: {
  ledger: AccountLedgerData;
  returnUrl?: string;
}): JSX.Element => {
  const accountCell = accountCellFor(names);
  return LedgerColumnsTable({
    columns: [
      timeColumn((line: StatementLine) => line.transfer.occurredAt),
      {
        cell: (line) => statementActivity(line, accountCell),
        headerKey: "admin.ledger.col.activity",
        key: "activity",
      },
      {
        cell: (line) => accountCell(counterparty(line, account)),
        headerKey: "admin.ledger.col.counterparty",
        key: "counterparty",
      },
      amountColumn<StatementLine>("delta", "admin.ledger.col.delta", (line) =>
        amountCell(
          line.transfer,
          formatSignedCurrency(shownFigure(line.signed, account)),
          returnUrl,
        ),
      ),
      amountColumn<StatementLine>(
        "balance",
        "admin.ledger.col.balance",
        (line) => formatCurrency(shownFigure(line.running, account)),
      ),
    ],
    rows: lines,
  });
};

const AccountStatementHeading = ({
  ledger: { account, lines, names },
}: {
  ledger: AccountLedgerData;
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
  ledger,
  returnUrl,
  fullLedgerHref,
}: {
  ledger: AccountLedgerData;
} & StatementLinks): JSX.Element => (
  <PageBlock>
    <AccountStatementHeading ledger={ledger} />
    <AccountStatementActions
      account={ledger.account}
      fullLedgerHref={fullLedgerHref}
      names={ledger.names}
      returnUrl={returnUrl}
    />
    <AccountStatementTable ledger={ledger} returnUrl={returnUrl} />
  </PageBlock>
);

export const EmbeddedAccountStatementSection = ({
  id,
  ...statement
}: {
  id?: string;
  ledger: AccountLedgerData;
} & StatementLinks): JSX.Element => (
  <PageBlock id={id}>
    <h2>{t("admin.ledger.statement_heading")}</h2>
    <AccountStatementSection {...statement} />
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
      ledger={{ account, lines, names }}
      returnUrl={`/admin/ledger/${account.type}/${account.id}`}
    />,
  );
