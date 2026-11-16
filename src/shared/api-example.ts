/**
 * Example API responses for documentation.
 *
 * These constants are rendered in the admin guide. A test validates
 * that calling toPublicListing() with the same inputs produces matching
 * output, so a shape change will break the test and force an update.
 */

import type { BlindIndex } from "#crypto/sealed.ts";
import {
  type PublicListing,
  toPublicListing,
} from "#routes/api/public-listing.ts";
import { EXAMPLE_LISTING } from "#shared/webhook-example.ts";
import type { ListingWithCount } from "#types";

/** Example listing matching the webhook example data */
export const API_EXAMPLE_LISTING: ListingWithCount = {
  active: true,
  assignBuiltSite: false,
  attachmentName: "",
  attachmentUrl: "",
  attendeeCount: 3,
  bookableAlone: false,
  bookableDays: [],
  bookedQuantity: 3,
  canPayMore: false,
  closesAt: null,
  cost: 0,
  created: "2025-07-01T00:00:00.000Z",
  customisableDays: false,
  date: "2025-08-20T10:00:00.000Z",
  dayPrices: {},
  description:
    "A hands-on workshop covering watercolours and sketching techniques. All materials provided.",
  durationDays: 1,
  fields: "email",
  hidden: false,
  id: 1,
  imageAltText: "",
  imageThumbUrl: "",
  imageUrl: "",
  income: 7500,
  initialSiteMonths: 0,
  listingType: "standard",
  location: "Village Hall",
  maxAttendees: 20,
  maximumDaysAfter: 30,
  maxPrice: EXAMPLE_LISTING.unit_price,
  maxQuantity: 5,
  minimumDaysBefore: 1,
  minQuantity: 1,
  monthsPerUnit: 0,
  name: EXAMPLE_LISTING.name,
  nonTransferable: false,
  profit: 7500,
  purchaseOnly: false,
  recurringInterval: "",
  recurringPrice: 0,
  slug: EXAMPLE_LISTING.slug,
  // Documentation fixture, never queried — a hand-crafted stand-in for the
  // stored blind index (same boundary as test fixtures).
  slugIndex: EXAMPLE_LISTING.slug as BlindIndex,
  thankYouUrl: "",
  ticketsCount: 3,
  unitPrice: EXAMPLE_LISTING.unit_price,
  useDefaults: false,
  usesLogistics: false,
  webhookUrl: "",
};

/** The example PublicListing, produced by toPublicListing */
export const API_EXAMPLE_PUBLIC_LISTING: PublicListing = toPublicListing(
  API_EXAMPLE_LISTING,
  false,
  undefined,
  undefined,
);

/** The bundle both package examples describe: browsing lists it, and the
 * package endpoint documents the same one in full. */
export const API_EXAMPLE_PACKAGE = {
  description: "Two nights' camping with firepit hire",
  name: "Camping Weekend",
  slug: "camping-weekend",
};

/** Example list response JSON */
export const API_LIST_EXAMPLE_JSON: string = JSON.stringify(
  {
    listings: [API_EXAMPLE_PUBLIC_LISTING],
    // Packages are listed alongside, so a bundle stays discoverable even when
    // its member listings are not shown on their own.
    packages: [
      { ...API_EXAMPLE_PACKAGE, url: `/ticket/${API_EXAMPLE_PACKAGE.slug}` },
    ],
  },
  null,
  2,
);

/** Example single-listing response JSON */
export const API_SINGLE_EXAMPLE_JSON: string = JSON.stringify(
  {
    listing: API_EXAMPLE_PUBLIC_LISTING,
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
