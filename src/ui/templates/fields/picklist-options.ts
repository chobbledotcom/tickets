/**
 * Build a form field's `options` list from a valibot picklist schema, so the
 * choices a select/checkbox offers ARE the schema's `.options` — the same
 * source of truth that drives the value type and its runtime guard. There is no
 * hand-maintained parallel list to drift out of sync: adding a member to the
 * schema surfaces it in the form the moment its translation exists.
 *
 * Each option's label comes from an i18n key built as `${labelKeyPrefix}.${value}`
 * (e.g. `picklistOptions(ListingTypeSchema, "fields.listing.type")` reads
 * `fields.listing.type.standard`). `CONTACT_FIELDS` in `shared/types.ts` is the
 * exemplar this generalises.
 */

import { t } from "#i18n";
import type { ChoiceOptions } from "#shared/forms.tsx";

export const picklistOptions = <TValue extends string>(
  schema: { readonly options: readonly [TValue, ...TValue[]] },
  labelKeyPrefix: string,
): ChoiceOptions<TValue> => {
  const toOption = (value: TValue) => ({
    label: t(`${labelKeyPrefix}.${value}`),
    value,
  });
  const [first, ...rest] = schema.options;
  return [toOption(first), ...rest.map(toOption)];
};
