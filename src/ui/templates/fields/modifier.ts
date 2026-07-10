/** Modifier form fields (same for create and edit — no slug). */

import type { Field } from "#shared/forms.tsx";
import { parseOptionalMinorUnits } from "#shared/validation/money.ts";

/** Form values for the modifier create/edit form. */
export type ModifierFormValues = {
  name: string;
  calc_kind: string;
  direction: string;
  calc_value: number;
  trigger: string;
  code: string;
  scope: string;
  min_subtotal: number;
  min_visits: number;
  stock: number | null;
  active: string;
};

export const modifierFields: Field[] = [
  {
    label: "Name",
    name: "name",
    placeholder: "Early bird",
    required: true,
    type: "text",
  },
  {
    defaultValue: "fixed",
    label: "Type",
    name: "calc_kind",
    options: [
      { label: "Fixed amount", value: "fixed" },
      { label: "Percentage", value: "percent" },
      { label: "Multiplier", value: "multiply" },
    ],
    type: "select",
  },
  {
    defaultValue: "charge",
    label: "Direction",
    name: "direction",
    options: [
      { label: "Charge (adds to the price)", value: "charge" },
      { label: "Discount (reduces the price)", value: "discount" },
    ],
    type: "select",
  },
  {
    hint: "Fixed: an amount in your currency. Percentage: e.g. 10 for 10%. Multiplier: e.g. 1.5. Direction is ignored for multipliers (the factor sets it).",
    inputmode: "decimal",
    label: "Value",
    name: "calc_value",
    // Required, so `validateSingleField` rejects empty input before `parse`
    // runs; `parse` therefore only ever sees a value the validator accepted.
    parse: (value: string) => Number.parseFloat(value),
    required: true,
    type: "text",
    validate: (value: string) =>
      Number.isFinite(Number.parseFloat(value)) ? null : "Enter a valid number",
  },
  {
    defaultValue: "automatic",
    hint: "When this applies. Promo codes are entered by the buyer at checkout; optional add-ons are chosen by the buyer; question answers apply when the buyer picks a linked answer (choose the answers on the edit page after saving).",
    label: "Trigger",
    name: "trigger",
    options: [
      { label: "Automatic (always)", value: "automatic" },
      { label: "Promo code", value: "code" },
      { label: "Optional add-on", value: "optional" },
      { label: "Question answer", value: "answer" },
    ],
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
    label: "Applies to",
    name: "scope",
    options: [
      { label: "The whole order", value: "all" },
      { label: "Specific listings", value: "listings" },
      { label: "Listings in specific groups", value: "groups" },
    ],
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
    label: "Status",
    name: "active",
    options: [{ label: "Active (apply at checkout)", value: "1" }],
    type: "checkbox-group",
  },
];
