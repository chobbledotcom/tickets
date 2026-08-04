import { formGuard, OWNER_FORM } from "#routes/auth.ts";
import { createIdEntityHandler, type IdRouteHandler } from "#routes/entity.ts";
import { notFoundResponse, redirect } from "#routes/response.ts";
import type { AdminFeatureKey } from "#shared/admin-features.ts";
import { logActivity } from "#shared/db/activity-log.ts";
import { getListingWithCount } from "#shared/db/listings/records.ts";
import { settings } from "#shared/db/settings.ts";
import type { FormParams } from "#shared/form-data.ts";

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

const countLabel = (count: number, noun: string): string =>
  `${count} ${noun}${count === 1 ? "" : "s"}`;

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
      return redirect(`/admin/listing/${id}/${tab}`, `${label} updated`, true);
    },
  );
