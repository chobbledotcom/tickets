/** Recover one expected error shape and let every other error propagate. */
export const recoverError = async <Result>(
  work: () => Promise<Result>,
  recover: (error: unknown) => Result,
): Promise<Result> => {
  try {
    return await work();
  } catch (error) {
    return recover(error);
  }
};
