/** Owner saves of the listing form, run through the create and edit
 *  resources the way the production handlers run them. */

import { getStoredListingWithCount } from "#db/listings/records.ts";
import {
  buildCreateListingResource,
  buildUpdateListingResource,
  type ListingUpdateResult,
} from "#routes/admin/listings-form.ts";
import { listingFormView } from "#templates/fields/listing.ts";
import {
  type TestFormValues,
  testFormParams,
} from "#test-utils/form-values.ts";
import type { Listing } from "#types";

/** The smallest form the create page accepts, plus the given boxes. */
export const listingForm = (extra: TestFormValues = {}) =>
  testFormParams({
    max_attendees: "50",
    max_quantity: "5",
    name: "Parsed listing",
    unit_price: "0",
    ...extra,
  });

/** Run one create save as the production create handler does. */
export const tryCreateListing = (extra: TestFormValues = {}) => {
  const form = listingForm(extra);
  return buildCreateListingResource(form, listingFormView("owner")).create(
    form,
  );
};

export const createListing = async (
  extra: TestFormValues = {},
): Promise<Listing> => {
  const result = await tryCreateListing(extra);
  if (!result.ok) throw new Error(`create failed: ${result.error}`);
  return result.row;
};

/** Run one edit save against the stored row, as the production edit handler
 *  does. A daily listing's effective date is already empty, so the save's date
 *  guard must see the value the row still stores. */
export const saveListingEdit = async (
  id: number,
  extra: TestFormValues = {},
): Promise<ListingUpdateResult> => {
  const form = listingForm({ slug: "kept-slug", ...extra });
  const stored = (await getStoredListingWithCount(id))!;
  return buildUpdateListingResource(stored, listingFormView("owner")).update(
    id,
    form,
  );
};

export const updateListing = async (
  id: number,
  extra: TestFormValues = {},
): Promise<Listing> => {
  const result = await saveListingEdit(id, extra);
  if (!result.ok) throw new Error(`update failed: ${JSON.stringify(result)}`);
  return result.row;
};
