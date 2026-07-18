/** A small success/error result for boundary parsing and action helpers. */
export type Result<T, E = string> =
  | { ok: true; value: T }
  | { ok: false; error: E };

export const okResult = <T>(value: T): Result<T, never> => ({
  ok: true,
  value,
});

export const errorResult = <E = string>(error: E): { error: E; ok: false } => ({
  error,
  ok: false,
});

/** Throw a failed boundary result and narrow successful results for the caller. */
export function requireSuccess<T extends { ok: boolean }>(
  result: T,
): asserts result is T & { ok: true };
export function requireSuccess(
  result: { ok: true } | { error: string; ok: false },
): void {
  if (!result.ok) throw new Error(result.error);
}
