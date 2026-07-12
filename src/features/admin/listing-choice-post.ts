import { ownerFormById } from "#routes/entity.ts";
import { notFoundResponse, redirect } from "#routes/response.ts";
import { logActivity } from "#shared/db/activityLog.ts";
import { getListingWithCount } from "#shared/db/listings/records.ts";
import type { FormParams } from "#shared/form-data.ts";

type ListingChoicePostConfig = {
  fieldName: string;
  label: string;
  noun: string;
  readIds?: (form: FormParams) => number[] | Promise<number[]>;
  saveIds: (listingId: number, ids: number[]) => Promise<void>;
  tab: string;
};

const countLabel = (count: number, noun: string): string =>
  `${count} ${noun}${count === 1 ? "" : "s"}`;

export const createListingChoicePost = ({
  fieldName,
  label,
  noun,
  readIds,
  saveIds,
  tab,
}: ListingChoicePostConfig) =>
  ownerFormById(async (id, _session, form) => {
    const listing = await getListingWithCount(id);
    if (!listing) return notFoundResponse();
    const ids = readIds ? await readIds(form) : form.getNumberArray(fieldName);
    await saveIds(id, ids);
    await logActivity(
      `${label} updated for '${listing.name}' (${countLabel(ids.length, noun)})`,
      listing,
    );
    return redirect(`/admin/listing/${id}/${tab}`, `${label} updated`, true);
  });
