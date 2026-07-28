/**
 * Rules every documented endpoint follows, whichever one it is.
 */

import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import * as v from "valibot";
import { adminApiRoutes } from "#routes/admin/api.ts";
import { apiRoutes } from "#routes/api/index.ts";
import {
  ADMIN_API_ENDPOINTS,
  type EndpointDoc,
  PUBLIC_API_ENDPOINTS,
} from "#shared/admin-api-example.ts";
import { PublicListingSchema } from "#test-utils/api-schemas.ts";
import { documented, isBlank, jsonLeaves } from "./helpers.ts";

describe("every documented endpoint", () => {
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
    const documentedPaths = PUBLIC_API_ENDPOINTS.map(
      (e: EndpointDoc) => `${e.method} ${e.path}`,
    );
    // Derive expected routes from the actual apiRoutes export, excluding OPTIONS
    const expected = Object.keys(apiRoutes).filter(
      (k) => !k.startsWith("OPTIONS"),
    );
    expect(documentedPaths.sort()).toEqual(expected.sort());
  });

  test("every admin API route has a documented endpoint", () => {
    const documentedPaths = ADMIN_API_ENDPOINTS.map(
      (e: EndpointDoc) => `${e.method} ${e.path}`,
    );
    // Every registered admin API route (listings, groups, holidays) must be
    // documented — no filter, so newly added routes fail until documented.
    const expected = Object.keys(adminApiRoutes);
    expect(documentedPaths.sort()).toEqual(expected.sort());
  });
});
