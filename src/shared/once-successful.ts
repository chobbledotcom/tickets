/** Share one in-flight async result, but allow a later call to retry a failure. */
export const onceSuccessful = <T>(fn: () => Promise<T>): (() => Promise<T>) => {
  let pending: Promise<T> | null = null;
  return (): Promise<T> => {
    const current = pending === null ? fn() : pending;
    pending = current;
    current.catch(() => {
      pending = null;
    });
    return current;
  };
};
