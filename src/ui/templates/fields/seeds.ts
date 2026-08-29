/** Demo-data seeds form fields. */

import { t } from "#i18n";
import { defineForm } from "#shared/forms/definition.ts";
import { MAX_SEED_LISTINGS, SEED_MAX_ATTENDEES } from "#shared/seeds.ts";

export const seedsForm = defineForm({
  fields: [
    {
      defaultValue: "5",
      id: "listing_count",
      label: t("admin.seeds.listing_count_label"),
      max: MAX_SEED_LISTINGS,
      min: 1,
      name: "listing_count",
      required: true,
      type: "number",
    },
    {
      defaultValue: "10",
      id: "attendees_per_listing",
      label: t("admin.seeds.attendees_label"),
      max: SEED_MAX_ATTENDEES,
      min: 0,
      name: "attendees_per_listing",
      required: true,
      type: "number",
    },
  ] as const,
});
