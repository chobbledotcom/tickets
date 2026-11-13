/**
 * The modifier record: its table, its one write rule, and its admin surface.
 * The modifier pages read this declaration. `Modifier` is the stored row plus
 * the ledger-projected `total_revenue`. `ModifierRow` is what the table
 * writes.
 */

import {
  getAllModifiers,
  getModifier,
  type ModifierInput,
  type ModifierRow,
  modifierGroups,
  modifierListings,
  modifiersTable,
} from "#db/modifiers.ts";
import { childAddOnSaveError } from "#routes/admin/modifier-add-on-reachability.ts";
import { defineNamedRowRecord } from "#shared/rest/named-record.ts";
import type { RecordShapeOf } from "#shared/rest/record.ts";
import { ruleFromValidator } from "#shared/rest/record-command.ts";
import type { Modifier } from "#types";

/** Error when an active opt-in add-on can be reachable only through a
 * suppressed child. The stored links decide reachability. Neither an edit nor
 * a create changes them, so the check resolves against the current row's
 * links. */
const childAddOnInputError = async (
  input: ModifierInput,
  id: number | undefined,
): Promise<string | null> => {
  if (input.trigger !== "optional" || input.active !== true) return null;
  // Resolve from the stored links. An edit does not change them, and a
  // create has none. `resolveAddOnScope` keeps only the set matching the
  // input's scope.
  const [listingIds, groupIds] = await Promise.all([
    id === undefined ? [] : modifierListings.getIds(id),
    id === undefined ? [] : modifierGroups.getIds(id),
  ]);
  return childAddOnSaveError({
    active: true,
    groupIds,
    listingIds,
    name: input.name,
    scope: input.scope,
    trigger: "optional",
  });
};

/** The modifier field rule: a promo-code modifier needs a code, and an opt-in
 * add-on must stay reachable. `id` is the modifier being edited (absent on
 * create). The form refuses the whole-number field mistakes first. */
const validateModifier = (
  input: ModifierInput,
  id?: number,
): Promise<string | null> => {
  if (input.trigger === "code" && !input.code) {
    return Promise.resolve("A promo-code modifier needs a code");
  }
  // The form refuses a fraction for both whole-number fields, and its message
  // names the field. This record checks only the trigger rules below.
  const isOptionalAddOn = input.trigger === "optional";
  const requiresPreviousBookings = Number(input.minVisits) > 0;
  if (isOptionalAddOn && requiresPreviousBookings) {
    return Promise.resolve("Optional add-ons cannot require previous bookings");
  }
  return childAddOnInputError(input, id);
};

/** The one modifier rule: the trigger rules and the add-on reachability guard.
 * `stored` is the stored row on update and null on create. */
const modifierRule = ruleFromValidator<ModifierInput, ModifierRow>(
  validateModifier,
);

export const modifierRecord = defineNamedRowRecord<
  RecordShapeOf<ModifierRow, ModifierInput, Modifier, never, Modifier>
>({
  activityName: "Modifier",
  getAll: getAllModifiers,
  load: getModifier,
  nameLabel: "modifiers.name_label",
  rule: modifierRule,
  storedValues: (modifier) => modifier,
  surface: "modifiers",
  table: modifiersTable,
});
