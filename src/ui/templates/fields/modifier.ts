/** Modifier form fields (same for create and edit — no slug). */

/* jscpd:ignore-start */
import { t } from "#i18n";
import {
  defineForm,
  type FormDefinition,
  type FormValues,
} from "#shared/forms/definition.ts";
import type { Field } from "#shared/forms/field.ts";
import {
  CalcKindSchema,
  ModifierDirectionSchema,
  ModifierScopeSchema,
  ModifierTriggerSchema,
} from "#shared/price-modifier.ts";
import { parseOptionalMinorUnits } from "#shared/validation/money.ts";
import { picklistOptions } from "#templates/fields/picklist-options.ts";

/* jscpd:ignore-end */

const DECIMAL_VALUE_PATTERN = /^(?:\d+(?:\.\d+)?|\.\d+)$/;

const isDecimalValue = (value: string): boolean => {
  const trimmed = value.trim();
  return (
    DECIMAL_VALUE_PATTERN.test(trimmed) && Number.isFinite(Number(trimmed))
  );
};

/**
 * Modifier form fields (per-request builder). Built on demand rather than at
 * module load so the picklist option labels resolve through `t()` only when the
 * form is used, keeping that work off the admin routes' cold-start path. The
 * listing and invite field builders follow the same pattern.
 */
const getModifierFields = () =>
  [
    {
      label: "Name",
      name: "name",
      placeholder: "Early bird",
      required: true,
      type: "text",
    },
    {
      defaultValue: "fixed",
      invalidMessage: "Invalid modifier type",
      label: "Type",
      name: "calc_kind",
      options: picklistOptions(CalcKindSchema, "modifiers.calc_kind"),
      type: "select",
    },
    {
      defaultValue: "charge",
      invalidMessage: "Invalid direction",
      label: "Direction",
      name: "direction",
      options: picklistOptions(ModifierDirectionSchema, "modifiers.direction"),
      type: "select",
    },
    {
      hint: "Fixed: an amount in your currency. Percentage: e.g. 10 for 10%. Multiplier: e.g. 1.5. Direction is ignored for multipliers (the factor sets it).",
      inputmode: "decimal",
      label: "Value",
      name: "calc_value",
      // Required, so `validateSingleField` rejects empty input before `parse`
      // runs; `parse` therefore only ever sees a value the validator accepted.
      parse: (value: string) => Number(value),
      required: true,
      type: "text",
      validate: (value: string) =>
        isDecimalValue(value) ? null : t("modifiers.error.invalid_number"),
    },
    {
      defaultValue: "automatic",
      hint: "When this applies. Promo codes are entered by the buyer at checkout; optional add-ons are chosen by the buyer; question answers apply when the buyer picks a linked answer (choose the answers on the edit page after saving).",
      invalidMessage: "Invalid trigger",
      label: "Trigger",
      name: "trigger",
      options: picklistOptions(ModifierTriggerSchema, "modifiers.trigger"),
      type: "select",
    },
    {
      hint: "The code buyers enter at checkout. Required for promo-code modifiers; ignored otherwise.",
      label: "Promo code",
      name: "code",
      placeholder: "SUMMER20",
      type: "text",
    },
    {
      defaultValue: "all",
      hint: "Which items this applies to. For specific listings or groups, choose the listings/groups on the edit page after saving.",
      invalidMessage: "Invalid scope",
      label: "Applies to",
      name: "scope",
      options: picklistOptions(ModifierScopeSchema, "modifiers.scope"),
      type: "select",
    },
    {
      hint: "Only apply when the order subtotal is at least this amount (in your currency). Leave blank for no minimum.",
      inputmode: "decimal",
      label: "Minimum order (optional)",
      name: "min_subtotal",
      // Optional: blank means no minimum (0). `parse` maps blank to 0;
      // `validateSingleField` only runs `validate` on a non-empty value.
      parse: (value: string) => (value ? Number.parseFloat(value) : 0),
      type: "text",
      // A present value is a currency amount, so reject a negative, a non-number,
      // or one with more decimals than the currency allows (which `toMinorUnits`
      // would otherwise round at save) rather than silently coercing it.
      validate: (value: string) =>
        parseOptionalMinorUnits(value) === null
          ? "Minimum order must be a valid amount for your currency"
          : null,
    },
    {
      hint: "Only apply to a returning customer with at least this many previous bookings. 0 (or blank) applies to everyone; 1 means seen at least once before.",
      label: "Minimum previous bookings (optional)",
      min: 0,
      name: "min_visits",
      parse: (value: string) => (value ? Number(value) : 0),
      type: "number",
    },
    {
      hint: "Total number available across all orders. Leave blank for unlimited.",
      label: "Stock (optional)",
      min: 0,
      name: "stock",
      type: "number",
    },
    {
      hint: "Question-answer modifiers only: tick to charge this once for the whole booking instead of for every ticket that picked the answer. Ignored for other triggers.",
      label: "Charge",
      name: "max_per_order",
      options: [{ label: "Charge once per order", value: "1" }],
      type: "checkbox-group",
    },
    {
      label: "Status",
      name: "active",
      options: [{ label: "Active (apply at checkout)", value: "1" }],
      type: "checkbox-group",
    },
  ] as const satisfies readonly Field[];

type ModifierForm = FormDefinition<ReturnType<typeof getModifierFields>>;

export const getModifierForm = (): ModifierForm =>
  defineForm({ fields: getModifierFields() });

export type ModifierFormValues = FormValues<ModifierForm>;
