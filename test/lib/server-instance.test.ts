/**
 * Tests for the inter-instance machine endpoint (POST /instance/site-credentials).
 *
 * The main/builder instance returns every built site's read-only DB credentials
 * to a caller holding MAIN_INSTANCE_KEY, so the upgrade workflow can back each
 * site up before deploying. Disabled (404) unless the key is set; 401 on a bad
 * key; only sites with a script id and credentials are returned.
 */

import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { handleRequest } from "#routes";
import { insertBuiltSite, type UpdateTier } from "#shared/db/built-sites.ts";
import { describeWithEnv, mockRequest, setTestEnv } from "#test-utils";

const KEY = "instance-key-0123456789abcdef0123456789abcdef";

/** POST /instance/site-credentials with optional headers and `?tier=`. */
const post = (
  headers?: Record<string, string>,
  tier?: string,
): Promise<Response> =>
  handleRequest(
    mockRequest(
      tier === undefined
        ? "/instance/site-credentials"
        : `/instance/site-credentials?tier=${tier}`,
      { headers, method: "POST" },
    ),
  );

/** Sorted site names from a 200 credentials response. */
const siteNames = async (response: Response): Promise<string[]> => {
  const body = (await response.json()) as { sites: { name: string }[] };
  return body.sites.map((site) => site.name).sort();
};

/** One eligible site (script id + read-only creds) per update channel. */
const TIERED_SITES: ReadonlyArray<[name: string, tier: UpdateTier]> = [
  ["AlphaSite", "alpha"],
  ["BetaSite", "beta"],
  ["ReleaseSite", "release"],
];

const seedTieredFleet = async (): Promise<void> => {
  for (const [name, tier] of TIERED_SITES) {
    await insertBuiltSite(
      name,
      `${tier}.b-cdn.net`,
      `libsql://${tier}`,
      `tok-${tier}`,
      false,
      `script-${tier}`,
      tier,
    );
  }
};

/** Run `fn` with the credentials endpoint enabled and a one-per-channel fleet seeded. */
const withTieredFleet = async (fn: () => Promise<void>): Promise<void> => {
  const restore = setTestEnv({ MAIN_INSTANCE_KEY: KEY });
  try {
    await seedTieredFleet();
    await fn();
  } finally {
    restore();
  }
};

const auth = { authorization: `Bearer ${KEY}` };

describeWithEnv("server (instance site-credentials)", { db: true }, () => {
  test("returns 404 when MAIN_INSTANCE_KEY is not configured", async () => {
    const response = await post({ authorization: `Bearer ${KEY}` });
    expect(response.status).toBe(404);
  });

  test("returns 401 when the bearer key is missing", async () => {
    const restore = setTestEnv({ MAIN_INSTANCE_KEY: KEY });
    try {
      expect((await post()).status).toBe(401);
    } finally {
      restore();
    }
  });

  test("returns 401 when the bearer key is wrong", async () => {
    const restore = setTestEnv({ MAIN_INSTANCE_KEY: KEY });
    try {
      const response = await post({ authorization: "Bearer not-the-key" });
      expect(response.status).toBe(401);
    } finally {
      restore();
    }
  });

  test("returns read-only credentials for sites that have them", async () => {
    const restore = setTestEnv({ MAIN_INSTANCE_KEY: KEY });
    try {
      await insertBuiltSite(
        "Acme",
        "acme.b-cdn.net",
        "libsql://acme.lite.bunnydb.net",
        "ro-token-acme",
        false,
        "script-acme",
      );
      // A half-provisioned site (no script id / credentials) is omitted.
      await insertBuiltSite("Pending", "pending.b-cdn.net");

      const response = await post({ authorization: `Bearer ${KEY}` });
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({
        sites: [
          {
            dbToken: "ro-token-acme",
            dbUrl: "libsql://acme.lite.bunnydb.net",
            name: "Acme",
            scriptId: "script-acme",
          },
        ],
        tier: "release",
      });
    } finally {
      restore();
    }
  });

  describe("tier filtering", () => {
    test("an alpha deploy returns only alpha sites", () =>
      withTieredFleet(async () => {
        const response = await post(auth, "alpha");
        expect(response.status).toBe(200);
        expect(await siteNames(response)).toEqual(["AlphaSite"]);
      }));

    test("a beta deploy returns beta and alpha sites", () =>
      withTieredFleet(async () => {
        const response = await post(auth, "beta");
        expect(response.status).toBe(200);
        expect(await siteNames(response)).toEqual(["AlphaSite", "BetaSite"]);
      }));

    test("a release deploy returns the whole fleet", () =>
      withTieredFleet(async () => {
        const response = await post(auth, "release");
        expect(response.status).toBe(200);
        expect(await siteNames(response)).toEqual([
          "AlphaSite",
          "BetaSite",
          "ReleaseSite",
        ]);
      }));

    test("omitting the tier defaults to release (the whole fleet)", () =>
      withTieredFleet(async () => {
        const response = await post(auth);
        expect(response.status).toBe(200);
        expect(await siteNames(response)).toEqual([
          "AlphaSite",
          "BetaSite",
          "ReleaseSite",
        ]);
      }));

    test("an empty tier param defaults to release", () =>
      withTieredFleet(async () => {
        const response = await post(auth, "");
        expect(response.status).toBe(200);
        expect(await siteNames(response)).toEqual([
          "AlphaSite",
          "BetaSite",
          "ReleaseSite",
        ]);
      }));

    test("an unrecognised tier is rejected with 400", () =>
      withTieredFleet(async () => {
        const response = await post(auth, "stable");
        expect(response.status).toBe(400);
        expect(await response.json()).toEqual({ error: "invalid_tier" });
      }));

    test("echoes the applied tier so the caller can confirm filtering", () =>
      withTieredFleet(async () => {
        const beta = (await (await post(auth, "beta")).json()) as {
          tier: string;
        };
        expect(beta.tier).toBe("beta");
        // A tier-less call resolves to the release default and says so.
        const fallback = (await (await post(auth)).json()) as { tier: string };
        expect(fallback.tier).toBe("release");
      }));
  });
});
