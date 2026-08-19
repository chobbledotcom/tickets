/**
 * GET /address-lookup through the full request pipeline, plus the search
 * panel appearing on the public booking form and the admin attendee forms
 * only while a provider is configured (the address textarea always stays
 * editable).
 */

import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { hmacHash } from "#crypto/hashing.ts";
import { execute } from "#db/client.ts";
import { settings } from "#db/settings.ts";
import { nowMs } from "#shared/now.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { stubFetch } from "#test-utils/fetch-stub.ts";
import { mockRequest } from "#test-utils/mocks.ts";
import {
  createTestEditorSession,
  getTestSession,
  setupListingAndLogin,
} from "#test-utils/session.ts";

const PROVIDER_BODY = JSON.stringify([
  {
    envelopeAddress: { summaryLine: "10 Downing Street, LONDON, SW1A 2AA" },
    latitude: "51.503396",
    longitude: "-0.127640",
  },
]);

/** The lines-only body an anonymous lookup gets — no geolocation data. */
const DOWNING_STREET_LINES = {
  addresses: ["10 Downing Street, LONDON, SW1A 2AA"],
};

/** The staff body: the lines plus each line's located match (the Logistics
 * tab's map pin). */
const DOWNING_STREET_WITH_MATCHES = {
  ...DOWNING_STREET_LINES,
  matches: [
    {
      lat: "51.503396",
      line: "10 Downing Street, LONDON, SW1A 2AA",
      lng: "-0.127640",
    },
  ],
};

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

/** A Downing Street lookup as a signed-in user (any role, via its cookie). */
const lookupGetSignedIn = async (cookie: string): Promise<Response> => {
  const { handleRequest } = await import("#routes");
  return handleRequest(
    mockRequest("/address-lookup?search=SW1A%202AA", { headers: { cookie } }),
  );
};

describeWithEnv("GET /address-lookup", { db: true }, () => {
  test("404s while no provider is configured", async () => {
    const response = await lookupGet("SW1A 2AA");
    expect(response.status).toBe(404);
  });

  test("an anonymous lookup gets address lines but never coordinates", async () => {
    await enableEasypostcodes();
    using _fetch = stubFetch(new Response(PROVIDER_BODY));

    const response = await lookupGet("sw1a2aa");

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(DOWNING_STREET_LINES);
  });

  test("400s with the validation message for a malformed postcode", async () => {
    await enableEasypostcodes();
    using _fetch = stubFetch(new Error("should not be called"));

    const response = await lookupGet("definitely not a postcode");

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: "That doesn't look like a valid postcode",
    });
  });

  test("400s when the search parameter is missing entirely", async () => {
    await enableEasypostcodes();
    using _fetch = stubFetch(new Error("should not be called"));

    const { handleRequest } = await import("#routes");
    const response = await handleRequest(mockRequest("/address-lookup"));

    expect(response.status).toBe(400);
  });

  // Lock the test client's IP ("direct" — getClientIp's fallback) in the
  // limiter's own namespace exactly as the configured limiter does.
  const lockOutTestIp = async (): Promise<void> => {
    await execute(
      "INSERT OR REPLACE INTO login_attempts (ip, attempts, locked_until) VALUES (?, ?, ?)",
      [await hmacHash("address:direct"), 30, nowMs() + 60_000],
    );
  };

  test("429s while the client IP is locked out", async () => {
    await enableEasypostcodes();
    using _fetch = stubFetch(new Response(PROVIDER_BODY));
    await lockOutTestIp();

    const response = await lookupGet("SW1A 2AA");

    expect(response.status).toBe(429);
    expect(await response.json()).toEqual({
      error: "Too many address lookups. Please try again later.",
    });
  });

  test("authenticated staff are never rate limited", async () => {
    await enableEasypostcodes();
    using _fetch = stubFetch(new Response(PROVIDER_BODY));
    await lockOutTestIp();
    const { cookie } = await getTestSession();

    const response = await lookupGetSignedIn(cookie);

    expect(response.status).toBe(200);
    // Staff also get the located matches for the Logistics tab's map pin.
    expect(await response.json()).toEqual(DOWNING_STREET_WITH_MATCHES);
  });

  test("a restricted editor session gets lines but never coordinates", async () => {
    await enableEasypostcodes();
    using _fetch = stubFetch(new Response(PROVIDER_BODY));
    const { cookie } = await createTestEditorSession();

    const response = await lookupGetSignedIn(cookie);

    expect(response.status).toBe(200);
    // Editors cannot open attendee pages, so no geolocation payload either.
    expect(await response.json()).toEqual(DOWNING_STREET_LINES);
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

  test("the booking form renders the panel when a provider is set", async () => {
    const { listing } = await setupListingAndLogin({ fields: "address" });
    await enableEasypostcodes();
    const html = await bookingFormHtml(listing.slug);
    expect(html).toContain("data-address-lookup");
    // The panel sits directly above the address textarea, hidden until the
    // client script reveals it.
    expect(html.indexOf("data-address-lookup")).toBeLessThan(
      html.indexOf('name="address"'),
    );
    // The textarea is always editable — no Edit button is rendered.
    expect(html).not.toContain("data-address-edit");
  });

  test("the admin attendee form renders the panel", async () => {
    await setupListingAndLogin();
    await enableEasypostcodes();
    const { cookie } = await getTestSession();
    const { handleRequest } = await import("#routes");
    const response = await handleRequest(
      mockRequest("/admin/attendees/new", { headers: { cookie } }),
    );
    const html = await response.text();
    expect(html).toContain("data-address-lookup");
    expect(html).not.toContain("data-address-edit");
  });
});
