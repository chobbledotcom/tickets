/** Pure validation of a transfer before it is posted. */

import { compact } from "#fp";
import { isInstant } from "#shared/validation/timestamp.ts";
import { ACCOUNT_KEY_SEPARATOR, sameAccount } from "./account.ts";
import type {
  AccountRef,
  LedgerError,
  Result,
  TransferInput,
} from "./types.ts";

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
export const validateTransfer = (t: TransferInput): Result<TransferInput> => {
  const errors: LedgerError[] = compact([
    t.amount <= 0 ? ({ code: "non_positive_amount" } as const) : null,
    Number.isInteger(t.amount)
      ? null
      : ({ code: "non_integer_amount" } as const),
    Number.isInteger(t.amount) && !Number.isSafeInteger(t.amount)
      ? ({ code: "unsafe_amount" } as const)
      : null,
    isInstant(t.occurredAt) ? null : ({ code: "invalid_occurred_at" } as const),
    hasInvalidReversesId(t) ? ({ code: "invalid_reverses_id" } as const) : null,
    sameAccount(t.source, t.destination)
      ? ({ code: "self_transfer" } as const)
      : null,
    isEmptyAccount(t.source) || isEmptyAccount(t.destination)
      ? ({ code: "empty_account" } as const)
      : null,
    hasReservedChar(t.source) || hasReservedChar(t.destination)
      ? ({ code: "reserved_char_in_account" } as const)
      : null,
    t.reference ? null : ({ code: "empty_reference" } as const),
    t.eventGroup ? null : ({ code: "empty_event_group" } as const),
  ]);
  return errors.length > 0 ? { errors, ok: false } : { ok: true, value: t };
};
