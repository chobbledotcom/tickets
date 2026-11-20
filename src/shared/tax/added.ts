// effects: pure
import type { TaxState } from "#shared/tax/transitions.ts";

/** The part of a saved assessment record that this reader needs. */
type SavedAssessment = { bookingGroup: string; state: TaxState };

/**
 * The tax that each booking order adds on top of its listed prices, keyed by
 * the order's event group. An order counts only while its latest saved
 * assessment is active and adds tax to the total. A listed price that already
 * holds its tax adds nothing, and a refunded order has no tax left to show.
 * The records arrive oldest revision first, so the last one for an order wins.
 */
export const addedTaxByOrder = (
  stored: readonly SavedAssessment[],
): Map<string, number> => {
  const latest = new Map(stored.map((record) => [record.bookingGroup, record]));
  const added = new Map<string, number>();
  for (const [order, { state }] of latest) {
    if (
      state.kind === "active" &&
      state.assessment.policy.mode === "add_to_total"
    )
      added.set(order, state.assessment.taxAmount);
  }
  return added;
};
