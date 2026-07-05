/** A small success/error result for boundary parsing and action helpers. */
export type Result<T, E = string> =
  | { ok: true; value: T }
  | { ok: false; error: E };

export const okResult = <T>(value: T): Result<T, never> => ({
  ok: true,
  value,
});

export const errorResult = <E = string>(error: E): Result<never, E> => ({
  error,
  ok: false,
});
