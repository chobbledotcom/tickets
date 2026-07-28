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
import {
  AdminListingSchema,
  PublicListingSchema,
} from "#test-utils/api-schemas.ts";

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

  test("admin listing list response uses AdminListing shape", () => {
    const listEndpoint = ADMIN_API_ENDPOINTS.find(
      (e: EndpointDoc) =>
        e.method === "GET" && e.path === "/api/admin/listings",
    )!;
    const parsed = JSON.parse(listEndpoint.response);
    expect(() => v.parse(AdminListingSchema, parsed.listings[0])).not.toThrow();
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
