import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { PUBLIC_API_ENDPOINTS } from "#shared/admin-api-example/public.ts";
import { documented } from "./helpers.ts";

/** The routes the public API documents, as they read on the page — a change
 *  to any method, path, or route description updates what operators integrate
 *  against, so it lands here with the change. */
const ROUTES = PUBLIC_API_ENDPOINTS.map(({ description, method, path }) => ({
  description,
  method,
  path,
}));

describe("documented public endpoints", () => {
  test("expose exactly the browsing, booking, and package routes", () => {
    expect(ROUTES).toEqual([
      {
        description: "List all active, non-hidden listings",
        method: "GET",
        path: "/api/listings",
      },
      {
        description: "Get a single listing by slug",
        method: "GET",
        path: "/api/listings/:slug",
      },
      {
        description:
          "Check if spots are available (optional query: quantity, date)",
        method: "GET",
        path: "/api/listings/:slug/availability",
      },
      {
        description: "Create a booking",
        method: "POST",
        path: "/api/listings/:slug/book",
      },
      {
        description:
          "Get a package bundle by slug: its whole-bundle price (per day count for customisable-days bundles), capacity, dates, and members with their required children",
        method: "GET",
        path: "/api/packages/:slug",
      },
      {
        description:
          "Book whole package bundles (optional: date for dated bundles, dayCount for customisable ones, children choosing each parent member's add-ons)",
        method: "POST",
        path: "/api/packages/:slug/book",
      },
    ]);
  });

  test("document their booking request bodies exactly", () => {
    expect(
      JSON.parse(
        documented(PUBLIC_API_ENDPOINTS, "POST", "/api/listings/:slug/book")
          .request!,
      ),
    ).toEqual({
      email: "alice@example.com",
      name: "Alice Smith",
      quantity: 2,
    });
    expect(
      JSON.parse(
        documented(PUBLIC_API_ENDPOINTS, "POST", "/api/packages/:slug/book")
          .request!,
      ),
    ).toEqual({
      children: [{ parent: "tent-pitch", quantity: 1, slug: "extra-bedding" }],
      email: "alice@example.com",
      name: "Alice Smith",
      phone: "+447700900123",
      quantity: 1,
    });
  });

  test("state the whole documented package bundle", () => {
    const response = JSON.parse(
      documented(PUBLIC_API_ENDPOINTS, "GET", "/api/packages/:slug").response,
    );

    expect(response).toEqual({
      package: {
        description: "Two nights' camping with firepit hire",
        fields: "email,phone",
        maxPurchasable: 5,
        members: [
          {
            children: [
              {
                assignBuiltSite: false,
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
              },
            ],
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
    });
  });
});
