import { range } from "#fp";

type WriteResult<T> = { value: T };

/** Retry a revision-fenced write when another writer wins the race. */
export const retryWrite = async <T>(
  failure: string,
  write: () => Promise<WriteResult<T> | null>,
): Promise<T> => {
  for (const _attempt of range(0, 4)) {
    const result = await write();
    if (result !== null) return result.value;
  }
  throw new Error(failure);
};
