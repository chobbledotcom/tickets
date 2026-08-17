import { isPositiveSafeInteger } from "#shared/validation/number.ts";

/** Refuse a refund command generation that cannot be stored exactly. */
export const requireRefundGeneration = (generation: number): void => {
  if (!isPositiveSafeInteger(generation)) {
    throw new Error("Refund generation must be a positive safe integer");
  }
};
