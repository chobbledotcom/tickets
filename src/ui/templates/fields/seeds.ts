/** Demo-data seeds form fields. */

import { t } from "#i18n";
import { defineForm } from "#shared/forms/definition.ts";
import { MAX_SEED_LISTINGS, SEED_MAX_ATTENDEES } from "#shared/seeds.ts";
import { wholeNumberFieldShape } from "#templates/fields/validators.ts";

/** One seed count, with the field's own bounds reporting an out-of-range
 *  value. */
const seedCountField = (label: string) =>
  ({ required: true, ...wholeNumberFieldShape(label) }) as const;

export const seedsForm = defineForm({
  fields: [
    {
      defaultValue: "5",
      id: "listing_count",
      label: t("admin.seeds.listing_count_label"),
      max: MAX_SEED_LISTINGS,
      min: 1,
      name: "listing_count",
      ...seedCountField(t("admin.seeds.listing_count_label")),
    },
    {
      defaultValue: "10",
      id: "attendees_per_listing",
      label: t("admin.seeds.attendees_label"),
      max: SEED_MAX_ATTENDEES,
      min: 0,
      name: "attendees_per_listing",
      ...seedCountField(t("admin.seeds.attendees_label")),
    },
  ] as const,
});
