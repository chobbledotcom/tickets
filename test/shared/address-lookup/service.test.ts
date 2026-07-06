/**
 * Address lookup service: normalisation gating, cache-first reads, provider
 * fetch + cache fill on a miss, and generic (logged) provider failures.
 */

import { expect } from "@std/expect";
import { beforeEach, it as test } from "@std/testing/bdd";
import { lookupAddresses } from "#shared/address-lookup/service.ts";
import {
  computeAddressSearchIndex,
  getCachedAddresses,
  storeCachedAddresses,
} from "#shared/db/address-cache.ts";
import { settings } from "#shared/db/settings.ts";
import { describeWithEnv } from "#test-utils";
import { setupErrorSpy } from "#test-utils/error-spy.ts";
import { setupFetchStub } from "#test-utils/fetch-stub.ts";

const PROVIDER_BODY = JSON.stringify([
  {
    envelopeAddress: { summaryLine: "10 Downing Street, LONDON, SW1A 2AA" },
    latitude: "51.503396",
    longitude: "-0.127640",
  },
]);

const DOWNING_STREET_MATCH = {
  lat: "51.503396",
  line: "10 Downing Street, LONDON, SW1A 2AA",
  lng: "-0.127640",
};

describeWithEnv("address lookup service", { db: true }, () => {
  const { callCount, stubFetch } = setupFetchStub();
  const errors = setupErrorSpy();

  beforeEach(() => {
    settings.setForTest({ address_lookup_api_key: "test-api-key" });
  });

  test("rejects a search the provider's rules can't normalise", async () => {
    stubFetch(() => Promise.reject(new Error("should not be called")));
    const outcome = await lookupAddresses("easypostcodes", "not a postcode");
    expect(outcome).toEqual({
      error: "That doesn't look like a valid postcode",
      ok: false,
    });
    expect(callCount()).toBe(0);
  });

  test("fetches on a miss, using the stored API key, and caches the result", async () => {
    let sentKey: string | null = null;
    stubFetch((_url, init) => {
      sentKey = new Headers(init?.headers).get("Key");
      return Promise.resolve(new Response(PROVIDER_BODY));
    });

    const outcome = await lookupAddresses("easypostcodes", "sw1a2aa");

    expect(outcome).toEqual({
      addresses: [DOWNING_STREET_MATCH],
      ok: true,
    });
    expect(sentKey).toBe("test-api-key");
    // The result was cached under the normalised search's blind index.
    const index = await computeAddressSearchIndex("easypostcodes", "SW1A 2AA");
    expect(await getCachedAddresses(index)).toEqual([DOWNING_STREET_MATCH]);
  });

  test("serves a cached search without touching the provider", async () => {
    stubFetch(() => Promise.reject(new Error("should not be called")));
    const index = await computeAddressSearchIndex("easypostcodes", "SW1A 2AA");
    await storeCachedAddresses(index, [
      { lat: "51.5", line: "Cached Address Line", lng: "-0.1" },
    ]);

    // Differently-formatted input normalises to the same cached search.
    const outcome = await lookupAddresses("easypostcodes", "  sw1a 2aa ");

    expect(outcome).toEqual({
      addresses: [{ lat: "51.5", line: "Cached Address Line", lng: "-0.1" }],
      ok: true,
    });
    expect(callCount()).toBe(0);
  });

  test("serves a cached empty result without re-fetching", async () => {
    stubFetch(() => Promise.reject(new Error("should not be called")));
    const index = await computeAddressSearchIndex("easypostcodes", "ZZ99 9ZZ");
    await storeCachedAddresses(index, []);

    const outcome = await lookupAddresses("easypostcodes", "zz999zz");

    expect(outcome).toEqual({ addresses: [], ok: true });
    expect(callCount()).toBe(0);
  });

  test("a provider failure logs the detail and reports a generic error", async () => {
    stubFetch(() => Promise.resolve(new Response("denied", { status: 403 })));

    const outcome = await lookupAddresses("easypostcodes", "SW1A 2AA");

    expect(outcome).toEqual({
      error: "Address lookup failed — please try again or type your address",
      ok: false,
    });
    expect(errors.lastMessage()).toContain("E_ADDRESS_LOOKUP");
    // Failures are never cached — the next attempt retries the provider.
    const index = await computeAddressSearchIndex("easypostcodes", "SW1A 2AA");
    expect(await getCachedAddresses(index)).toBeNull();
  });
});
