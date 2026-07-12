/** The parsed span of a submitted order that several stages pass along: the
 * per-listing quantities, the chosen date (or null), the booked day count, and
 * whether any line is priced by that day count. Both the child-fold input and
 * the completion paths build on these same facts. */
export type OrderSpan = {
  quantities: Map<number, number>;
  date: string | null;
  dayCount: number;
  hasCustomisable: boolean;
};
