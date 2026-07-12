import { t } from "#i18n";
import {
  ATTENDEE,
  COST,
  EXTERNAL,
  FEE_INCOME,
  isRowAccountType,
  isSingletonAccountType,
  MODIFIER,
  REVENUE,
  type RowAccountType,
  type SingletonAccountType,
  WRITEOFF_TYPE,
} from "#shared/accounting/accounts.ts";
import {
  isTransferKind,
  KIND,
  type TransferKind,
} from "#shared/accounting/kinds.ts";
import {
  isManualLedgerEntryType,
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
      {t(key)} {accountCell(account)}.
    </>
  ) : (
    <span>{t(key)}.</span>
  );

/** A sentence naming both accounts: optional lead-in words, then the money's
 * source, the joining words, and its destination. */
const linkedAccountsDescription =
  (leadKey: string | null, joinKey: string): DescriptionRule =>
  (transfer, accountCell) => (
    <>
      {leadKey === null ? "" : `${t(leadKey)} `}
      {accountCell(transfer.source)} {t(joinKey)}{" "}
      {accountCell(transfer.destination)}.
    </>
  );

const fallbackHumanDescription: DescriptionRule = linkedAccountsDescription(
  "admin.ledger.human.money_from",
  "admin.ledger.human.money_to",
);

const saleDescription: DescriptionRule = linkedAccountsDescription(
  null,
  "admin.ledger.human.booked",
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

type DescriptionRule = (
  transfer: Transfer,
  accountCell: AccountCell,
) => JSX.Element;

type AmountRule = (transfer: Transfer) => number;

type TransferPresentation = {
  readonly amount: AmountRule;
  readonly description: DescriptionRule;
  readonly eventKey: string;
};

const positiveAmount: AmountRule = (transfer) => transfer.amount;
const negativeAmount: AmountRule = (transfer) => -transfer.amount;

const textDescription =
  (key: string): DescriptionRule =>
  () => <>{t(key)}</>;

const accountDescription =
  (key: string, accountType: string): DescriptionRule =>
  (transfer, accountCell) =>
    sentenceWithAccount(key, humanAccount(transfer, accountType), accountCell);

const serviceCostDescription: DescriptionRule = (transfer, accountCell) =>
  sentenceWithAccount(
    transfer.source.type === COST
      ? "admin.ledger.human.service_cost"
      : "admin.ledger.human.service_cost_reduction",
    humanAccount(transfer, COST),
    accountCell,
  );

const serviceCostAmount: AmountRule = (transfer) =>
  transfer.source.type === COST ? -transfer.amount : transfer.amount;

const adjustmentAmount: AmountRule = (transfer) => {
  if (transfer.source.type === ATTENDEE) return transfer.amount;
  if (transfer.destination.type === ATTENDEE) return -transfer.amount;
  return transfer.destination.type === WRITEOFF_TYPE
    ? -transfer.amount
    : transfer.amount;
};

const modifierDescription: DescriptionRule = (transfer, accountCell) =>
  sentenceWithAccount(
    transfer.destination.type === MODIFIER
      ? "admin.ledger.human.modifier_increase"
      : "admin.ledger.human.modifier_reduce",
    humanAccount(transfer, MODIFIER),
    accountCell,
  );

const modifierAmount: AmountRule = (transfer) =>
  transfer.destination.type === MODIFIER ? transfer.amount : -transfer.amount;

/**
 * Every application-owned event chooses its detailed label, simple description,
 * and displayed amount together. Adding a KIND member cannot update only one.
 */
const TRANSFER_PRESENTATION: Record<TransferKind, TransferPresentation> = {
  [KIND.adjustment]: {
    amount: adjustmentAmount,
    description: adjustmentDescription,
    eventKey: "admin.ledger.event.adjustment",
  },
  [KIND.fee]: {
    amount: positiveAmount,
    description: textDescription("admin.ledger.human.fee"),
    eventKey: "admin.ledger.event.fee",
  },
  [KIND.modifier]: {
    amount: modifierAmount,
    description: modifierDescription,
    eventKey: "admin.ledger.event.modifier",
  },
  [KIND.payment]: {
    amount: positiveAmount,
    description: accountDescription("admin.ledger.human.payment", ATTENDEE),
    eventKey: "admin.ledger.event.payment",
  },
  [KIND.refundCash]: {
    amount: negativeAmount,
    description: accountDescription("admin.ledger.human.refund_cash", ATTENDEE),
    eventKey: "admin.ledger.event.refund_cash",
  },
  [KIND.refundFee]: {
    amount: negativeAmount,
    description: textDescription("admin.ledger.human.refund_fee"),
    eventKey: "admin.ledger.event.refund_fee",
  },
  [KIND.refundModifier]: {
    amount: modifierAmount,
    description: modifierDescription,
    eventKey: "admin.ledger.event.refund_modifier",
  },
  [KIND.refundSale]: {
    amount: negativeAmount,
    description: accountDescription("admin.ledger.human.refund_sale", REVENUE),
    eventKey: "admin.ledger.event.refund_sale",
  },
  [KIND.reversal]: {
    amount: positiveAmount,
    description: fallbackHumanDescription,
    eventKey: "admin.ledger.event.reversal",
  },
  [KIND.sale]: {
    amount: positiveAmount,
    description: saleDescription,
    eventKey: "admin.ledger.event.sale",
  },
  [KIND.serviceCost]: {
    amount: serviceCostAmount,
    description: serviceCostDescription,
    eventKey: "admin.ledger.event.service_cost",
  },
};

const presentationFor = (transfer: Transfer): TransferPresentation => {
  const { kind } = transfer;
  if (kind !== undefined && isTransferKind(kind)) {
    return TRANSFER_PRESENTATION[kind];
  }
  if (kind !== undefined && isManualLedgerEntryType(kind)) {
    const spec = manualEntrySpecByType[kind];
    return {
      amount: (row) => spec.amountSign * row.amount,
      description: accountDescription(spec.descriptionKey, spec.accountType),
      eventKey: spec.eventKey,
    };
  }
  return {
    amount: positiveAmount,
    description: fallbackHumanDescription,
    // Stored kinds are opaque. An unknown value must never become user copy.
    eventKey: kind ? "admin.ledger.event.unknown" : "admin.ledger.event.none",
  };
};

export const transferEventLabel = (transfer: Transfer): string =>
  t(presentationFor(transfer).eventKey);

export const humanDescription = (
  transfer: Transfer,
  accountCell: AccountCell,
): JSX.Element => presentationFor(transfer).description(transfer, accountCell);

/** How one simple-view row changed the business figure it describes. */
export const humanAmount = (transfer: Transfer): number =>
  presentationFor(transfer).amount(transfer);

const isReversedAccount = (account: AccountRef): boolean =>
  account.type === ATTENDEE || account.type === COST;

/** Show attendee debts and servicing costs in the direction people expect. */
export const shownFigure = (value: number, account: AccountRef): number =>
  isReversedAccount(account) && value !== 0 ? -value : value;

/** The label for the final balance of one account kind. */
type StatementAccountType = RowAccountType | SingletonAccountType;

const STATEMENT_BALANCE_KEYS: Record<StatementAccountType, string> = {
  [ATTENDEE]: "admin.ledger.amount_owed",
  [COST]: "admin.ledger.total_costs",
  [EXTERNAL]: "admin.ledger.balance",
  [FEE_INCOME]: "admin.ledger.balance",
  [MODIFIER]: "admin.ledger.balance",
  [REVENUE]: "admin.ledger.income_balance",
  [WRITEOFF_TYPE]: "admin.ledger.balance",
};

const isStatementAccountType = (type: string): type is StatementAccountType =>
  isRowAccountType(type) || isSingletonAccountType(type);

export const statementBalanceKey = (account: AccountRef): string =>
  isStatementAccountType(account.type)
    ? STATEMENT_BALANCE_KEYS[account.type]
    : "admin.ledger.balance";
