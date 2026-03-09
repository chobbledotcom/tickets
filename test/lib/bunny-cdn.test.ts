import { afterEach, beforeEach, describe, it as test } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { stub } from "@std/testing/mock";
import { bunnyCdnApi, validateCustomDomain } from "#lib/bunny-cdn.ts";
import {
  getBunnyApiKey,
  getBunnyPullZoneId,
  getCdnHostname,
  isBunnyCdnEnabled,
} from "#lib/config.ts";
import {
  getCustomDomainFromDb,
  getCustomDomainLastValidatedFromDb,
  updateCustomDomain,
  updateCustomDomainLastValidated,
} from "#lib/db/settings.ts";
import { createTestDb, resetDb, withMocks } from "#test-utils";

describe("bunny-cdn", () => {
  describe("isBunnyCdnEnabled", () => {
    const origApiKey = Deno.env.get("BUNNY_API_KEY");
    const origPullZoneId = Deno.env.get("BUNNY_PULL_ZONE_ID");

    afterEach(() => {
      if (origApiKey) Deno.env.set("BUNNY_API_KEY", origApiKey);
      else Deno.env.delete("BUNNY_API_KEY");
      if (origPullZoneId) Deno.env.set("BUNNY_PULL_ZONE_ID", origPullZoneId);
      else Deno.env.delete("BUNNY_PULL_ZONE_ID");
    });

    test("returns false when neither env var is set", () => {
      Deno.env.delete("BUNNY_API_KEY");
      Deno.env.delete("BUNNY_PULL_ZONE_ID");
      expect(isBunnyCdnEnabled()).toBe(false);
    });

    test("returns false when only BUNNY_API_KEY is set", () => {
      Deno.env.set("BUNNY_API_KEY", "test-key");
      Deno.env.delete("BUNNY_PULL_ZONE_ID");
      expect(isBunnyCdnEnabled()).toBe(false);
    });

    test("returns false when only BUNNY_PULL_ZONE_ID is set", () => {
      Deno.env.delete("BUNNY_API_KEY");
      Deno.env.set("BUNNY_PULL_ZONE_ID", "12345");
      expect(isBunnyCdnEnabled()).toBe(false);
    });

    test("returns true when both env vars are set", () => {
      Deno.env.set("BUNNY_API_KEY", "test-key");
      Deno.env.set("BUNNY_PULL_ZONE_ID", "12345");
      expect(isBunnyCdnEnabled()).toBe(true);
    });
  });

  describe("getCdnHostname", () => {
    const origDomain = Deno.env.get("ALLOWED_DOMAIN");

    afterEach(() => {
      if (origDomain) Deno.env.set("ALLOWED_DOMAIN", origDomain);
    });

    test("replaces .bunny.run with .b-cdn.net", () => {
      Deno.env.set("ALLOWED_DOMAIN", "mysite.bunny.run");
      expect(getCdnHostname()).toBe("mysite.b-cdn.net");
    });

    test("returns domain unchanged when not .bunny.run", () => {
      Deno.env.set("ALLOWED_DOMAIN", "example.com");
      expect(getCdnHostname()).toBe("example.com");
    });
  });

  describe("validateCustomDomain", () => {
    test("delegates to bunnyCdnApi.validateCustomDomain", async () => {
      const mockResult = { ok: true as const };
      const original = bunnyCdnApi.validateCustomDomain;
      bunnyCdnApi.validateCustomDomain = () => Promise.resolve(mockResult);
      try {
        const result = await validateCustomDomain("test.example.com");
        expect(result).toEqual(mockResult);
      } finally {
        bunnyCdnApi.validateCustomDomain = original;
      }
    });

    test("returns error from bunnyCdnApi", async () => {
      const mockResult = { ok: false as const, error: "test error" };
      const original = bunnyCdnApi.validateCustomDomain;
      bunnyCdnApi.validateCustomDomain = () => Promise.resolve(mockResult);
      try {
        const result = await validateCustomDomain("test.example.com");
        expect(result).toEqual(mockResult);
      } finally {
        bunnyCdnApi.validateCustomDomain = original;
      }
    });
  });

  describe("getBunnyApiKey / getBunnyPullZoneId", () => {
    const origApiKey = Deno.env.get("BUNNY_API_KEY");
    const origPullZoneId = Deno.env.get("BUNNY_PULL_ZONE_ID");

    afterEach(() => {
      if (origApiKey) Deno.env.set("BUNNY_API_KEY", origApiKey);
      else Deno.env.delete("BUNNY_API_KEY");
      if (origPullZoneId) Deno.env.set("BUNNY_PULL_ZONE_ID", origPullZoneId);
      else Deno.env.delete("BUNNY_PULL_ZONE_ID");
    });

    test("getBunnyApiKey returns the env var value", () => {
      Deno.env.set("BUNNY_API_KEY", "my-api-key");
      expect(getBunnyApiKey()).toBe("my-api-key");
    });

    test("getBunnyPullZoneId returns the env var value", () => {
      Deno.env.set("BUNNY_PULL_ZONE_ID", "99999");
      expect(getBunnyPullZoneId()).toBe("99999");
    });
  });

  describe("validateCustomDomain (real implementation)", () => {
    const origApiKey = Deno.env.get("BUNNY_API_KEY");
    const origPullZoneId = Deno.env.get("BUNNY_PULL_ZONE_ID");

    beforeEach(() => {
      Deno.env.set("BUNNY_API_KEY", "test-bunny-key");
      Deno.env.set("BUNNY_PULL_ZONE_ID", "12345");
    });

    afterEach(() => {
      if (origApiKey) Deno.env.set("BUNNY_API_KEY", origApiKey);
      else Deno.env.delete("BUNNY_API_KEY");
      if (origPullZoneId) Deno.env.set("BUNNY_PULL_ZONE_ID", origPullZoneId);
      else Deno.env.delete("BUNNY_PULL_ZONE_ID");
    });

    test("returns ok when both API calls succeed", async () => {
      await withMocks(
        () => stub(globalThis, "fetch", () => Promise.resolve(new Response(null, { status: 204 }))),
        async () => {
          const result = await bunnyCdnApi.validateCustomDomain("cdn.example.com");
          expect(result).toEqual({ ok: true });
        },
      );
    });

    test("sends correct requests to Bunny API", async () => {
      const calls: { url: string; init: RequestInit }[] = [];
      await withMocks(
        () => stub(globalThis, "fetch", (input: string | URL | Request, init?: RequestInit) => {
          calls.push({ url: String(input), init: init! });
          return Promise.resolve(new Response(null, { status: 204 }));
        }),
        async () => {
          await bunnyCdnApi.validateCustomDomain("cdn.example.com");
          expect(calls).toHaveLength(2);
          const addCall = calls.at(0)!;
          const sslCall = calls.at(1)!;
          expect(addCall.url).toBe("https://api.bunny.net/pullzone/12345/addHostname");
          expect(addCall.init.method).toBe("POST");
          expect(addCall.init.headers).toEqual({ AccessKey: "test-bunny-key", "Content-Type": "application/json" });
          expect(JSON.parse(addCall.init.body as string)).toEqual({ Hostname: "cdn.example.com" });
          expect(sslCall.url).toBe("https://api.bunny.net/pullzone/12345/setForceSSL");
          expect(JSON.parse(sslCall.init.body as string)).toEqual({ Hostname: "cdn.example.com", ForceSSL: true });
        },
      );
    });

    test("returns error when addHostname fails", async () => {
      await withMocks(
        () => stub(globalThis, "fetch", () =>
          Promise.resolve(new Response("Hostname already exists", { status: 400 }))),
        async () => {
          const result = await bunnyCdnApi.validateCustomDomain("cdn.example.com");
          expect(result).toEqual({ ok: false, error: "Add hostname failed (400): Hostname already exists" });
        },
      );
    });

    test("does not call setForceSSL when addHostname fails", async () => {
      let callCount = 0;
      await withMocks(
        () => stub(globalThis, "fetch", () => {
          callCount++;
          return Promise.resolve(new Response("Bad request", { status: 400 }));
        }),
        async () => {
          await bunnyCdnApi.validateCustomDomain("cdn.example.com");
          expect(callCount).toBe(1);
        },
      );
    });

    test("returns error when setForceSSL fails", async () => {
      let callCount = 0;
      await withMocks(
        () => stub(globalThis, "fetch", () => {
          callCount++;
          if (callCount === 1) return Promise.resolve(new Response(null, { status: 204 }));
          return Promise.resolve(new Response("SSL error", { status: 500 }));
        }),
        async () => {
          const result = await bunnyCdnApi.validateCustomDomain("cdn.example.com");
          expect(result).toEqual({ ok: false, error: "Set force SSL failed (500): SSL error" });
        },
      );
    });
  });

  describe("custom domain settings", () => {
    beforeEach(async () => {
      await createTestDb();
    });

    afterEach(() => {
      resetDb();
    });

    test("getCustomDomainFromDb returns null when not set", async () => {
      expect(await getCustomDomainFromDb()).toBeNull();
    });

    test("updateCustomDomain stores and retrieves domain", async () => {
      await updateCustomDomain("tickets.example.com");
      expect(await getCustomDomainFromDb()).toBe("tickets.example.com");
    });

    test("updateCustomDomain with empty string clears domain", async () => {
      await updateCustomDomain("tickets.example.com");
      await updateCustomDomain("");
      expect(await getCustomDomainFromDb()).toBeNull();
    });

    test("getCustomDomainLastValidatedFromDb returns null when not set", async () => {
      expect(await getCustomDomainLastValidatedFromDb()).toBeNull();
    });

    test("updateCustomDomainLastValidated stores a timestamp", async () => {
      await updateCustomDomainLastValidated();
      const value = await getCustomDomainLastValidatedFromDb();
      expect(value).not.toBeNull();
      // Should be a valid ISO 8601 date
      expect(new Date(value!).toISOString()).toBe(value);
    });
  });
});
