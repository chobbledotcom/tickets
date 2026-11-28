// effects: pure

import { errorResult, okResult, type Result } from "#shared/result.ts";

/** Trim a name and refuse a blank one or one longer than its limit. */
export const checkedName = <Error>(
  value: string,
  emptyError: Error,
  max: { error: Error; length: number },
): Result<string, Error> => {
  const name = value.trim();
  if (name === "") return errorResult(emptyError);
  if (name.length > max.length) return errorResult(max.error);
  return okResult(name);
};
