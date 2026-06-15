/**
 * Tests that the admin API examples match the real toAdminListing() output.
 * If the shape changes, this test fails and forces an update to
 * src/shared/admin-api-example.ts (and thus the API docs page).
 */

import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import * as v from "valibot";
import { adminApiRoutes, toAdminListing } from "#routes/admin/api.ts";
import { apiRoutes } from "#routes/api/index.ts";
import {
  ADMIN_API_ENDPOINTS,
  ADMIN_API_EXAMPLE_ADMIN_LISTING,
  ADMIN_API_EXAMPLE_LISTING,
  type EndpointDoc,
  PUBLIC_API_ENDPOINTS,
} from "#shared/admin-api-example.ts";
import { PublicListingSchema } from "#test-utils";

describe("admin API example", () => {
  test("toAdminListing output matches the documented example", () => {
    const result = toAdminListing(ADMIN_API_EXAMPLE_LISTING);
    expect(result).toEqual(ADMIN_API_EXAMPLE_ADMIN_LISTING);
  });

  test("example has all AdminListing keys", () => {
    const result = toAdminListing(ADMIN_API_EXAMPLE_LISTING);
    const resultKeys = Object.keys(result).sort();
    const exampleKeys = Object.keys(ADMIN_API_EXAMPLE_ADMIN_LISTING).sort();
    expect(exampleKeys).toEqual(resultKeys);
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
    const realAdminListing = toAdminListing(ADMIN_API_EXAMPLE_LISTING);
    const realKeys = Object.keys(realAdminListing).sort();
    const exampleKeys = Object.keys(parsed.listings[0]).sort();
    expect(exampleKeys).toEqual(realKeys);
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
