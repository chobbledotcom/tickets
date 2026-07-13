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

/** A failed outcome on its own — the `{ ok: false }` half of the ad-hoc result
 * unions that carry their success payload inline rather than in a `value` (the
 * builder's connection test, the aggregate-form parser, …). */
export type Failure = { ok: false; error: string };

/** Build a {@link Failure} from its error message. */
export const failure = (error: string): Failure => ({ error, ok: false });
