/** The listing form a test submits, and the create and update calls the
 * admin form routes make with it. */

import { getStoredListingWithCount } from "#db/listings/records.ts";
import {
  buildCreateListingResource,
  buildUpdateListingResource,
  type ListingUpdateResult,
} from "#routes/admin/listings-form.ts";
import {
  type TestFormValues,
  testFormParams,
} from "#test-utils/form-values.ts";
import type { Listing } from "#types";

export const listingForm = (extra: TestFormValues = {}) =>
  testFormParams({
    max_attendees: "50",
    max_quantity: "5",
    name: "Parsed listing",
    ...extra,
  });

export const createListing = async (
  extra: TestFormValues = {},
): Promise<Listing> => {
  const form = listingForm(extra);
  const result = await buildCreateListingResource(form).create(form);
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
  return buildUpdateListingResource(stored).update(id, form);
};

export const updateListing = async (
  id: number,
  extra: TestFormValues = {},
): Promise<Listing> => {
  const result = await saveListingEdit(id, extra);
  if (result.ok) return result.row;
  // A save that finds no row carries no error text of its own.
  const { error } = { error: "the listing is absent", ...result };
  throw new Error(`update failed: ${error}`);
};
