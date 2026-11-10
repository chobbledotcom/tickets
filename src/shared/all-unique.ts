/** Whether every value appears once, the guard a declared key list needs. */
export const allUnique = <T>(values: readonly T[]): boolean =>
  new Set(values).size === values.length;
