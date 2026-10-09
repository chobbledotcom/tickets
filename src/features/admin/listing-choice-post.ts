import { logActivity } from "#db/activity-log.ts";
/* jscpd:ignore-start */
import { getListingWithCount } from "#db/listings/records.ts";
import { settings } from "#db/settings.ts";
import { t } from "#i18n";
import { formGuard, OWNER_FORM } from "#routes/auth.ts";
import { createIdEntityHandler, type IdRouteHandler } from "#routes/entity.ts";
import { notFoundResponse, redirect } from "#routes/response.ts";
/* jscpd:ignore-end */
import type { AdminFeatureKey } from "#shared/admin-features.ts";
import type { FormParams } from "#shared/form-data.ts";
import { countLabel } from "#shared/format-units.ts";

type ListingChoicePostConfig = {
  feature: AdminFeatureKey;
  fieldName: string;
  label: string;
  noun: string;
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
  readIds,
  saveIds,
  tab,
}: ListingChoicePostConfig): IdRouteHandler =>
  createIdEntityHandler<
    NonNullable<Awaited<ReturnType<typeof getListingWithCount>>>
  >(getListingWithCount)(formGuard(OWNER_FORM))(
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
