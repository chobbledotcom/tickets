/**
 * Aggregate fields — read-only counter columns trigger-maintained on listings,
 * modifiers, and answers. They surface on admin edit pages so an operator can
 * repair drift without a DB surgery.
 */

import { t } from "#i18n";
import type { Field } from "#shared/forms/field.ts";
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

type AggregateFieldSpec = {
  labelKey: string;
  name: string;
};

const buildAggregateFields = (specs: readonly AggregateFieldSpec[]): Field[] =>
  specs.map(({ labelKey, name }) => aggregateIntegerField(name, t(labelKey)));

const LISTING_AGGREGATE_FIELDS = [
  { labelKey: "fields.listing.booked_quantity", name: "booked_quantity" },
  { labelKey: "fields.listing.tickets_count", name: "tickets_count" },
] as const satisfies readonly AggregateFieldSpec[];

const MODIFIER_AGGREGATE_FIELDS = [
  { labelKey: "fields.modifier.total_uses", name: "total_uses" },
  { labelKey: "fields.modifier.usage_count", name: "usage_count" },
] as const satisfies readonly AggregateFieldSpec[];

const ANSWER_AGGREGATE_FIELDS = [
  { labelKey: "fields.answer.times_selected", name: "times_selected" },
] as const satisfies readonly AggregateFieldSpec[];

export const getListingAggregateFields = (): Field[] =>
  buildAggregateFields(LISTING_AGGREGATE_FIELDS);

export const getModifierAggregateFields = (): Field[] =>
  buildAggregateFields(MODIFIER_AGGREGATE_FIELDS);

export const getAnswerAggregateFields = (): Field[] =>
  buildAggregateFields(ANSWER_AGGREGATE_FIELDS);
