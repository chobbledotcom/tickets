/**
 * Rules every documented endpoint follows, whichever one it is.
 */

import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import * as v from "valibot";
import { adminApiRoutes } from "#routes/admin/api.ts";
import { apiRoutes } from "#routes/api/index.ts";
import type { EndpointDoc } from "#shared/admin-api-example/endpoint-doc.ts";
import { PUBLIC_API_ENDPOINTS } from "#shared/admin-api-example/public.ts";
import { ADMIN_API_ENDPOINTS } from "#shared/admin-api-example.ts";
import {
  PublicListingDetailSchema,
  PublicListingSchema,
} from "#test-utils/api-schemas.ts";
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
    expect(() =>
      v.parse(PublicListingSchema, parsed.listings[0]),
    ).not.toThrow();
  });

  /** The bundle the package endpoint documents in full. */
  const documentedPackageSlug = (): string =>
    JSON.parse(
      documented(PUBLIC_API_ENDPOINTS, "GET", "/api/packages/:slug").response,
    ).package.slug;

  test("the listing list also shows the packages on sale", () => {
    // A caller browsing what is for sale gets bundles as well as listings, so
    // an example showing only listings hides half the answer.
    const parsed = JSON.parse(
      documented(PUBLIC_API_ENDPOINTS, "GET", "/api/listings").response,
    );

    expect(Object.keys(parsed).toSorted()).toEqual(["listings", "packages"]);
    for (const bundle of parsed.packages) {
      expect(bundle.url).toBe(`/ticket/${bundle.slug}`);
      // Browsing and the package endpoint must describe the same bundle.
      expect(bundle.slug).toBe(documentedPackageSlug());
    }
  });

  test("the single listing example is one the endpoint could send", () => {
    const listing = JSON.parse(
      documented(PUBLIC_API_ENDPOINTS, "GET", "/api/listings/:slug").response,
    ).listing;

    // A listing on its own page may also carry the add-ons to choose from.
    expect(() => v.parse(PublicListingDetailSchema, listing)).not.toThrow();
  });

  test("only a listing sold by the day offers dates to choose", () => {
    const listing = JSON.parse(
      documented(PUBLIC_API_ENDPOINTS, "GET", "/api/listings/:slug").response,
    ).listing;

    // The endpoint adds the dates only for a daily listing, so a standard one
    // showing them documents an answer it never gives.
    expect("availableDates" in listing).toBe(listing.listingType === "daily");
  });

  test("toggling a listing answers with the state it was moved to", () => {
    const stateAfter = (action: string) =>
      JSON.parse(
        documented(
          ADMIN_API_ENDPOINTS,
          "POST",
          `/api/admin/listings/:listingId/${action}`,
        ).response,
      ).listing.active;

    expect(stateAfter("deactivate")).toBe(false);
    expect(stateAfter("reactivate")).toBe(true);
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
      .filter(({ field, value }) => isBlank(value, field))
      .map(({ where }) => where);

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
