type WriteResult<T> = { value: T };

/** Retry a revision-fenced write when another writer wins the race. */
export const retryWrite = async <T>(
  failure: string,
  write: () => Promise<WriteResult<T> | null>,
): Promise<T> => {
  for (let attempt = 0; attempt < 4; attempt++) {
    const result = await write();
    if (result !== null) return result.value;
  }
  throw new Error(failure);
};
