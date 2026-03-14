import { afterEach, beforeEach, describe, it as test } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { stub } from "@std/testing/mock";
import { bunnyCdnApi, validateCustomDomain } from "#lib/bunny-cdn.ts";
import {
  getBunnyApiKey,
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

    afterEach(() => {
      if (origApiKey) Deno.env.set("BUNNY_API_KEY", origApiKey);
      else Deno.env.delete("BUNNY_API_KEY");
    });

    test("returns false when BUNNY_API_KEY is not set", () => {
      Deno.env.delete("BUNNY_API_KEY");
      expect(isBunnyCdnEnabled()).toBe(false);
    });

    test("returns true when BUNNY_API_KEY is set", () => {
      Deno.env.set("BUNNY_API_KEY", "test-key");
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

  describe("getBunnyApiKey", () => {
    const origApiKey = Deno.env.get("BUNNY_API_KEY");

    afterEach(() => {
      if (origApiKey) Deno.env.set("BUNNY_API_KEY", origApiKey);
      else Deno.env.delete("BUNNY_API_KEY");
    });

    test("getBunnyApiKey returns the env var value", () => {
      Deno.env.set("BUNNY_API_KEY", "my-api-key");
      expect(getBunnyApiKey()).toBe("my-api-key");
    });
  });

  describe("findPullZoneId", () => {
    const origApiKey = Deno.env.get("BUNNY_API_KEY");
    const origDomain = Deno.env.get("ALLOWED_DOMAIN");

    beforeEach(() => {
      Deno.env.set("BUNNY_API_KEY", "test-bunny-key");
      Deno.env.set("ALLOWED_DOMAIN", "mysite.bunny.run");
    });

    afterEach(() => {
      if (origApiKey) Deno.env.set("BUNNY_API_KEY", origApiKey);
      else Deno.env.delete("BUNNY_API_KEY");
      if (origDomain) Deno.env.set("ALLOWED_DOMAIN", origDomain);
      else Deno.env.delete("ALLOWED_DOMAIN");
    });

    test("returns pull zone ID when matching hostname is found", async () => {
      await withMocks(
        () =>
          stub(globalThis, "fetch", () =>
            Promise.resolve(
              new Response(
                JSON.stringify({
                  Items: [
                    { Id: 111, Hostnames: [{ Value: "other.b-cdn.net" }] },
                    { Id: 222, Hostnames: [{ Value: "mysite.b-cdn.net" }] },
                  ],
                  HasMoreItems: false,
                }),
              ),
            )),
        async () => {
          const result = await bunnyCdnApi.findPullZoneId();
          expect(result).toEqual({ ok: true, id: 222 });
        },
      );
    });

    test("sends correct request to Bunny API", async () => {
      const calls: { url: string; init: RequestInit | undefined }[] = [];
      await withMocks(
        () =>
          stub(
            globalThis,
            "fetch",
            (input: string | URL | Request, init?: RequestInit) => {
              calls.push({ url: String(input), init });
              return Promise.resolve(
                new Response(
                  JSON.stringify({
                    Items: [
                      { Id: 42, Hostnames: [{ Value: "mysite.b-cdn.net" }] },
                    ],
                    HasMoreItems: false,
                  }),
                ),
              );
            },
          ),
        async () => {
          await bunnyCdnApi.findPullZoneId();
          expect(calls).toHaveLength(1);
          expect(calls.at(0)!.url).toBe(
            "https://api.bunny.net/pullzone?search=mysite.b-cdn.net",
          );
          expect(calls.at(0)!.init!.headers).toEqual({
            AccessKey: "test-bunny-key",
          });
        },
      );
    });

    test("returns error when no matching pull zone is found", async () => {
      await withMocks(
        () =>
          stub(globalThis, "fetch", () =>
            Promise.resolve(
              new Response(
                JSON.stringify({
                  Items: [
                    { Id: 111, Hostnames: [{ Value: "other.b-cdn.net" }] },
                  ],
                  HasMoreItems: false,
                }),
              ),
            )),
        async () => {
          const result = await bunnyCdnApi.findPullZoneId();
          expect(result).toEqual({
            ok: false,
            error: "No pull zone found with hostname mysite.b-cdn.net",
          });
        },
      );
    });

    test("returns error when API request fails", async () => {
      await withMocks(
        () =>
          stub(globalThis, "fetch", () =>
            Promise.resolve(
              new Response("Unauthorized", { status: 401 }),
            )),
        async () => {
          const result = await bunnyCdnApi.findPullZoneId();
          expect(result).toEqual({
            ok: false,
            error: "List pull zones failed (401): Unauthorized",
          });
        },
      );
    });

    test("returns errorKey from JSON error response", async () => {
      const jsonBody = JSON.stringify({
        ErrorKey: "pullzone.rate_limited",
        Message: "Too many requests.",
      });
      await withMocks(
        () =>
          stub(globalThis, "fetch", () =>
            Promise.resolve(
              new Response(jsonBody, { status: 429 }),
            )),
        async () => {
          const result = await bunnyCdnApi.findPullZoneId();
          expect(result).toEqual({
            ok: false,
            error: "List pull zones failed (429): Too many requests.",
            errorKey: "pullzone.rate_limited",
          });
        },
      );
    });
  });

  describe("validateCustomDomain (real implementation)", () => {
    const origApiKey = Deno.env.get("BUNNY_API_KEY");
    const origDomain = Deno.env.get("ALLOWED_DOMAIN");

    beforeEach(() => {
      Deno.env.set("BUNNY_API_KEY", "test-bunny-key");
      Deno.env.set("ALLOWED_DOMAIN", "mysite.bunny.run");
    });

    afterEach(() => {
      if (origApiKey) Deno.env.set("BUNNY_API_KEY", origApiKey);
      else Deno.env.delete("BUNNY_API_KEY");
      if (origDomain) Deno.env.set("ALLOWED_DOMAIN", origDomain);
      else Deno.env.delete("ALLOWED_DOMAIN");
    });

    /** Helper: stub findPullZoneId to return a fixed ID */
    const withFixedPullZoneId = (
      fn: () => Promise<void>,
    ): Promise<void> => {
      const original = bunnyCdnApi.findPullZoneId;
      bunnyCdnApi.findPullZoneId = () =>
        Promise.resolve({ ok: true as const, id: 12345 });
      return fn().finally(() => {
        bunnyCdnApi.findPullZoneId = original;
      });
    };

    test("returns ok when all API calls succeed", async () => {
      await withFixedPullZoneId(async () => {
        await withMocks(
          () =>
            stub(
              globalThis,
              "fetch",
              () => Promise.resolve(new Response(null, { status: 204 })),
            ),
          async () => {
            const result = await bunnyCdnApi.validateCustomDomain(
              "cdn.example.com",
            );
            expect(result).toEqual({ ok: true });
          },
        );
      });
    });

    test("sends correct requests to Bunny API", async () => {
      await withFixedPullZoneId(async () => {
        const calls: { url: string; init: RequestInit | undefined }[] = [];
        await withMocks(
          () =>
            stub(
              globalThis,
              "fetch",
              (input: string | URL | Request, init?: RequestInit) => {
                calls.push({ url: String(input), init });
                return Promise.resolve(new Response(null, { status: 204 }));
              },
            ),
          async () => {
            await bunnyCdnApi.validateCustomDomain("cdn.example.com");
            expect(calls).toHaveLength(3);
            const addCall = calls.at(0)!;
            const certCall = calls.at(1)!;
            const sslCall = calls.at(2)!;
            expect(addCall.url).toBe(
              "https://api.bunny.net/pullzone/12345/addHostname",
            );
            expect(addCall.init!.method).toBe("POST");
            expect(addCall.init!.headers).toEqual({
              AccessKey: "test-bunny-key",
              "Content-Type": "application/json",
            });
            expect(JSON.parse(addCall.init!.body as string)).toEqual({
              Hostname: "cdn.example.com",
            });
            expect(certCall.url).toBe(
              "https://api.bunny.net/pullzone/loadFreeCertificate?hostname=cdn.example.com",
            );
            expect(certCall.init!.method).toBe("GET");
            expect(certCall.init!.headers).toEqual({
              AccessKey: "test-bunny-key",
            });
            expect(sslCall.url).toBe(
              "https://api.bunny.net/pullzone/12345/setForceSSL",
            );
            expect(JSON.parse(sslCall.init!.body as string)).toEqual({
              Hostname: "cdn.example.com",
              ForceSSL: true,
            });
          },
        );
      });
    });

    test("returns error when findPullZoneId fails", async () => {
      const original = bunnyCdnApi.findPullZoneId;
      bunnyCdnApi.findPullZoneId = () =>
        Promise.resolve({
          ok: false as const,
          error: "No pull zone found with hostname mysite.b-cdn.net",
        });
      try {
        const result = await bunnyCdnApi.validateCustomDomain(
          "cdn.example.com",
        );
        expect(result).toEqual({
          ok: false,
          error: "No pull zone found with hostname mysite.b-cdn.net",
        });
      } finally {
        bunnyCdnApi.findPullZoneId = original;
      }
    });

    test("returns error when addHostname fails", async () => {
      await withFixedPullZoneId(async () => {
        await withMocks(
          () =>
            stub(globalThis, "fetch", () =>
              Promise.resolve(
                new Response("Hostname already exists", { status: 400 }),
              )),
          async () => {
            const result = await bunnyCdnApi.validateCustomDomain(
              "cdn.example.com",
            );
            expect(result).toEqual({
              ok: false,
              error: "Add hostname failed (400): Hostname already exists",
            });
          },
        );
      });
    });

    test("extracts Message from JSON error response", async () => {
      await withFixedPullZoneId(async () => {
        const jsonBody = JSON.stringify({
          ErrorKey: "pullzone.some_other_error",
          Field: "Hostname",
          Message: "Something went wrong.",
        });
        await withMocks(
          () =>
            stub(globalThis, "fetch", () =>
              Promise.resolve(
                new Response(jsonBody, { status: 400 }),
              )),
          async () => {
            const result = await bunnyCdnApi.validateCustomDomain(
              "cdn.example.com",
            );
            expect(result).toEqual({
              ok: false,
              error: "Add hostname failed (400): Something went wrong.",
              errorKey: "pullzone.some_other_error",
            });
          },
        );
      });
    });

    test("treats hostname_already_registered as success", async () => {
      await withFixedPullZoneId(async () => {
        let callCount = 0;
        const jsonBody = JSON.stringify({
          ErrorKey: "pullzone.hostname_already_registered",
          Field: "Hostname",
          Message: "The hostname is already registered.",
        });
        await withMocks(
          () =>
            stub(globalThis, "fetch", () => {
              callCount++;
              if (callCount === 1) {
                return Promise.resolve(
                  new Response(jsonBody, { status: 400 }),
                );
              }
              return Promise.resolve(new Response(null, { status: 204 }));
            }),
          async () => {
            const result = await bunnyCdnApi.validateCustomDomain(
              "cdn.example.com",
            );
            expect(result).toEqual({ ok: true });
            expect(callCount).toBe(3);
          },
        );
      });
    });

    test("does not call setForceSSL when addHostname fails", async () => {
      await withFixedPullZoneId(async () => {
        let callCount = 0;
        await withMocks(
          () =>
            stub(globalThis, "fetch", () => {
              callCount++;
              return Promise.resolve(
                new Response("Bad request", { status: 400 }),
              );
            }),
          async () => {
            await bunnyCdnApi.validateCustomDomain("cdn.example.com");
            expect(callCount).toBe(1);
          },
        );
      });
    });

    test("returns error when loadFreeCertificate fails", async () => {
      await withFixedPullZoneId(async () => {
        let callCount = 0;
        await withMocks(
          () =>
            stub(globalThis, "fetch", () => {
              callCount++;
              if (callCount === 1) {
                return Promise.resolve(new Response(null, { status: 204 }));
              }
              return Promise.resolve(
                new Response("Certificate error", { status: 400 }),
              );
            }),
          async () => {
            const result = await bunnyCdnApi.validateCustomDomain(
              "cdn.example.com",
            );
            expect(result).toEqual({
              ok: false,
              error: "Load free certificate failed (400): Certificate error",
            });
            expect(callCount).toBe(2);
          },
        );
      });
    });

    test("does not call setForceSSL when loadFreeCertificate fails", async () => {
      await withFixedPullZoneId(async () => {
        let callCount = 0;
        await withMocks(
          () =>
            stub(globalThis, "fetch", () => {
              callCount++;
              if (callCount <= 1) {
                return Promise.resolve(new Response(null, { status: 204 }));
              }
              return Promise.resolve(
                new Response("Certificate error", { status: 400 }),
              );
            }),
          async () => {
            await bunnyCdnApi.validateCustomDomain("cdn.example.com");
            expect(callCount).toBe(2);
          },
        );
      });
    });

    test("returns error when setForceSSL fails", async () => {
      await withFixedPullZoneId(async () => {
        let callCount = 0;
        await withMocks(
          () =>
            stub(globalThis, "fetch", () => {
              callCount++;
              if (callCount <= 2) {
                return Promise.resolve(new Response(null, { status: 204 }));
              }
              return Promise.resolve(
                new Response("SSL error", { status: 500 }),
              );
            }),
          async () => {
            const result = await bunnyCdnApi.validateCustomDomain(
              "cdn.example.com",
            );
            expect(result).toEqual({
              ok: false,
              error: "Set force SSL failed (500): SSL error",
            });
          },
        );
      });
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
