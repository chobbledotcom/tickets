export const thrownError = (run: () => unknown): Error => {
  try {
    run();
  } catch (error) {
    if (error instanceof Error) return error;
    throw new Error("Expected an Error object");
  }
  throw new Error("Expected function to throw");
};

export const rejectedError = async (
  value: Promise<unknown>,
): Promise<Error> => {
  try {
    await value;
  } catch (error) {
    if (error instanceof Error) return error;
    throw new Error("Expected an Error object");
  }
  throw new Error("Expected promise to reject");
};
