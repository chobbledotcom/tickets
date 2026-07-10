/**
 * Pure value builders for the modifier pages: the human-readable rule summary
 * and the form-field value maps. No JSX — data in, data out.
 */

import { t } from "#i18n";
import { toMajorUnits } from "#shared/currency.ts";
import {
  booleanToCheckbox,
  entityToFieldValues,
  type Field,
} from "#shared/forms.tsx";
import type { Modifier } from "#shared/types.ts";
import { getModifierFields } from "#templates/fields/modifier.ts";

/** Human-readable summary of a modifier's rule, e.g. "Discount · 10%". */
export const ruleSummary = (m: Modifier): string => {
  const value = String(m.calc_value);
  if (m.calc_kind === "multiply") {
    return t("modifiers.rule.multiply", { value });
  }
  const action = t(
    m.direction === "discount"
      ? "modifiers.action.discount"
      : "modifiers.action.charge",
  );
  return t(
    m.calc_kind === "percent"
      ? "modifiers.rule.percent"
      : "modifiers.rule.fixed",
    { action, value },
  );
};

/** Pre-fill form values from a modifier; new modifiers default to active. The
 * caller can pass the already-built `fields` so a single render doesn't
 * reconstruct them (and re-run the picklist i18n) once here and once for
 * `renderFields`; it defaults to a fresh build for standalone callers. */
export const modifierToFieldValues = (
  modifier?: Modifier,
  fields: Field[] = getModifierFields(),
): Record<string, string | number | null> =>
  entityToFieldValues(
    modifier,
    fields,
    {
      active: (m) => booleanToCheckbox(m.active),
      min_subtotal: (m) =>
        m.min_subtotal ? Number(toMajorUnits(m.min_subtotal)) : "",
      min_visits: (m) => m.min_visits || "",
      stock: (m) => m.stock ?? "",
    },
    modifier ? undefined : { active: "1" },
  );

export const modifierAggregateToFieldValues = (
  modifier: Modifier,
): Record<string, string | number> => ({
  total_uses: modifier.total_uses,
  usage_count: modifier.usage_count,
});
