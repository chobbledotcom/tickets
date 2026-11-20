/** The listing form, as the owner's page draws and checks it. */

import { getListingForm, listingFormView } from "#templates/fields/listing.ts";
import { baseListingForm } from "#test-utils/factories.ts";
import type { TestFormValues } from "#test-utils/form-values.ts";

/** The boxes the owner's page draws, as the form checks them. */
export const ownerFields = () =>
  getListingForm(listingFormView("owner")).fields;

/** The smallest form the page accepts, plus the given boxes. */
export const listingForm = (
  overrides: TestFormValues = {},
): TestFormValues => ({ ...baseListingForm, ...overrides });
