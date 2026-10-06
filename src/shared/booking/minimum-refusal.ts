import { quantityBelowMinimum } from "#booking/model.ts";

/** The below-minimum error for one submitted quantity: the caller's message
 *  when the quantity refuses the stored minimum, else null. Each surface
 *  names its own copy and shapes its own failure object around it. */
export const belowMinimumError = (
  quantity: number,
  minimum: number,
  error: string,
): string | null => (quantityBelowMinimum(quantity, minimum) ? error : null);
