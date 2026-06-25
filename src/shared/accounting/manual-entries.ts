/**
 * Owner-entered ledger entries.
 *
 * Normal checkout/refund code posts immutable business events through the ledger
 * mappers. This module is the deliberately narrow admin-maintenance surface: it
 * offers only human-scale entry types that make sense for one account at a time,
 * then maps each choice onto a concrete double-entry transfer.
 */

import { WORLD, WRITEOFF } from "#shared/accounting/accounts.ts";
import { eventGroup, legReference } from "#shared/accounting/refs.ts";
import { fromDb, selectById } from "#shared/accounting/rows.ts";
import { postTransfers } from "#shared/accounting/store.ts";
import { execute } from "#shared/db/client.ts";
import type {
  AccountRef,
  Transfer,
  TransferInput,
} from "#shared/ledger/types.ts";
import { validateTransfer } from "#shared/ledger/validate.ts";
import { instantToEpochMs } from "#shared/validation/timestamp.ts";

export const MANUAL_ATTENDEE_PAYMENT = "manual_attendee_payment";
export const MANUAL_ATTENDEE_CHARGE = "manual_attendee_charge";
export const MANUAL_ATTENDEE_WRITEOFF = "manual_attendee_writeoff";
export const MANUAL_LISTING_INCOME = "manual_listing_income";
export const MANUAL_LISTING_COST = "manual_listing_cost";
export const MANUAL_MODIFIER_INCOME = "manual_modifier_income";
export const MANUAL_MODIFIER_REDUCTION = "manual_modifier_reduction";

const MANUAL_LEDGER_REF_PREFIX = "manual-ledger-entry";

export type ManualLedgerEntryType =
  | typeof MANUAL_ATTENDEE_PAYMENT
  | typeof MANUAL_ATTENDEE_CHARGE
  | typeof MANUAL_ATTENDEE_WRITEOFF
  | typeof MANUAL_LISTING_INCOME
  | typeof MANUAL_LISTING_COST
  | typeof MANUAL_MODIFIER_INCOME
  | typeof MANUAL_MODIFIER_REDUCTION;

export type ManualLedgerEntryOption = {
  readonly type: ManualLedgerEntryType;
  readonly labelKey: string;
  readonly hintKey: string;
};

type ManualEntrySpec = ManualLedgerEntryOption & {
  readonly accountType: string;
  readonly legs: (
    account: AccountRef,
  ) => Pick<TransferInput, "source" | "destination">;
};

const manualSpecs: readonly ManualEntrySpec[] = [
  {
    accountType: "attendee",
    hintKey: "admin.ledger.add.option.attendee_payment.hint",
    labelKey: "admin.ledger.add.option.attendee_payment.label",
    legs: (account) => ({ destination: account, source: WORLD }),
    type: MANUAL_ATTENDEE_PAYMENT,
  },
  {
    accountType: "attendee",
    hintKey: "admin.ledger.add.option.attendee_charge.hint",
    labelKey: "admin.ledger.add.option.attendee_charge.label",
    legs: (account) => ({ destination: WRITEOFF, source: account }),
    type: MANUAL_ATTENDEE_CHARGE,
  },
  {
    accountType: "attendee",
    hintKey: "admin.ledger.add.option.attendee_writeoff.hint",
    labelKey: "admin.ledger.add.option.attendee_writeoff.label",
    legs: (account) => ({ destination: account, source: WRITEOFF }),
    type: MANUAL_ATTENDEE_WRITEOFF,
  },
  {
    accountType: "revenue",
    hintKey: "admin.ledger.add.option.listing_income.hint",
    labelKey: "admin.ledger.add.option.listing_income.label",
    legs: (account) => ({ destination: account, source: WORLD }),
    type: MANUAL_LISTING_INCOME,
  },
  {
    accountType: "revenue",
    hintKey: "admin.ledger.add.option.listing_cost.hint",
    labelKey: "admin.ledger.add.option.listing_cost.label",
    legs: (account) => ({ destination: WORLD, source: account }),
    type: MANUAL_LISTING_COST,
  },
  {
    accountType: "modifier",
    hintKey: "admin.ledger.add.option.modifier_income.hint",
    labelKey: "admin.ledger.add.option.modifier_income.label",
    legs: (account) => ({ destination: account, source: WRITEOFF }),
    type: MANUAL_MODIFIER_INCOME,
  },
  {
    accountType: "modifier",
    hintKey: "admin.ledger.add.option.modifier_reduction.hint",
    labelKey: "admin.ledger.add.option.modifier_reduction.label",
    legs: (account) => ({ destination: WRITEOFF, source: account }),
    type: MANUAL_MODIFIER_REDUCTION,
  },
];

const specByType = Object.fromEntries(
  manualSpecs.map((spec) => [spec.type, spec]),
) as Record<ManualLedgerEntryType, ManualEntrySpec>;

export const manualLedgerEntryOptionsFor = (
  account: AccountRef,
): ManualLedgerEntryOption[] =>
  manualSpecs
    .filter((spec) => spec.accountType === account.type)
    .map(({ hintKey, labelKey, type }) => ({ hintKey, labelKey, type }));

export const isManualLedgerEntryType = (
  value: string,
): value is ManualLedgerEntryType => Object.hasOwn(specByType, value);

type ManualLedgerEntryInput = {
  account: AccountRef;
  amount: number;
  occurredAt: string;
  postedBy: string;
  type: ManualLedgerEntryType;
};

const buildManualTransferInput = async ({
  account,
  amount,
  occurredAt,
  postedBy,
  type,
}: ManualLedgerEntryInput): Promise<TransferInput> => {
  const spec = specByType[type];
  if (spec.accountType !== account.type) {
    throw new Error(
      `Manual ledger entry type ${type} is not valid for ${account.type}`,
    );
  }
  const nonce = crypto.randomUUID();
  const parts = [
    MANUAL_LEDGER_REF_PREFIX,
    type,
    account.type,
    account.id,
    nonce,
  ];
  return {
    ...spec.legs(account),
    amount,
    eventGroup: await eventGroup(parts),
    kind: type,
    occurredAt,
    postedBy,
    reference: await legReference([...parts, "transfer"]),
  };
};

export const postManualLedgerEntry = async (
  input: ManualLedgerEntryInput,
): Promise<void> => {
  await postTransfers([await buildManualTransferInput(input)]);
};

export const getTransferById = (id: number): Promise<Transfer | null> =>
  selectById(fromDb, id);

export const updateTransferAmountAndTime = async (
  transfer: Transfer,
  amount: number,
  occurredAt: string,
): Promise<void> => {
  const next: TransferInput = { ...transfer, amount, occurredAt };
  const validation = validateTransfer(next);
  if (!validation.ok) {
    throw new Error(
      `invalid transfer update: ${validation.errors.map((e) => e.code).join(", ")}`,
    );
  }
  await execute(
    "UPDATE transfers SET amount = ?, occurred_at = ? WHERE id = ?",
    [amount, instantToEpochMs(occurredAt), transfer.id],
  );
};

export const deleteTransferById = async (id: number): Promise<void> => {
  await execute("DELETE FROM transfers WHERE id = ?", [id]);
};
