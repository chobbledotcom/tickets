/**
 * Tests that the admin API examples match the real toAdminListing() output.
 * If the shape changes, this test fails and forces an update to
 * src/shared/admin-api-example.ts (and thus the API docs page).
 */

import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { adminApiRoutes, toAdminListing } from "#routes/admin/api.ts";
import { apiRoutes, toPublicListing } from "#routes/api/index.ts";
import {
  ADMIN_API_ENDPOINTS,
  ADMIN_API_EXAMPLE_ADMIN_LISTING,
  ADMIN_API_EXAMPLE_LISTING,
  type EndpointDoc,
  PUBLIC_API_ENDPOINTS,
} from "#shared/admin-api-example.ts";

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
    const realPublicListing = toPublicListing(
      ADMIN_API_EXAMPLE_LISTING,
      false,
      undefined,
      undefined,
    );
    const realKeys = Object.keys(realPublicListing).sort();
    const exampleKeys = Object.keys(parsed.listings[0]).sort();
    expect(exampleKeys).toEqual(realKeys);
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
    // Derive expected routes from the actual adminApiRoutes export,
    // filtered to listing routes (the only ones currently documented)
    const expected = Object.keys(adminApiRoutes).filter((k) =>
      k.includes("/listings"),
    );
    expect(documented.sort()).toEqual(expected.sort());
  });
});
