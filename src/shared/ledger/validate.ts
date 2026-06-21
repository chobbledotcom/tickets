/** Pure validation of a transfer before it is posted. */

import { compact } from "#fp";
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

/**
 * True only for a canonical ISO-8601 UTC timestamp in the exact form
 * `YYYY-MM-DDTHH:mm:ss.sssZ`. Round-tripping through `Date` rejects impossible
 * dates that V8 silently normalises (`2026-02-30`, hour `24`, …) and pins one
 * fixed-width precision, so the lexicographic comparison used by `statementFor`
 * and `inPeriod` always matches chronological order.
 */
const isIsoTimestamp = (s: string): boolean => {
  const date = new Date(s);
  return !Number.isNaN(date.getTime()) && date.toISOString() === s;
};

/**
 * Validate a {@link TransferInput}. Returns `ok` with the value, or every reason
 * it was rejected (so the caller sees all problems at once, not just the first).
 *
 * Enforced invariants: amount is a positive, safe integer (so summing balances
 * as JS numbers can't lose pennies); source and destination differ; account
 * parts are non-empty and free of the reserved key separator; occurredAt is a
 * valid ISO-8601 UTC timestamp; currency, reference, and eventGroup are
 * non-empty.
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
    isIsoTimestamp(t.occurredAt)
      ? null
      : ({ code: "invalid_occurred_at" } as const),
    sameAccount(t.source, t.destination)
      ? ({ code: "self_transfer" } as const)
      : null,
    isEmptyAccount(t.source) || isEmptyAccount(t.destination)
      ? ({ code: "empty_account" } as const)
      : null,
    hasReservedChar(t.source) || hasReservedChar(t.destination)
      ? ({ code: "reserved_char_in_account" } as const)
      : null,
    t.currency ? null : ({ code: "empty_currency" } as const),
    t.reference ? null : ({ code: "empty_reference" } as const),
    t.eventGroup ? null : ({ code: "empty_event_group" } as const),
  ]);
  return errors.length > 0 ? { errors, ok: false } : { ok: true, value: t };
};
