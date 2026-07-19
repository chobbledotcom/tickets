/** Return a required value or fail with its domain-specific error. */
export const requireValue = <T>(
  value: T | null | undefined,
  message: string,
): T => {
  if (value == null) throw new Error(message);
  return value;
};
