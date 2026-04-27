/**
 * Tests that the admin API examples match the real toAdminEvent() output.
 * If the shape changes, this test fails and forces an update to
 * src/shared/admin-api-example.ts (and thus the API docs page).
 */

import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { adminApiRoutes, toAdminEvent } from "#routes/admin/api.ts";
import { apiRoutes, toPublicEvent } from "#routes/api.ts";
import {
  ADMIN_API_ENDPOINTS,
  ADMIN_API_EXAMPLE_ADMIN_EVENT,
  ADMIN_API_EXAMPLE_EVENT,
  type EndpointDoc,
  PUBLIC_API_ENDPOINTS,
} from "#shared/admin-api-example.ts";

describe("admin API example", () => {
  test("toAdminEvent output matches the documented example", () => {
    const result = toAdminEvent(ADMIN_API_EXAMPLE_EVENT);
    expect(result).toEqual(ADMIN_API_EXAMPLE_ADMIN_EVENT);
  });

  test("example has all AdminEvent keys", () => {
    const result = toAdminEvent(ADMIN_API_EXAMPLE_EVENT);
    const resultKeys = Object.keys(result).sort();
    const exampleKeys = Object.keys(ADMIN_API_EXAMPLE_ADMIN_EVENT).sort();
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

  test("public event list response uses PublicEvent shape", () => {
    const listEndpoint = PUBLIC_API_ENDPOINTS.find(
      (e: EndpointDoc) => e.method === "GET" && e.path === "/api/events",
    )!;
    const parsed = JSON.parse(listEndpoint.response);
    const realPublicEvent = toPublicEvent(ADMIN_API_EXAMPLE_EVENT);
    const realKeys = Object.keys(realPublicEvent).sort();
    const exampleKeys = Object.keys(parsed.events[0]).sort();
    expect(exampleKeys).toEqual(realKeys);
  });

  test("admin event list response uses AdminEvent shape", () => {
    const listEndpoint = ADMIN_API_ENDPOINTS.find(
      (e: EndpointDoc) => e.method === "GET" && e.path === "/api/admin/events",
    )!;
    const parsed = JSON.parse(listEndpoint.response);
    const realAdminEvent = toAdminEvent(ADMIN_API_EXAMPLE_EVENT);
    const realKeys = Object.keys(realAdminEvent).sort();
    const exampleKeys = Object.keys(parsed.events[0]).sort();
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
    // filtered to event routes (the only ones currently documented)
    const expected = Object.keys(adminApiRoutes).filter((k) =>
      k.includes("/events"),
    );
    expect(documented.sort()).toEqual(expected.sort());
  });
});
