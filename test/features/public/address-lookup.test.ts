/** The address lookup route's limiter: every signed-in non-staff role shares
 * the anonymous per-IP limit, because each cache miss spends one of the
 * operator's paid provider requests. Only staff — the roles whose attendee
 * forms the search boxes serve — go unthrottled. */

import { expect } from "@std/expect";
import { afterEach, beforeEach, it as test } from "@std/testing/bdd";
import { hmacHash } from "#crypto/hashing.ts";
import { execute } from "#db/client.ts";
import { makeIpRateLimiter } from "#db/login-attempts.ts";
import { settings } from "#db/settings.ts";
import {
  ADDRESS_LOOKUP_LOCKOUT_MS,
  MAX_ADDRESS_LOOKUPS,
} from "#shared/limits.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { stubFetch } from "#test-utils/fetch-stub.ts";
import { awaitTestRequest } from "#test-utils/mocks.ts";
import { createTestScannerSession } from "#test-utils/role-sessions.ts";
import { testCookie } from "#test-utils/session.ts";

/** The same namespaced counter the route itself counts against. */
const limiter = makeIpRateLimiter(
  "address:",
  MAX_ADDRESS_LOOKUPS,
  ADDRESS_LOOKUP_LOCKOUT_MS,
);

const PROVIDER_REPLY = () =>
  new Response(
    JSON.stringify([
      {
        envelopeAddress: { summaryLine: "1 Test Street, London" },
        latitude: "51.50100",
        longitude: "-0.14158",
      },
    ]),
    { headers: { "content-type": "application/json" } },
  );

describeWithEnv("the address lookup route's limiter", { db: true }, () => {
  beforeEach(() => {
    settings.setForTest({
      address_lookup_api_key: "test-api-key",
      address_lookup_provider: "easypostcodes",
    });
  });

  afterEach(async () => {
    // The counter's row keys on the limiter's own prefix plus the IP.
    await execute("DELETE FROM login_attempts WHERE ip = ?", [
      await hmacHash("address:direct"),
    ]);
    settings.clearTestOverrides();
  });

  test("throttles a scanner session once the IP's lookups are spent", async () => {
    const { cookie } = await createTestScannerSession();
    for (let spent = 0; spent < MAX_ADDRESS_LOOKUPS; spent++) {
      await limiter.record("direct");
    }

    using _fetch = stubFetch(PROVIDER_REPLY);
    const response = await awaitTestRequest("/address-lookup?search=SW1A1AA", {
      cookie,
    });
    expect(response.status).toBe(429);
  });

  test("never throttles a staff session the same IP has spent", async () => {
    for (let spent = 0; spent < MAX_ADDRESS_LOOKUPS; spent++) {
      await limiter.record("direct");
    }

    using _fetch = stubFetch(PROVIDER_REPLY);
    const response = await awaitTestRequest("/address-lookup?search=SW1A1AA", {
      cookie: await testCookie(),
    });
    expect(response.status).toBe(200);
    expect((await response.json()).addresses).toEqual([
      "1 Test Street, London",
    ]);
  });

  test("a scanner session's own lookups count against the shared IP", async () => {
    const { cookie } = await createTestScannerSession();

    using _fetch = stubFetch(PROVIDER_REPLY);
    const first = await awaitTestRequest("/address-lookup?search=SW1A1AA", {
      cookie,
    });
    expect(first.status).toBe(200);

    // One recorded lookup from the request above: MAX-1 more spends the IP,
    // and the next scanner request meets the same lockout as anonymous use.
    for (let spent = 1; spent < MAX_ADDRESS_LOOKUPS; spent++) {
      await limiter.record("direct");
    }
    const last = await awaitTestRequest("/address-lookup?search=SW1A1AA", {
      cookie,
    });
    expect(last.status).toBe(429);
  });
});
