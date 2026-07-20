/** The shared success/error contract for operations that return one value. */
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

/** Parse a value when present, or return a successful undefined value. */
export const parseOptionalResult = <T>(
  value: unknown,
  parse: (value: unknown) => Result<T>,
): Result<T | undefined> =>
  value === undefined ? okResult(undefined) : parse(value);

const objectErrorMessage = (error: object): string | null => {
  const values = error as Record<string, unknown>;
  const message = values.message ?? values.code;
  return typeof message === "string" && message ? message : null;
};

const errorMessage = (error: unknown): string | null => {
  if (typeof error === "string") return error || null;
  if (error instanceof Error) return error.message || error.name;
  if (Array.isArray(error)) {
    const messages = error.map(errorMessage);
    return messages.length > 0 && messages.every((message) => message !== null)
      ? messages.join(", ")
      : null;
  }
  return error && typeof error === "object" ? objectErrorMessage(error) : null;
};

/** Return a successful value, or throw the failed result's useful message. */
export const requireSuccess = <T, E>(
  result: Result<T, E>,
  context?: string,
): T => {
  if (result.ok) return result.value;
  const message = errorMessage(result.error);
  if (message === null) throw new Error("Failed result is missing an error");
  throw new Error(context ? `${context}: ${message}` : message);
};
