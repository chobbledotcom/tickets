/**
 * Owner-entered ledger entries.
 *
 * Normal checkout/refund code posts immutable business events through the ledger
 * mappers. This module is the deliberately narrow admin-maintenance surface: it
 * offers only human-scale entry types that make sense for one account at a time,
 * then maps each choice onto a concrete double-entry transfer.
 */

import * as v from "valibot";
import { WORLD, WRITEOFF } from "#accounting/accounts.ts";
import { eventGroup, legReference } from "#accounting/refs.ts";
import { fromDb, selectById } from "#accounting/rows.ts";
import { postTransfers } from "#accounting/store.ts";
import { execute, executeUpdate } from "#db/client.ts";
import type {
  AccountRef,
  Transfer,
  TransferInput,
} from "#shared/ledger/types.ts";
import { assertValidTransfer } from "#shared/ledger/validate.ts";
import { guardFor } from "#shared/validation/guard.ts";
import { instantToEpochMs } from "#shared/validation/timestamp.ts";

export const MANUAL_ATTENDEE_PAYMENT = "manual_attendee_payment";
export const MANUAL_ATTENDEE_CHARGE = "manual_attendee_charge";
export const MANUAL_ATTENDEE_WRITEOFF = "manual_attendee_writeoff";
export const MANUAL_LISTING_INCOME = "manual_listing_income";
export const MANUAL_LISTING_COST = "manual_listing_cost";
export const MANUAL_MODIFIER_INCOME = "manual_modifier_income";
export const MANUAL_MODIFIER_REDUCTION = "manual_modifier_reduction";

const MANUAL_LEDGER_REF_PREFIX = "manual-ledger-entry";

/**
 * The single source of truth for the owner-enterable entry types: the TS union,
 * the runtime guard, the options order, and the exhaustiveness of the spec
 * table below all derive from this one picklist.
 */
export const ManualLedgerEntryTypeSchema = v.picklist([
  MANUAL_ATTENDEE_PAYMENT,
  MANUAL_ATTENDEE_CHARGE,
  MANUAL_ATTENDEE_WRITEOFF,
  MANUAL_LISTING_INCOME,
  MANUAL_LISTING_COST,
  MANUAL_MODIFIER_INCOME,
  MANUAL_MODIFIER_REDUCTION,
]);

export type ManualLedgerEntryType = v.InferOutput<
  typeof ManualLedgerEntryTypeSchema
>;

const MANUAL_LEDGER_ENTRY_TYPES = ManualLedgerEntryTypeSchema.options;

export const isManualLedgerEntryType = guardFor(ManualLedgerEntryTypeSchema);

export type ManualLedgerEntryOption = {
  readonly type: ManualLedgerEntryType;
  readonly labelKey: string;
  readonly hintKey: string;
};

type TransferLegs = Pick<TransferInput, "source" | "destination">;

type ManualEntrySpec = {
  readonly accountType: string;
  readonly amountSign: 1 | -1;
  readonly eventKey: string;
  readonly labelKey: string;
  readonly hintKey: string;
  readonly descriptionKey: string;
  readonly legs: (account: AccountRef) => TransferLegs;
};

/** Money arriving into the chosen account from a fixed source (WORLD for new
 *  money, WRITEOFF for money the business forgives). */
const moneyInto =
  (source: AccountRef) =>
  (account: AccountRef): TransferLegs => ({ destination: account, source });

/** Money leaving the chosen account to a fixed destination (WORLD when it
 *  leaves the business, WRITEOFF when the business absorbs it). */
const moneyOutOf =
  (destination: AccountRef) =>
  (account: AccountRef): TransferLegs => ({ destination, source: account });

/**
 * One spec per entry type, keyed by the picklist so the Record is exhaustive by
 * construction — a new entry type is a compile error here, never a silent
 * `undefined` lookup (the previous array + `as Record` cast tolerated a
 * forgotten spec).
 */
export const manualEntrySpecByType: Record<
  ManualLedgerEntryType,
  ManualEntrySpec
> = {
  [MANUAL_ATTENDEE_PAYMENT]: {
    accountType: "attendee",
    amountSign: 1,
    descriptionKey: "admin.ledger.human.manual_attendee_payment",
    eventKey: "admin.ledger.event.manual_attendee_payment",
    hintKey: "admin.ledger.add.option.attendee_payment.hint",
    labelKey: "admin.ledger.add.option.attendee_payment.label",
    legs: moneyInto(WORLD),
  },
  [MANUAL_ATTENDEE_CHARGE]: {
    accountType: "attendee",
    amountSign: 1,
    descriptionKey: "admin.ledger.human.manual_attendee_charge",
    eventKey: "admin.ledger.event.manual_attendee_charge",
    hintKey: "admin.ledger.add.option.attendee_charge.hint",
    labelKey: "admin.ledger.add.option.attendee_charge.label",
    legs: moneyOutOf(WRITEOFF),
  },
  [MANUAL_ATTENDEE_WRITEOFF]: {
    accountType: "attendee",
    amountSign: -1,
    descriptionKey: "admin.ledger.human.manual_attendee_writeoff",
    eventKey: "admin.ledger.event.manual_attendee_writeoff",
    hintKey: "admin.ledger.add.option.attendee_writeoff.hint",
    labelKey: "admin.ledger.add.option.attendee_writeoff.label",
    legs: moneyInto(WRITEOFF),
  },
  [MANUAL_LISTING_INCOME]: {
    accountType: "revenue",
    amountSign: 1,
    descriptionKey: "admin.ledger.human.manual_listing_income",
    eventKey: "admin.ledger.event.manual_listing_income",
    hintKey: "admin.ledger.add.option.listing_income.hint",
    labelKey: "admin.ledger.add.option.listing_income.label",
    legs: moneyInto(WORLD),
  },
  [MANUAL_LISTING_COST]: {
    accountType: "revenue",
    amountSign: -1,
    descriptionKey: "admin.ledger.human.manual_listing_cost",
    eventKey: "admin.ledger.event.manual_listing_cost",
    hintKey: "admin.ledger.add.option.listing_cost.hint",
    labelKey: "admin.ledger.add.option.listing_cost.label",
    legs: moneyOutOf(WORLD),
  },
  [MANUAL_MODIFIER_INCOME]: {
    accountType: "modifier",
    amountSign: 1,
    descriptionKey: "admin.ledger.human.manual_modifier_income",
    eventKey: "admin.ledger.event.manual_modifier_income",
    hintKey: "admin.ledger.add.option.modifier_income.hint",
    labelKey: "admin.ledger.add.option.modifier_income.label",
    legs: moneyInto(WRITEOFF),
  },
  [MANUAL_MODIFIER_REDUCTION]: {
    accountType: "modifier",
    amountSign: -1,
    descriptionKey: "admin.ledger.human.manual_modifier_reduction",
    eventKey: "admin.ledger.event.manual_modifier_reduction",
    hintKey: "admin.ledger.add.option.modifier_reduction.hint",
    labelKey: "admin.ledger.add.option.modifier_reduction.label",
    legs: moneyOutOf(WRITEOFF),
  },
};

export const manualLedgerEntryOptionsFor = (
  account: AccountRef,
): ManualLedgerEntryOption[] =>
  MANUAL_LEDGER_ENTRY_TYPES.filter(
    (type) => manualEntrySpecByType[type].accountType === account.type,
  ).map((type) => {
    const { hintKey, labelKey } = manualEntrySpecByType[type];
    return { hintKey, labelKey, type };
  });

export const isManualLedgerTransfer = (
  transfer: Pick<Transfer, "kind">,
): boolean =>
  transfer.kind !== undefined && isManualLedgerEntryType(transfer.kind);

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
  const spec = manualEntrySpecByType[type];
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

/**
 * The ledger is append-only except for owner-entered rows, and this module IS
 * the narrow maintenance surface — so the mutators below enforce that boundary
 * themselves rather than trusting every caller to pre-filter. A transfer's
 * `kind` is immutable (only amount/time are ever updated), so checking the
 * loaded row cannot race a concurrent change.
 */
const assertManualLedgerTransfer = (transfer: Transfer): void => {
  if (isManualLedgerTransfer(transfer)) return;
  const kind = transfer.kind ?? "";
  const detail = `transfer ${transfer.id} is not an owner-entered ledger entry (kind "${kind}")`;
  throw new Error(detail);
};

/** Update an owner-entered entry's amount and business time. Throws on any
 *  other kind of transfer — checkout/refund history is never edited. */
export const updateManualLedgerEntry = async (
  transfer: Transfer,
  amount: number,
  occurredAt: string,
): Promise<void> => {
  assertManualLedgerTransfer(transfer);
  const next: TransferInput = { ...transfer, amount, occurredAt };
  assertValidTransfer(next, "invalid transfer update");
  await executeUpdate(
    "transfers",
    { amount, occurred_at: instantToEpochMs(occurredAt) },
    { id: transfer.id },
  );
};

/** Delete an owner-entered entry. Throws on any other kind of transfer —
 *  checkout/refund history is never deleted. */
export const deleteManualLedgerEntry = async (
  transfer: Transfer,
): Promise<void> => {
  assertManualLedgerTransfer(transfer);
  await execute("DELETE FROM transfers WHERE id = ?", [transfer.id]);
};
