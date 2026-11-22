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
        description:
          "Create a booking. The name is always required. The listing's contact fields setting decides which of email, phone, address and special_instructions are required too. A listing booked per date also needs date.",
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
          "Book whole package bundles (optional: date for dated bundles, dayCount for customisable ones, children choosing each parent member's add-ons). The name is always required. The package's contact fields setting decides which of email, phone, address and special_instructions are required too.",
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
        minimum: 1,
        name: "Camping Weekend",
        priceMinor: 5500,
        slug: "camping-weekend",
      },
    });
  });

  test("name the fields of each booking body, and no booking has an update", () => {
    const listing = documented(
      PUBLIC_API_ENDPOINTS,
      "POST",
      "/api/listings/:slug/book",
    ).fields!;
    const bundle = documented(
      PUBLIC_API_ENDPOINTS,
      "POST",
      "/api/packages/:slug/book",
    ).fields!;

    expect(listing.map((row) => row.key)).toEqual([
      "address",
      "children",
      "customPrice",
      "date",
      "email",
      "name",
      "phone",
      "quantity",
      "special_instructions",
    ]);
    expect(bundle.map((row) => row.key)).toEqual([
      "address",
      "children",
      "date",
      "dayCount",
      "email",
      "name",
      "phone",
      "quantity",
      "special_instructions",
    ]);
    expect(listing.filter((row) => row.required).map((row) => row.key)).toEqual(
      ["name", "quantity"],
    );
    expect(bundle.filter((row) => row.required).map((row) => row.key)).toEqual([
      "name",
      "quantity",
    ]);
  });

  test("document a children entry with the keys the server reads", () => {
    const children = documented(
      PUBLIC_API_ENDPOINTS,
      "POST",
      "/api/packages/:slug/book",
    ).fields!.find((row) => row.key === "children");

    expect(children?.value).toEqual({
      form: "list_of",
      of: {
        form: "object",
        names: ["customPrice", "parent", "quantity", "slug"],
      },
    });
  });

  test("every key of a booking example is a documented field", () => {
    for (const path of [
      "/api/listings/:slug/book",
      "/api/packages/:slug/book",
    ]) {
      const endpoint = documented(PUBLIC_API_ENDPOINTS, "POST", path);
      const keys = endpoint.fields!.map((row) => row.key);

      expect(
        Object.keys(JSON.parse(endpoint.request!)).filter(
          (key) => !keys.includes(key),
        ),
      ).toEqual([]);
    }
  });
});
