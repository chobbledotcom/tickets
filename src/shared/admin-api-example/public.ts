/**
 * The public API's documented endpoints: browsing listings, booking one, and
 * the package bundles a caller can book whole.
 */

import * as v from "valibot";
import type { PublicListing } from "#routes/api/public-listing.ts";
import { PackageChildrenSchema } from "#routes/api/request-schemas.ts";
import {
  API_AVAILABILITY_EXAMPLE_JSON,
  API_BOOK_PAID_EXAMPLE_JSON,
  API_LIST_EXAMPLE_JSON,
  API_SINGLE_EXAMPLE_JSON,
} from "#shared/api-example.ts";
import { type EndpointDoc, json } from "./endpoint-doc.ts";

/** The add-on offered under the example package's "Tent Pitch" member. A member
 * that offers a child is published with it, so the booking example can choose
 * it by slug. */
const PACKAGE_EXAMPLE_CHILD = {
  canPayMore: false,
  customisableDays: false,
  date: null,
  description: "A duvet and pillows for the tent.",
  fields: "email",
  imageAltText: null,
  imageUrl: null,
  isClosed: false,
  isSoldOut: false,
  listingType: "standard",
  location: null,
  maxPrice: 1200,
  maxPurchasable: 5,
  name: "Extra Bedding",
  nonTransferable: false,
  purchaseOnly: false,
  slug: "extra-bedding",
  unitPrice: 1200,
} satisfies PublicListing;

/** The package-book example's `children`, parsed through the LIVE request
 * schema ({@link PackageChildrenSchema}) — a drifted example is a build-time
 * parse error, so the docs can never show a body the endpoint rejects. */
const PACKAGE_BOOK_CHILDREN_EXAMPLE = v.parse(PackageChildrenSchema, [
  { parent: "tent-pitch", quantity: 1, slug: "extra-bedding" },
]);

export const PUBLIC_API_ENDPOINTS: EndpointDoc[] = [
  {
    description: "List all active, non-hidden listings",
    method: "GET",
    path: "/api/listings",
    response: API_LIST_EXAMPLE_JSON,
  },
  {
    description: "Get a single listing by slug",
    method: "GET",
    path: "/api/listings/:slug",
    response: API_SINGLE_EXAMPLE_JSON,
  },
  {
    description:
      "Check if spots are available (optional query: quantity, date)",
    method: "GET",
    path: "/api/listings/:slug/availability",
    response: API_AVAILABILITY_EXAMPLE_JSON,
  },
  {
    description: "Create a booking",
    method: "POST",
    path: "/api/listings/:slug/book",
    request: json({
      email: "alice@example.com",
      name: "Alice Smith",
      quantity: 2,
    }),
    // The listing has a price, so booking it answers with somewhere to pay.
    response: API_BOOK_PAID_EXAMPLE_JSON,
  },
  {
    description:
      "Get a package bundle by slug: its whole-bundle price (per day count for customisable-days bundles), capacity, dates, and members with their required children",
    method: "GET",
    path: "/api/packages/:slug",
    response: json({
      package: {
        description: "Two nights' camping with firepit hire",
        fields: "email,phone",
        maxPurchasable: 5,
        members: [
          {
            // The add-on the booking example below chooses for this member.
            children: [PACKAGE_EXAMPLE_CHILD],
            name: "Tent Pitch",
            quantity: 1,
            slug: "tent-pitch",
          },
          { name: "Firepit", quantity: 1, slug: "firepit" },
        ],
        name: "Camping Weekend",
        priceMinor: 5500,
        slug: "camping-weekend",
      },
    }),
  },
  {
    description:
      "Book whole package bundles (optional: date for dated bundles, dayCount for customisable ones, children choosing each parent member's add-ons)",
    method: "POST",
    path: "/api/packages/:slug/book",
    request: json({
      children: PACKAGE_BOOK_CHILDREN_EXAMPLE,
      email: "alice@example.com",
      name: "Alice Smith",
      // The package asks for email and phone, so a booking must give both.
      phone: "+447700900123",
      quantity: 1,
    }),
    // The bundle costs money, so booking it answers with somewhere to pay.
    response: API_BOOK_PAID_EXAMPLE_JSON,
  },
];
