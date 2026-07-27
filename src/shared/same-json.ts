/** Compare values whose stored contract is their exact JSON representation. */
export const sameJson = (left: unknown, right: unknown): boolean =>
  JSON.stringify(left) === JSON.stringify(right);
