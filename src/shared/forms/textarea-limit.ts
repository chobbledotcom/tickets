// effects: pure
/** A textarea length check: a message naming the field when it is too long.
 *
 *  The limit is an argument, so this module stays pure. The caller owns the
 *  setting that holds the configured maximum. */
export const maxTextareaValidator =
  (maximum: number, fieldLabel: string) =>
  (value: string): string | null =>
    value.length > maximum
      ? `${fieldLabel} must be ${maximum} characters or fewer (currently ${value.length})`
      : null;
