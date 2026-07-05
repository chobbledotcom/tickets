/**
 * GET /address-lookup through the full request pipeline, plus the search
 * panel appearing on the public booking form ("locked") and the admin
 * attendee forms ("editable") only while a provider is configured.
 */

import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { hmacHash } from "#shared/crypto/hashing.ts";
import { execute } from "#shared/db/client.ts";
import { settings } from "#shared/db/settings.ts";
import { nowMs } from "#shared/now.ts";
import {
  describeWithEnv,
  getTestSession,
  mockRequest,
  setupListingAndLogin,
} from "#test-utils";
import { setupFetchStub } from "#test-utils/fetch-stub.ts";

const PROVIDER_BODY = JSON.stringify([
  { envelopeAddress: { summaryLine: "10 Downing Street, LONDON, SW1A 2AA" } },
]);

/** Turn the lookup on (writes settings like the admin form would). */
const enableEasypostcodes = async (): Promise<void> => {
  await settings.update.addressLookup.provider("easypostcodes");
  await settings.update.addressLookup.apiKey("test-api-key");
};

const lookupGet = async (search: string): Promise<Response> => {
  const { handleRequest } = await import("#routes");
  return handleRequest(
    mockRequest(`/address-lookup?search=${encodeURIComponent(search)}`),
  );
};

describeWithEnv("GET /address-lookup", { db: true }, () => {
  const { stubFetch } = setupFetchStub();

  test("404s while no provider is configured", async () => {
    const response = await lookupGet("SW1A 2AA");
    expect(response.status).toBe(404);
  });

  test("returns the provider's addresses as JSON", async () => {
    await enableEasypostcodes();
    stubFetch(() => Promise.resolve(new Response(PROVIDER_BODY)));

    const response = await lookupGet("sw1a2aa");

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      addresses: ["10 Downing Street, LONDON, SW1A 2AA"],
    });
  });

  test("400s with the validation message for a malformed postcode", async () => {
    await enableEasypostcodes();
    stubFetch(() => Promise.reject(new Error("should not be called")));

    const response = await lookupGet("definitely not a postcode");

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: "That doesn't look like a valid postcode",
    });
  });

  test("400s when the search parameter is missing entirely", async () => {
    await enableEasypostcodes();
    stubFetch(() => Promise.reject(new Error("should not be called")));

    const { handleRequest } = await import("#routes");
    const response = await handleRequest(mockRequest("/address-lookup"));

    expect(response.status).toBe(400);
  });

  // Lock the test client's IP ("direct" — getClientIp's fallback) in the
  // limiter's own namespace exactly as recordIpAttempt would.
  const lockOutTestIp = async (): Promise<void> => {
    await execute(
      "INSERT OR REPLACE INTO login_attempts (ip, attempts, locked_until) VALUES (?, ?, ?)",
      [await hmacHash("address:direct"), 30, nowMs() + 60_000],
    );
  };

  test("429s while the client IP is locked out", async () => {
    await enableEasypostcodes();
    stubFetch(() => Promise.resolve(new Response(PROVIDER_BODY)));
    await lockOutTestIp();

    const response = await lookupGet("SW1A 2AA");

    expect(response.status).toBe(429);
    expect(await response.json()).toEqual({
      error: "Too many address lookups. Please try again later.",
    });
  });

  test("authenticated staff are never rate limited", async () => {
    await enableEasypostcodes();
    stubFetch(() => Promise.resolve(new Response(PROVIDER_BODY)));
    await lockOutTestIp();
    const { cookie } = await getTestSession();

    const { handleRequest } = await import("#routes");
    const response = await handleRequest(
      mockRequest("/address-lookup?search=SW1A%202AA", {
        headers: { cookie },
      }),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      addresses: ["10 Downing Street, LONDON, SW1A 2AA"],
    });
  });
});

/** Render the public booking form for a listing and return its HTML. */
const bookingFormHtml = async (slug: string): Promise<string> => {
  const { handleRequest } = await import("#routes");
  const response = await handleRequest(mockRequest(`/ticket/${slug}`));
  return response.text();
};

describeWithEnv("address lookup search panels", { db: true }, () => {
  test("the booking form has no panel while lookup is off", async () => {
    const { listing } = await setupListingAndLogin({ fields: "address" });
    const html = await bookingFormHtml(listing.slug);
    expect(html).toContain('name="address"');
    expect(html).not.toContain("data-address-lookup");
  });

  test("the booking form renders a locked panel when a provider is set", async () => {
    const { listing } = await setupListingAndLogin({ fields: "address" });
    await enableEasypostcodes();
    const html = await bookingFormHtml(listing.slug);
    expect(html).toContain('data-address-lookup="locked"');
    // The panel sits directly above the address textarea, hidden until the
    // client script reveals it.
    expect(html.indexOf("data-address-lookup")).toBeLessThan(
      html.indexOf('name="address"'),
    );
    expect(html).toContain('placeholder="e.g. SW1A 1AA"');
  });

  test("the admin attendee form renders an always-editable panel", async () => {
    await setupListingAndLogin();
    await enableEasypostcodes();
    const { cookie } = await getTestSession();
    const { handleRequest } = await import("#routes");
    const response = await handleRequest(
      mockRequest("/admin/attendees/new", { headers: { cookie } }),
    );
    const html = await response.text();
    expect(html).toContain('data-address-lookup="editable"');
    expect(html).not.toContain('data-address-lookup="locked"');
    // Admin mode has no Edit button — the textarea is never locked.
    expect(html).not.toContain("data-address-edit");
  });
});
