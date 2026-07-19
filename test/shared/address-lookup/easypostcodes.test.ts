/**
 * EasyPostcodes provider: UK postcode normalisation, response parsing, and
 * the API fetch (stubbed at globalThis.fetch).
 */

import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import {
  EASYPOSTCODES_PROVIDER,
  fetchEasypostcodesAddresses,
  normaliseUkPostcode,
  parseEasypostcodesBody,
} from "#shared/address-lookup/easypostcodes.ts";
import { stubFetch } from "#test-utils/fetch-stub.ts";

describe("normaliseUkPostcode", () => {
  // Every Royal Mail outward format: A9, A99, AA9, AA99, A9A, AA9A.
  const valid: [string, string][] = [
    ["m1 1ae", "M1 1AE"],
    ["b33 8th", "B33 8TH"],
    ["cr2 6xh", "CR2 6XH"],
    ["dn55 1pt", "DN55 1PT"],
    ["w1a 0ax", "W1A 0AX"],
    ["ec1a 1bb", "EC1A 1BB"],
    ["sw1a1aa", "SW1A 1AA"],
    ["  SW1A - 1AA  ", "SW1A 1AA"],
  ];
  for (const [raw, expected] of valid) {
    test(`normalises ${JSON.stringify(raw)} to "${expected}"`, () => {
      expect(normaliseUkPostcode(raw)).toBe(expected);
    });
  }

  const invalid = [
    "",
    "   ",
    "SW1A",
    "SW1A 1A",
    "SW1A 1AAA",
    "1W1A 1AA",
    "SWIA 1A!",
    "not a postcode",
    "123 456",
  ];
  for (const raw of invalid) {
    test(`rejects ${JSON.stringify(raw)}`, () => {
      expect(normaliseUkPostcode(raw)).toBeNull();
    });
  }
});

describe("parseEasypostcodesBody", () => {
  test("extracts each address's summary line and coordinates", () => {
    const body = JSON.stringify([
      {
        envelopeAddress: { summaryLine: "Flat 9, 16 Netherkirkgate" },
        latitude: "57.147740",
        longitude: "-2.096323",
      },
      { envelopeAddress: { summaryLine: "10 Downing Street" } },
    ]);
    expect(parseEasypostcodesBody(body)).toEqual([
      { lat: "57.147740", line: "Flat 9, 16 Netherkirkgate", lng: "-2.096323" },
      { lat: "", line: "10 Downing Street", lng: "" },
    ]);
  });

  test("skips entries with no envelope address", () => {
    const body = JSON.stringify([
      { udprn: "16" },
      { envelopeAddress: { summaryLine: "10 Downing Street" } },
    ]);
    expect(parseEasypostcodesBody(body)).toEqual([
      { lat: "", line: "10 Downing Street", lng: "" },
    ]);
  });

  test("half a location (latitude without longitude) reads as unlocated", () => {
    const body = JSON.stringify([
      {
        envelopeAddress: { summaryLine: "10 Downing Street" },
        latitude: "51.503396",
      },
    ]);
    expect(parseEasypostcodesBody(body)).toEqual([
      { lat: "", line: "10 Downing Street", lng: "" },
    ]);
  });

  test("returns an empty list for an empty array", () => {
    expect(parseEasypostcodesBody("[]")).toEqual([]);
  });

  test("returns null for invalid JSON", () => {
    expect(parseEasypostcodesBody("not json")).toBeNull();
  });

  test("returns null for a non-array body", () => {
    expect(parseEasypostcodesBody('{"error":"nope"}')).toBeNull();
  });

  test("returns null when an entry is not the documented shape", () => {
    expect(parseEasypostcodesBody('[{"envelopeAddress":5}]')).toBeNull();
  });
});

describe("fetchEasypostcodesAddresses", () => {
  test("sends the API key header and the encoded postcode", async () => {
    let captured: { url: string; key: string | null } | null = null;
    using _fetch = stubFetch((url, init) => {
      captured = { key: new Headers(init?.headers).get("Key"), url };
      return Promise.resolve(new Response("[]"));
    });

    const result = await fetchEasypostcodesAddresses("SW1A 1AA", "secret-key");

    expect(result).toEqual({ ok: true, value: [] });
    // includeGeo asks the API to return each address's latitude/longitude.
    expect(captured).toEqual({
      key: "secret-key",
      url: "https://api.easypostcodes.com/addresses/SW1A%201AA?includeGeo=true",
    });
  });

  test("returns the matches from a successful response", async () => {
    using _fetch = stubFetch(
      new Response(
        JSON.stringify([
          {
            envelopeAddress: { summaryLine: "10 Downing Street" },
            latitude: "51.503396",
            longitude: "-0.127640",
          },
        ]),
      ),
    );

    expect(await fetchEasypostcodesAddresses("SW1A 1AA", "k")).toEqual({
      ok: true,
      value: [
        { lat: "51.503396", line: "10 Downing Street", lng: "-0.127640" },
      ],
    });
  });

  test("treats a 404 as no matches, not a failure", async () => {
    using _fetch = stubFetch(new Response("Not Found", { status: 404 }));
    expect(await fetchEasypostcodesAddresses("ZZ99 9ZZ", "k")).toEqual({
      ok: true,
      value: [],
    });
  });

  test("reports a provider error with its status", async () => {
    using _fetch = stubFetch(new Response("denied", { status: 403 }));
    const result = await fetchEasypostcodesAddresses("SW1A 1AA", "bad-key");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBe("EasyPostcodes lookup failed (403): denied");
    }
  });

  test("reports a network failure without throwing", async () => {
    using _fetch = stubFetch(new Error("connection refused"));
    const result = await fetchEasypostcodesAddresses("SW1A 1AA", "k");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("connection refused");
  });

  test("reports an unexpected response shape as a failure", async () => {
    using _fetch = stubFetch(new Response('{"weird":true}'));
    const result = await fetchEasypostcodesAddresses("SW1A 1AA", "k");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("unexpected response");
  });
});

describe("EASYPOSTCODES_PROVIDER", () => {
  test("wires the UK normaliser and fetch into the definition", () => {
    expect(EASYPOSTCODES_PROVIDER.label).toBe("EasyPostcodes");
    expect(EASYPOSTCODES_PROVIDER.normaliseSearch).toBe(normaliseUkPostcode);
    expect(EASYPOSTCODES_PROVIDER.fetchAddresses).toBe(
      fetchEasypostcodesAddresses,
    );
  });

  test("names a real message key for the search box label", () => {
    // The panel template t()s this — a broken key throws at render time.
    expect(EASYPOSTCODES_PROVIDER.searchLabelKey).toBe(
      "address_lookup.search.postcode",
    );
  });
});
