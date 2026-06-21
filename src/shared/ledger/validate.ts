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
 * Validate a {@link TransferInput}. Returns `ok` with the value, or every reason
 * it was rejected (so the caller sees all problems at once, not just the first).
 *
 * Enforced invariants: amount is a positive integer; source and destination
 * differ; account parts are non-empty and free of the reserved key separator;
 * currency, reference, and eventGroup are non-empty.
 */
export const validateTransfer = (t: TransferInput): Result<TransferInput> => {
  const errors: LedgerError[] = compact([
    t.amount <= 0 ? ({ code: "non_positive_amount" } as const) : null,
    Number.isInteger(t.amount)
      ? null
      : ({ code: "non_integer_amount" } as const),
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
