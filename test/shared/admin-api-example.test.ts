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

/** Fields that say how many of something, where zero means nothing to book. A
 * price is deliberately not one of these: a free item is a real thing to show. */
const COUNT_FIELDS = [
  "quantity",
  "max_attendees",
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
    // a booking naming a child the package does not publish would be refused.
    const pkg = JSON.parse(
      documented(PUBLIC_API_ENDPOINTS, "GET", "/api/packages/:slug").response,
    ).package;
    const offered = new Map<string, string[]>(
      pkg.members.map(
        (member: { slug: string; children?: { slug: string }[] }) => [
          member.slug,
          (member.children ?? []).map((child) => child.slug),
        ],
      ),
    );

    const chosen = JSON.parse(
      documented(PUBLIC_API_ENDPOINTS, "POST", "/api/packages/:slug/book")
        .request!,
    ).children as { parent: string; slug: string }[];

    expect(chosen.length).toBeGreaterThan(0);
    for (const { parent, slug } of chosen) {
      expect(offered.get(parent) ?? []).toContain(slug);
    }
  });

  test("the documented booking fills in the fields the package asks for", () => {
    // The endpoint checks the booking against the package's merged contact
    // fields, so a booking missing one of them is refused.
    const pkg = JSON.parse(
      documented(PUBLIC_API_ENDPOINTS, "GET", "/api/packages/:slug").response,
    ).package;
    const booking = JSON.parse(
      documented(PUBLIC_API_ENDPOINTS, "POST", "/api/packages/:slug/book")
        .request!,
    );

    for (const field of pkg.fields.split(",")) {
      expect(booking).toHaveProperty(field);
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
