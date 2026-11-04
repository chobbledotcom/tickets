/* jscpd:ignore-start -- imports */
import { logActivity } from "#db/activity-log.ts";
import { settings } from "#db/settings.ts";
import { t } from "#i18n";
import type { IdRouteHandler } from "#routes/entity.ts";
import { notFoundResponse, redirect } from "#routes/response.ts";
import { formGuardAt } from "#routes/route-gates.ts";
import type { AdminFeatureKey } from "#shared/admin-features.ts";
import type { FormParams } from "#shared/form-data.ts";
import { countLabel } from "#shared/format-units.ts";
import { listingWithCountHandler } from "./listing-entity.ts";

/* jscpd:ignore-end */

type ListingChoicePostConfig = {
  feature: AdminFeatureKey;
  fieldName: string;
  label: string;
  noun: string;
  /** The route this post serves, whose declaration names the audience. */
  pattern: string;
  readIds?: (
    form: FormParams,
    fieldName: string,
  ) => number[] | Promise<number[]>;
  saveIds: (listingId: number, ids: number[]) => Promise<void>;
  tab: string;
};

export const createListingChoicePost = ({
  feature,
  fieldName,
  label,
  noun,
  pattern,
  readIds,
  saveIds,
  tab,
}: ListingChoicePostConfig): IdRouteHandler =>
  listingWithCountHandler(formGuardAt(pattern))(
    async (listing, _session, form, _request, { id }) => {
      if (!settings.features[feature]) return notFoundResponse();
      const ids = readIds
        ? await readIds(form, fieldName)
        : form.getNumberArray(fieldName);
      await saveIds(id, ids);
      await logActivity(
        `${label} updated for '${listing.name}' (${countLabel(
          ids.length,
          noun,
        )})`,
        listing,
      );
      return redirect(
        `/admin/listing/${id}/${tab}`,
        t("listings_table.choices_updated", { label }),
        true,
      );
    },
  );
