/**
 * Example API responses for documentation.
 *
 * These constants are rendered in the admin guide. A test validates
 * that calling toPublicListing() with the same inputs produces matching
 * output, so a shape change will break the test and force an update.
 */

import { type PublicListing, toPublicListing } from "#routes/api/index.ts";
import type { ListingWithCount } from "#shared/types.ts";
import { EXAMPLE_LISTING } from "#shared/webhook-example.ts";

/** Example listing matching the webhook example data */
export const API_EXAMPLE_LISTING: ListingWithCount = {
  active: true,
  assign_built_site: false,
  attachment_name: "",
  attachment_url: "",
  attendee_count: 3,
  bookable_days: [],
  can_pay_more: false,
  closes_at: null,
  cost: 0,
  created: "2025-07-01T00:00:00.000Z",
  customisable_days: false,
  date: "Sat 20 Aug 2025, 10:00 AM",
  day_prices: {},
  description:
    "A hands-on workshop covering watercolours and sketching techniques. All materials provided.",
  duration_days: 1,
  fields: "email",
  group_id: 0,
  hidden: false,
  id: 1,
  image_url: "",
  income: 7500,
  initial_site_months: 0,
  listing_type: "standard",
  location: "Village Hall",
  max_attendees: 20,
  max_price: EXAMPLE_LISTING.unit_price,
  max_quantity: 5,
  maximum_days_after: 30,
  minimum_days_before: 1,
  months_per_unit: 0,
  name: EXAMPLE_LISTING.name,
  non_transferable: false,
  profit: 7500,
  purchase_only: false,
  slug: EXAMPLE_LISTING.slug,
  slug_index: EXAMPLE_LISTING.slug,
  thank_you_url: "",
  tickets_count: 3,
  unit_price: EXAMPLE_LISTING.unit_price,
  uses_logistics: false,
  webhook_url: "",
};

/** The example PublicListing, produced by toPublicListing */
export const API_EXAMPLE_PUBLIC_LISTING: PublicListing = toPublicListing(
  API_EXAMPLE_LISTING,
  false,
  undefined,
  undefined,
);

/** Example list response JSON */
export const API_LIST_EXAMPLE_JSON: string = JSON.stringify(
  { listings: [API_EXAMPLE_PUBLIC_LISTING] },
  null,
  2,
);

/** Example single-listing response JSON */
export const API_SINGLE_EXAMPLE_JSON: string = JSON.stringify(
  {
    listing: {
      ...API_EXAMPLE_PUBLIC_LISTING,
      availableDates: ["2025-08-20", "2025-08-21"],
    },
  },
  null,
  2,
);

/** Example availability response JSON */
export const API_AVAILABILITY_EXAMPLE_JSON: string = JSON.stringify(
  { available: true },
  null,
  2,
);

/** Example free booking response JSON */
export const API_BOOK_FREE_EXAMPLE_JSON: string = JSON.stringify(
  {
    booking: {
      amountOwed: 0,
      ticketToken: "A1B2C3D4E5",
      ticketUrl: "/t/A1B2C3D4E5",
    },
  },
  null,
  2,
);

/** Example paid booking response JSON */
export const API_BOOK_PAID_EXAMPLE_JSON: string = JSON.stringify(
  { booking: { checkoutUrl: "https://checkout.stripe.com/c/pay/cs_live_..." } },
  null,
  2,
);

/** Example booking request body */
export const API_BOOK_REQUEST_JSON: string = JSON.stringify(
  {
    customPrice: 10.0,
    date: "2025-08-20",
    email: "alice@example.com",
    name: "Alice Smith",
    phone: "+44 7700 900000",
    quantity: 2,
  },
  null,
  2,
);
