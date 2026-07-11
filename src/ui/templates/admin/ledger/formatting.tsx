import { t } from "#i18n";
import {
  ATTENDEE,
  COST,
  REVENUE,
  WRITEOFF_TYPE,
} from "#shared/accounting/accounts.ts";
import { KIND } from "#shared/accounting/kinds.ts";
import {
  type ManualLedgerEntryType,
  manualEntrySpecByType,
} from "#shared/accounting/manual-entries.ts";
import type { AccountRef, Transfer } from "#shared/ledger/types.ts";

type AccountCell = (account: AccountRef) => JSX.Element | string;

const humanAccount = (transfer: Transfer, type: string): AccountRef | null => {
  if (transfer.source.type === type) return transfer.source;
  if (transfer.destination.type === type) return transfer.destination;
  return null;
};

const sentenceWithAccount = (
  key: string,
  account: AccountRef | null,
  accountCell: AccountCell,
): JSX.Element =>
  account ? (
    <>
      {t(key)} {accountCell(account)}
    </>
  ) : (
    <span>{t(key)}</span>
  );

const fallbackHumanDescription = (
  transfer: Transfer,
  accountCell: AccountCell,
): JSX.Element => (
  <>
    {t("admin.ledger.human.transfer_from")} {accountCell(transfer.source)}{" "}
    {t("admin.ledger.human.transfer_to")} {accountCell(transfer.destination)}
  </>
);

const saleDescription = (
  transfer: Transfer,
  accountCell: AccountCell,
): JSX.Element => (
  <>
    {accountCell(transfer.source)} {t("admin.ledger.human.booked")}{" "}
    {accountCell(transfer.destination)}
  </>
);

const adjustmentDescription = (
  transfer: Transfer,
  accountCell: AccountCell,
): JSX.Element => {
  if (
    transfer.source.type === ATTENDEE &&
    transfer.destination.type === WRITEOFF_TYPE
  ) {
    return sentenceWithAccount(
      "admin.ledger.human.manual_attendee_charge",
      transfer.source,
      accountCell,
    );
  }
  if (
    transfer.source.type === WRITEOFF_TYPE &&
    transfer.destination.type === ATTENDEE
  ) {
    return sentenceWithAccount(
      "admin.ledger.human.manual_attendee_writeoff",
      transfer.destination,
      accountCell,
    );
  }
  if (transfer.source.type === WRITEOFF_TYPE) {
    return sentenceWithAccount(
      "admin.ledger.human.adjustment_increase",
      transfer.destination,
      accountCell,
    );
  }
  if (transfer.destination.type === WRITEOFF_TYPE) {
    return sentenceWithAccount(
      "admin.ledger.human.adjustment_reduce",
      transfer.source,
      accountCell,
    );
  }
  return fallbackHumanDescription(transfer, accountCell);
};

export const humanDescription = (
  transfer: Transfer,
  accountCell: AccountCell,
): JSX.Element => {
  switch (transfer.kind) {
    case KIND.sale:
      return saleDescription(transfer, accountCell);
    case KIND.payment:
      return sentenceWithAccount(
        "admin.ledger.human.payment",
        humanAccount(transfer, ATTENDEE),
        accountCell,
      );
    case KIND.refundCash:
      return sentenceWithAccount(
        "admin.ledger.human.refund_cash",
        humanAccount(transfer, ATTENDEE),
        accountCell,
      );
    case KIND.refundSale:
      return sentenceWithAccount(
        "admin.ledger.human.refund_sale",
        humanAccount(transfer, REVENUE),
        accountCell,
      );
    case KIND.fee:
      return <>{t("admin.ledger.human.fee")}</>;
    case KIND.refundFee:
      return <>{t("admin.ledger.human.refund_fee")}</>;
    case KIND.serviceCost:
      return sentenceWithAccount(
        transfer.source.type === COST
          ? "admin.ledger.human.service_cost"
          : "admin.ledger.human.service_cost_reduction",
        humanAccount(transfer, COST),
        accountCell,
      );
    case KIND.adjustment:
      return adjustmentDescription(transfer, accountCell);
    default: {
      const spec =
        manualEntrySpecByType[transfer.kind as ManualLedgerEntryType];
      return spec
        ? sentenceWithAccount(
            spec.descriptionKey,
            humanAccount(transfer, spec.accountType),
            accountCell,
          )
        : fallbackHumanDescription(transfer, accountCell);
    }
  }
};

/** How one plain-language row changed the business figure it describes. */
export const humanAmount = (transfer: Transfer): number => {
  if (
    transfer.kind === KIND.refundCash ||
    transfer.kind === KIND.refundFee ||
    transfer.kind === KIND.refundSale ||
    transfer.kind === "manual_listing_cost" ||
    transfer.kind === "manual_attendee_writeoff" ||
    transfer.kind === "manual_modifier_reduction"
  ) {
    return -transfer.amount;
  }
  if (transfer.kind === KIND.serviceCost) {
    return transfer.source.type === COST ? -transfer.amount : transfer.amount;
  }
  if (transfer.kind === KIND.adjustment) {
    return transfer.destination.type === WRITEOFF_TYPE
      ? -transfer.amount
      : transfer.amount;
  }
  if (transfer.kind === KIND.modifier) {
    return transfer.destination.type === "modifier"
      ? transfer.amount
      : -transfer.amount;
  }
  return transfer.amount;
};

const isReversedAccount = (account: AccountRef): boolean =>
  account.type === ATTENDEE || account.type === COST;

/** Show attendee debts and servicing costs in the direction people expect. */
export const shownFigure = (value: number, account: AccountRef): number =>
  isReversedAccount(account) && value !== 0 ? -value : value;

/** The label for the final balance of one account kind. */
export const statementBalanceKey = (account: AccountRef): string =>
  account.type === ATTENDEE
    ? "admin.ledger.amount_owed"
    : account.type === COST
      ? "admin.ledger.total_costs"
      : account.type === REVENUE
        ? "admin.ledger.income_balance"
        : "admin.ledger.balance";
