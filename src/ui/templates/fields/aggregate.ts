/**
 * Aggregate fields — read-only counter columns trigger-maintained on listings,
 * modifiers, and answers. They surface on admin edit pages so an operator can
 * repair drift without a DB surgery.
 */

import { t } from "#i18n";
import type { Field } from "#shared/forms.tsx";
import { validateNonNegativeInteger } from "#templates/fields/validators.ts";

export const aggregateIntegerField = (name: string, label: string): Field => ({
  label,
  min: 0,
  name,
  parse: Number,
  required: true,
  type: "number",
  validate: validateNonNegativeInteger(label),
});

export const listingAggregateFields: Field[] = [
  aggregateIntegerField("booked_quantity", t("fields.listing.booked_quantity")),
  aggregateIntegerField("tickets_count", t("fields.listing.tickets_count")),
];

export const modifierAggregateFields: Field[] = [
  aggregateIntegerField("total_uses", t("fields.modifier.total_uses")),
  aggregateIntegerField("usage_count", t("fields.modifier.usage_count")),
];

export const answerAggregateFields: Field[] = [
  aggregateIntegerField("times_selected", t("fields.answer.times_selected")),
];
