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
  AdminListingSchema,
  PackageBookRequestSchema,
  PackageResponseSchema,
  PublicListingSchema,
} from "#test-utils/api-schemas.ts";

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

/** An empty string, or a count of none — neither is worth documenting. */
const isBlank = (value: unknown): boolean =>
  (typeof value === "string" && value.length === 0) ||
  (typeof value === "number" && value <= 0);

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
    const listEndpoint = PUBLIC_API_ENDPOINTS.find(
      (e: EndpointDoc) => e.method === "GET" && e.path === "/api/listings",
    )!;
    const parsed = JSON.parse(listEndpoint.response);
    // strictObject validates both the keys and the field types of the
    // documented example — a stronger check than the previous key-set compare.
    expect(() =>
      v.parse(PublicListingSchema, parsed.listings[0]),
    ).not.toThrow();
  });

  test("the admin listing list also shows the groups a listing is in", () => {
    const listEndpoint = ADMIN_API_ENDPOINTS.find(
      (e: EndpointDoc) =>
        e.method === "GET" && e.path === "/api/admin/listings",
    )!;
    const parsed = JSON.parse(listEndpoint.response);
    expect(() => v.parse(AdminListingSchema, parsed.listings[0])).not.toThrow();
  });

  test("the documented package is one a caller could really buy", () => {
    const endpoint = PUBLIC_API_ENDPOINTS.find(
      (e: EndpointDoc) =>
        e.method === "GET" && e.path === "/api/packages/:slug",
    )!;

    expect(() =>
      v.parse(PackageResponseSchema, JSON.parse(endpoint.response).package),
    ).not.toThrow();
  });

  test("the documented package booking is one the endpoint would accept", () => {
    const endpoint = PUBLIC_API_ENDPOINTS.find(
      (e: EndpointDoc) =>
        e.method === "POST" && e.path === "/api/packages/:slug/book",
    )!;

    expect(() =>
      v.parse(PackageBookRequestSchema, JSON.parse(endpoint.request!)),
    ).not.toThrow();
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
    const listEndpoint = ADMIN_API_ENDPOINTS.find(
      (e: EndpointDoc) =>
        e.method === "GET" && e.path === "/api/admin/listings",
    )!;

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
  }[] =>
    ["listings", "groups", "holidays"].map((plural) => {
      const forPath = (method: string, suffix: string) =>
        ADMIN_API_ENDPOINTS.find(
          (e: EndpointDoc) =>
            e.method === method && e.path === `/api/admin/${plural}${suffix}`,
        )!;
      const singular = plural.slice(0, -1);
      return {
        del: JSON.parse(
          forPath("DELETE", "/:id".replace("id", `${singular}Id`)).request!,
        ),
        example: JSON.parse(forPath("GET", `/:${singular}Id`).response)[
          singular
        ],
        update: JSON.parse(forPath("PUT", `/:${singular}Id`).request!),
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
      expect(example.name.length).toBeGreaterThan(0);
      expect(example.id).toBeGreaterThan(0);
    }
  });

  test("an update example only names fields it changes", () => {
    // A field set to the value the record already has teaches nothing, so
    // every field in an update example must differ from the example record.
    for (const { example, update } of documentedResources()) {
      const unchanged = Object.entries(update)
        .filter(
          ([key, value]) => value === (example as Record<string, unknown>)[key],
        )
        .map(([key]) => key);

      expect(unchanged).toEqual([]);
      expect(Object.keys(update).length).toBeGreaterThan(0);
    }
  });

  test("the documented holiday runs from its start to its end", () => {
    const holiday = JSON.parse(
      ADMIN_API_ENDPOINTS.find(
        (e: EndpointDoc) =>
          e.method === "GET" && e.path === "/api/admin/holidays/:holidayId",
      )!.response,
    ).holiday;

    expect(isIsoDate(holiday.start_date)).toBe(true);
    expect(isIsoDate(holiday.end_date)).toBe(true);
    // A holiday that ended before it began could never be saved.
    expect(holiday.end_date >= holiday.start_date).toBe(true);
  });

  test("the documented group has room for more than nobody", () => {
    const group = JSON.parse(
      ADMIN_API_ENDPOINTS.find(
        (e: EndpointDoc) =>
          e.method === "GET" && e.path === "/api/admin/groups/:groupId",
      )!.response,
    ).group;

    expect(group.max_attendees).toBeGreaterThan(0);
    expect(group.slug.length).toBeGreaterThan(0);
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
      .filter(([, value]) => isBlank(value))
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
