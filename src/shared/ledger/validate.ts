/**
 * Pure validation of a transfer before it is posted.
 *
 * Deliberately not a valibot schema (see AGENTS.md "Deliberate non-use is fine
 * when the platform is better"): the callers' contract is the typed
 * {@link LedgerError} code union — exhaustive, comparable, and rendered into
 * conflict/store errors by code — which hand-built checks express directly,
 * where a valibot pipe would collect anonymous issues that then need mapping
 * back onto these exact codes.
 */

import { compact } from "#fp";
import { type Result, requireSuccess } from "#shared/result.ts";
import { isInstant } from "#shared/validation/timestamp.ts";
import { ACCOUNT_KEY_SEPARATOR, sameAccount } from "./account.ts";
import type { AccountRef, LedgerError, TransferInput } from "./types.ts";

const isEmptyAccount = (a: AccountRef): boolean => !a.type || !a.id;

const hasReservedChar = (a: AccountRef): boolean =>
  a.type.includes(ACCOUNT_KEY_SEPARATOR) ||
  a.id.includes(ACCOUNT_KEY_SEPARATOR);

/** A reversal link, when present, must be a real transfer row id — a positive
 *  safe integer. A fractional or unsafe value would occupy a different slot in
 *  the unique `reverses_id` index than the original id, defeating the
 *  one-void-per-original guard. */
const hasInvalidReversesId = (t: TransferInput): boolean =>
  t.reversesId !== undefined &&
  (!Number.isSafeInteger(t.reversesId) || t.reversesId <= 0);

type TransferCheck = (transfer: TransferInput) => LedgerError | null;

/** Every transfer rule in the order its error is reported. Each rule owns one
 * error code, so adding a rule cannot change the validation control flow. */
const transferChecks: readonly TransferCheck[] = [
  (t) => (t.amount <= 0 ? { code: "non_positive_amount" } : null),
  (t) => (Number.isInteger(t.amount) ? null : { code: "non_integer_amount" }),
  (t) =>
    Number.isInteger(t.amount) && !Number.isSafeInteger(t.amount)
      ? { code: "unsafe_amount" }
      : null,
  (t) => (isInstant(t.occurredAt) ? null : { code: "invalid_occurred_at" }),
  (t) => (hasInvalidReversesId(t) ? { code: "invalid_reverses_id" } : null),
  (t) =>
    sameAccount(t.source, t.destination) ? { code: "self_transfer" } : null,
  (t) =>
    isEmptyAccount(t.source) || isEmptyAccount(t.destination)
      ? { code: "empty_account" }
      : null,
  (t) =>
    hasReservedChar(t.source) || hasReservedChar(t.destination)
      ? { code: "reserved_char_in_account" }
      : null,
  (t) => (t.reference ? null : { code: "empty_reference" }),
  (t) => (t.eventGroup ? null : { code: "empty_event_group" }),
];

/**
 * Validate a {@link TransferInput}. Returns `ok` with the value, or every reason
 * it was rejected (so the caller sees all problems at once, not just the first).
 *
 * Enforced invariants: amount is a positive, safe integer (so summing balances
 * as JS numbers can't lose pennies); source and destination differ; account
 * parts are non-empty and free of the reserved key separator; occurredAt is a
 * real ISO-8601 instant ({@link isInstant} — any offset/precision, but not an
 * impossible date like Feb 30, normalised to canonical epoch-millis on write);
 * a reversesId, if present, is a positive safe integer; reference and eventGroup
 * are non-empty. (Currency is not a ledger concern: a site has one currency,
 * fixed at setup, so every transfer shares it.)
 */
export const validateTransfer = (
  t: TransferInput,
): Result<TransferInput, LedgerError[]> => {
  const errors = compact(transferChecks.map((check) => check(t)));
  return errors.length > 0
    ? { error: errors, ok: false }
    : { ok: true, value: t };
};

/**
 * Validate a transfer and throw when it is rejected, naming every error code —
 * the shared boundary guard for write paths that have no structured-error
 * channel (the store's pre-post checks, a manual entry's amount/time update).
 * `context` prefixes the message so the failing operation is identifiable.
 */
export const assertValidTransfer = (
  t: TransferInput,
  context: string,
): void => {
  requireSuccess(validateTransfer(t), context);
};
