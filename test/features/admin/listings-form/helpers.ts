/** The listing form a test submits, and the create and update calls the
 * admin form routes make with it. */

import { getStoredListingWithCount } from "#db/listings/records.ts";
import {
  buildCreateListingResource,
  buildUpdateListingResource,
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

export const updateListing = async (
  id: number,
  extra: TestFormValues = {},
): Promise<Listing> => {
  const form = listingForm({ slug: "kept-slug", ...extra });
  // The production edit handler passes the stored row, not the effective one:
  // a daily listing's effective date is already empty, and the save's date
  // guard must see the value the row still stores.
  const stored = (await getStoredListingWithCount(id))!;
  const result = await buildUpdateListingResource(form, stored).update(
    id,
    form,
  );
  if (!result.ok) throw new Error(`update failed: ${result.error}`);
  return result.row;
};
