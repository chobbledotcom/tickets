import type { ModifierInput, ModifierRow } from "#db/modifiers.ts";
import { insertModifier, insertModifierUsage } from "#test-utils/modifiers.ts";

/** The usage pair the aggregate tests recount: 5 total uses over 2 rows. */
const standingUsages = [
  { amountApplied: 500, attendeeId: 1, quantity: 3 },
  { amountApplied: 250, attendeeId: 2, quantity: 2 },
];

/**
 * Insert a modifier and the usage rows that drive its revenue and count
 * aggregates, so a test that recounts or backfills those aggregates starts
 * from the same shape.
 */
export const insertModifierWithUsages = async (
  overrides: Partial<ModifierInput>,
): Promise<ModifierRow> => {
  const modifier = await insertModifier(overrides);
  for (const usage of standingUsages) {
    await insertModifierUsage(
      modifier.id,
      usage.attendeeId,
      usage.quantity,
      usage.amountApplied,
    );
  }
  return modifier;
};
