/**
 * The admin API docs page publishes an example listing. These tests check it
 * against a hand-written shape, so a change to the real conversion cannot
 * quietly take the documented example with it.
 */

import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import * as v from "valibot";
import { adminApiRoutes, toAdminListing } from "#routes/admin/api.ts";
import { apiRoutes } from "#routes/api/index.ts";
import {
  ADMIN_API_ENDPOINTS,
  ADMIN_API_EXAMPLE_ADMIN_LISTING,
  type EndpointDoc,
  PUBLIC_API_ENDPOINTS,
} from "#shared/admin-api-example.ts";
import { API_EXAMPLE_LISTING } from "#shared/api-example.ts";
import { isOwnerRole } from "#shared/types.ts";
import { isIsoDate } from "#shared/validation/date.ts";
import {
  AdminGroupSchema,
  AdminListingSchema,
  PackageBookRequestSchema,
  PackageResponseSchema,
  PublicListingSchema,
} from "#test-utils/api-schemas.ts";

/** The running totals a record only gains by being booked, all at zero on a
 * record that was just created. Absent on a resource that has none. */
const freshTotals = (
  example: Record<string, unknown>,
): Record<string, number> =>
  Object.fromEntries(
    ["attendee_count", "cost", "income", "profit", "tickets_count"]
      .filter((field) => field in example)
      .map((field) => [field, 0]),
  );

/** The documented endpoint for a method and path, or a loud failure naming the
 * one that has gone missing — the drift this file exists to catch. */
const documented = (
  endpoints: EndpointDoc[],
  method: string,
  path: string,
): EndpointDoc => {
  const found = endpoints.find(
    (endpoint) => endpoint.method === method && endpoint.path === path,
  );
  if (!found) throw new Error(`No documented endpoint for ${method} ${path}`);
  return found;
};

/** Every value inside a JSON body, each paired with where it sits. */
const jsonLeaves = (value: unknown, where: string): [string, unknown][] => {
  if (Array.isArray(value)) {
    return value.flatMap((entry, index) =>
      jsonLeaves(entry, `${where}[${index}]`),
    );
  }
  if (value !== null && typeof value === "object") {
    return Object.entries(value).flatMap(([key, entry]) =>
      jsonLeaves(entry, `${where}.${key}`),
    );
  }
  return [[where, value]];
};

/** Fields that say how many of something, where zero means nothing to book. Two
 * kinds of field are deliberately left out: a price, because free is a real
 * price, and a capacity, because zero there means "no cap of its own". */
const COUNT_FIELDS = [
  "quantity",
  "max_quantity",
  "maxPurchasable",
  "dayCount",
  "days",
  "id",
];

/** A value not worth documenting: blank text, a negative number, or a count of
 * none. `field` is the name the value was found under. */
const isBlank = (value: unknown, field = ""): boolean => {
  if (typeof value === "string") return value.trim().length === 0;
  if (typeof value !== "number") return false;
  return value < 0 || (value === 0 && COUNT_FIELDS.includes(field));
};

describe("admin API example", () => {
  test("the documented example has every admin listing field", () => {
    expect(() =>
      v.parse(AdminListingSchema, ADMIN_API_EXAMPLE_ADMIN_LISTING),
    ).not.toThrow();
  });

  test("an internal field leaking into a response is refused", () => {
    expect(() =>
      v.parse(AdminListingSchema, {
        ...ADMIN_API_EXAMPLE_ADMIN_LISTING,
        slug_index: "leaked",
      }),
    ).toThrow();
  });

  test("a missing field is refused", () => {
    const { name: _, ...withoutName } = ADMIN_API_EXAMPLE_ADMIN_LISTING;

    expect(() => v.parse(AdminListingSchema, withoutName)).toThrow();
  });

  test("a field of the wrong type is refused", () => {
    expect(() =>
      v.parse(AdminListingSchema, {
        ...ADMIN_API_EXAMPLE_ADMIN_LISTING,
        id: "1",
      }),
    ).toThrow();
  });

  test("the conversion drops the internal slug index", () => {
    expect(toAdminListing(API_EXAMPLE_LISTING)).not.toHaveProperty(
      "slug_index",
    );
  });

  test("the conversion keeps every other listing field as it was", () => {
    const { slug_index: _, ...expected } = API_EXAMPLE_LISTING;

    expect(toAdminListing(API_EXAMPLE_LISTING)).toEqual(expected);
  });

  test("the documented example says which groups the listing is in", () => {
    expect(ADMIN_API_EXAMPLE_ADMIN_LISTING.group_ids).toEqual([]);
  });
});

describe("endpoint docs", () => {
  const allEndpoints = [...PUBLIC_API_ENDPOINTS, ...ADMIN_API_ENDPOINTS];

  test("all endpoint responses are valid JSON", () => {
    for (const endpoint of allEndpoints) {
      expect(() => JSON.parse(endpoint.response)).not.toThrow();
    }
  });

  test("all endpoint requests (when present) are valid JSON", () => {
    for (const endpoint of allEndpoints) {
      if (endpoint.request) {
        expect(() => JSON.parse(endpoint.request!)).not.toThrow();
      }
    }
  });

  test("public listing list response uses PublicListing shape", () => {
    const listEndpoint = documented(
      PUBLIC_API_ENDPOINTS,
      "GET",
      "/api/listings",
    );
    const parsed = JSON.parse(listEndpoint.response);
    // strictObject validates both the keys and the field types of the
    // documented example — a stronger check than the previous key-set compare.
    expect(() =>
      v.parse(PublicListingSchema, parsed.listings[0]),
    ).not.toThrow();
  });

  test("the admin listing list also shows the groups a listing is in", () => {
    const listEndpoint = documented(
      ADMIN_API_ENDPOINTS,
      "GET",
      "/api/admin/listings",
    );
    const parsed = JSON.parse(listEndpoint.response);
    expect(() => v.parse(AdminListingSchema, parsed.listings[0])).not.toThrow();
  });

  /** One member of the documented package, with any add-ons it publishes. */
  type PackageMember = {
    slug: string;
    children?: { maxPurchasable: number; slug: string }[];
  };

  const documentedPackage = () =>
    JSON.parse(
      documented(PUBLIC_API_ENDPOINTS, "GET", "/api/packages/:slug").response,
    ).package;

  const documentedBooking = () =>
    JSON.parse(
      documented(PUBLIC_API_ENDPOINTS, "POST", "/api/packages/:slug/book")
        .request!,
    );

  test("the documented package is one a caller could really buy", () => {
    const endpoint = documented(
      PUBLIC_API_ENDPOINTS,
      "GET",
      "/api/packages/:slug",
    );

    expect(() =>
      v.parse(PackageResponseSchema, JSON.parse(endpoint.response).package),
    ).not.toThrow();
  });

  test("the documented package booking is one the endpoint would accept", () => {
    const endpoint = documented(
      PUBLIC_API_ENDPOINTS,
      "POST",
      "/api/packages/:slug/book",
    );

    expect(() =>
      v.parse(PackageBookRequestSchema, JSON.parse(endpoint.request!)),
    ).not.toThrow();
  });

  test("the documented booking chooses add-ons the package really offers", () => {
    // The endpoint checks each selection against the parent's real children, so
    // a booking naming a child the package does not publish, or asking for more
    // than that child can supply, would be refused.
    type Child = { maxPurchasable: number; slug: string };
    const members = documentedPackage().members as PackageMember[];
    const offered = new Map<string, Map<string, Child>>(
      members.map((member) => [
        member.slug,
        new Map<string, Child>(
          (member.children ?? []).map((child) => [child.slug, child]),
        ),
      ]),
    );

    const chosen = documentedBooking().children as {
      parent: string;
      quantity: number;
      slug: string;
    }[];

    expect(chosen.length).toBeGreaterThan(0);
    for (const { parent, quantity, slug } of chosen) {
      const child = offered.get(parent)?.get(slug);
      if (!child) throw new Error(`The package has no ${slug} under ${parent}`);
      expect(quantity).toBeLessThanOrEqual(child.maxPurchasable);
    }
  });

  test("the documented booking picks a date and length the package offers", () => {
    // Only a package that publishes dates or day counts constrains these, and
    // the endpoint refuses a choice outside what it published.
    const pkg = documentedPackage();
    const booking = documentedBooking();

    if (pkg.availableDates) {
      expect(pkg.availableDates).toContain(booking.date);
    }
    if (pkg.dayCounts) {
      expect(
        (pkg.dayCounts as { days: number }[]).map(({ days }) => days),
      ).toContain(booking.dayCount);
    }
  });

  test("the documented booking fills in the fields the package asks for", () => {
    // The endpoint checks the booking against the package's merged contact
    // fields, so a booking missing one of them is refused.
    const booking = documentedBooking();

    for (const field of documentedPackage().fields.split(",")) {
      expect(booking).toHaveProperty(field);
    }
  });

  test("a create answers with the record as it was just stored", () => {
    for (const { create, createResponse, example } of documentedResources()) {
      // What the caller sent, over the defaults, with nothing booked yet.
      expect(createResponse).toEqual({
        ...example,
        ...create,
        ...freshTotals(example),
      });
    }
  });

  test("an update answers with the record as it now reads", () => {
    for (const { example, update, updateResponse } of documentedResources()) {
      // Every field the update asked to change comes back changed, and the
      // rest of the record is unchanged.
      expect(updateResponse).toEqual({ ...example, ...update });
    }
  });

  test("each admin resource is returned under its own name", () => {
    const singleResponses = ADMIN_API_ENDPOINTS.filter(
      (e: EndpointDoc) => e.method === "GET" && e.path.includes(":"),
    ).map((e: EndpointDoc) => Object.keys(JSON.parse(e.response)));

    expect(singleResponses).toEqual([["listing"], ["group"], ["holiday"]]);
  });

  test("a delete answers with a plain ok", () => {
    const deletes = ADMIN_API_ENDPOINTS.filter(
      (e: EndpointDoc) => e.method === "DELETE",
    );

    expect(deletes.length).toBe(3);
    for (const endpoint of deletes) {
      expect(JSON.parse(endpoint.response)).toEqual({ status: "ok" });
    }
  });

  test("the listing list says which admin level is reading it", () => {
    const listEndpoint = documented(
      ADMIN_API_ENDPOINTS,
      "GET",
      "/api/admin/listings",
    );

    // The example is the owner's view, which sees every listing.
    expect(isOwnerRole(JSON.parse(listEndpoint.response).admin_level)).toBe(
      true,
    );
  });

  /** The example a resource's endpoints show, paired with the delete body a
   * caller would have to send for it. */
  const documentedResources = (): {
    del: { confirm_identifier: string };
    example: { id: number; name: string };
    create: Record<string, unknown>;
    createResponse: Record<string, unknown>;
    update: Record<string, unknown>;
    updateResponse: Record<string, unknown>;
  }[] =>
    ["listings", "groups", "holidays"].map((plural) => {
      const singular = plural.slice(0, -1);
      const forPath = (method: string, suffix: string) =>
        documented(
          ADMIN_API_ENDPOINTS,
          method,
          `/api/admin/${plural}${suffix}`,
        );
      return {
        create: JSON.parse(forPath("POST", "").request!),
        createResponse: JSON.parse(forPath("POST", "").response)[singular],
        del: JSON.parse(forPath("DELETE", `/:${singular}Id`).request!),
        example: JSON.parse(forPath("GET", `/:${singular}Id`).response)[
          singular
        ],
        update: JSON.parse(forPath("PUT", `/:${singular}Id`).request!),
        updateResponse: JSON.parse(forPath("PUT", `/:${singular}Id`).response)[
          singular
        ],
      };
    });

  test("a delete example confirms the exact name of the thing it deletes", () => {
    // The real endpoints refuse a delete whose confirm_identifier is not the
    // stored name, so a documented pair that disagreed would be rejected.
    for (const { del, example } of documentedResources()) {
      expect(del.confirm_identifier).toBe(example.name);
    }
  });

  test("every documented example is a real, named, stored record", () => {
    for (const { example } of documentedResources()) {
      expect(isBlank(example.name)).toBe(false);
      // An id addresses a stored row and goes straight into a URL, so a
      // fractional one could never name the documented record.
      expect(Number.isSafeInteger(example.id)).toBe(true);
      expect(example.id).toBeGreaterThan(0);
    }
  });

  test("an update example only names fields it changes", () => {
    // A field set to the value the record already has teaches nothing, so
    // every field in an update example must differ from the example record.
    for (const { example, update } of documentedResources()) {
      // The two bodies are parsed separately, so compare by value rather than
      // by identity: two equal arrays are not the same object.
      const unchanged = Object.entries(update)
        .filter(
          ([key, value]) =>
            JSON.stringify(value) ===
            JSON.stringify((example as Record<string, unknown>)[key]),
        )
        .map(([key]) => key);

      expect(unchanged).toEqual([]);
      expect(Object.keys(update).length).toBeGreaterThan(0);
    }
  });

  test("the documented holiday runs from its start to its end", () => {
    const holiday = JSON.parse(
      documented(ADMIN_API_ENDPOINTS, "GET", "/api/admin/holidays/:holidayId")
        .response,
    ).holiday;

    expect(isIsoDate(holiday.start_date)).toBe(true);
    expect(isIsoDate(holiday.end_date)).toBe(true);
    // A holiday that ended before it began could never be saved.
    expect(holiday.end_date >= holiday.start_date).toBe(true);
  });

  test("the documented group shows every field a group carries", () => {
    const group = JSON.parse(
      documented(ADMIN_API_ENDPOINTS, "GET", "/api/admin/groups/:groupId")
        .response,
    ).group;

    expect(() => v.parse(AdminGroupSchema, group)).not.toThrow();
  });

  test("no documented request asks for a blank or zero value", () => {
    // Every value in a request example is something a caller would copy, so an
    // empty name or a zero quantity would be a request the endpoint refuses.
    const blanks = allEndpoints
      .filter((endpoint: EndpointDoc) => endpoint.request !== undefined)
      .flatMap((endpoint: EndpointDoc) =>
        jsonLeaves(
          JSON.parse(endpoint.request!),
          `${endpoint.method} ${endpoint.path}`,
        ),
      )
      .filter(([where, value]) => isBlank(value, where.split(".").pop() ?? ""))
      .map(([where]) => where);

    expect(blanks).toEqual([]);
  });

  test("documented JSON is indented so it can be read", () => {
    for (const endpoint of allEndpoints) {
      for (const body of [endpoint.request, endpoint.response]) {
        if (body === undefined) continue;
        expect(body).toContain("\n  ");
      }
    }
  });

  test("a missing endpoint is named, not stumbled over", () => {
    expect(() =>
      documented(ADMIN_API_ENDPOINTS, "GET", "/api/nowhere"),
    ).toThrow("No documented endpoint for GET /api/nowhere");
  });

  test("every endpoint has a description", () => {
    for (const endpoint of allEndpoints) {
      expect(endpoint.description.length).toBeGreaterThan(0);
    }
  });

  test("every public API route has a documented endpoint", () => {
    const documented = PUBLIC_API_ENDPOINTS.map(
      (e: EndpointDoc) => `${e.method} ${e.path}`,
    );
    // Derive expected routes from the actual apiRoutes export, excluding OPTIONS
    const expected = Object.keys(apiRoutes).filter(
      (k) => !k.startsWith("OPTIONS"),
    );
    expect(documented.sort()).toEqual(expected.sort());
  });

  test("every admin API route has a documented endpoint", () => {
    const documented = ADMIN_API_ENDPOINTS.map(
      (e: EndpointDoc) => `${e.method} ${e.path}`,
    );
    // Every registered admin API route (listings, groups, holidays) must be
    // documented — no filter, so newly added routes fail until documented.
    const expected = Object.keys(adminApiRoutes);
    expect(documented.sort()).toEqual(expected.sort());
  });
});
