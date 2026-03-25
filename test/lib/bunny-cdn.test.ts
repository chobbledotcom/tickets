import { expect } from "@std/expect";
import { afterEach, beforeEach, describe, it as test } from "@std/testing/bdd";
import { stub } from "@std/testing/mock";
import {
  bunnyCdnApi,
  checkSubdomainAvailable,
  registerBunnySubdomain,
  validateCustomDomain,
} from "#lib/bunny-cdn.ts";
import {
  getCdnHostname,
  isBunnyCdnEnabled,
  isBunnyDnsEnabled,
  resetEffectiveDomain,
  setEffectiveDomainForTest,
} from "#lib/config.ts";
import { settings } from "#lib/db/settings.ts";
import { describeWithEnv, withMockBunnyCdnApi, withMocks } from "#test-utils";

/** Stub fetch to return a JSON response with given body */
const stubFetchJson = (body: unknown) =>
  stub(globalThis, "fetch", () =>
    Promise.resolve(new Response(JSON.stringify(body))),
  );

/** Stub fetch that records calls and returns a fixed response */
const stubFetchWithRecorder = (
  calls: { url: string; init: RequestInit | undefined }[],
  responseInit?: ResponseInit,
) =>
  stub(
    globalThis,
    "fetch",
    (input: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(input), init });
      return Promise.resolve(
        new Response(null, { status: 204, ...responseInit }),
      );
    },
  );

/** Build a pull zone Items response */
const pullZoneResponse = (
  items: { Id: number; hostname: string }[],
  hasMore = false,
) => ({
  Items: items.map(({ Id, hostname }) => ({
    Id,
    Hostnames: [{ Value: hostname }],
  })),
  HasMoreItems: hasMore,
});

describeWithEnv(
  "isBunnyCdnEnabled",
  { env: { BUNNY_API_KEY: undefined } },
  () => {
    test("returns false when BUNNY_API_KEY is not set", () => {
      expect(isBunnyCdnEnabled()).toBe(false);
    });

    test("returns true when BUNNY_API_KEY is set", () => {
      Deno.env.set("BUNNY_API_KEY", "test-key");
      expect(isBunnyCdnEnabled()).toBe(true);
    });
  },
);

describe("getCdnHostname", () => {
  afterEach(() => resetEffectiveDomain());

  test("replaces .bunny.run with .b-cdn.net", () => {
    setEffectiveDomainForTest("mysite.bunny.run");
    expect(getCdnHostname()).toBe("mysite.b-cdn.net");
  });

  test("returns domain unchanged when not .bunny.run", () => {
    setEffectiveDomainForTest("example.com");
    expect(getCdnHostname()).toBe("example.com");
  });
});

describe("validateCustomDomain", () => {
  test("delegates to bunnyCdnApi.validateCustomDomain", async () => {
    await withMockBunnyCdnApi(
      { validateCustomDomain: () => Promise.resolve({ ok: true as const }) },
      async () => {
        const result = await validateCustomDomain("test.example.com");
        expect(result).toEqual({ ok: true });
      },
    );
  });
});

describeWithEnv(
  "findPullZoneId",
  { env: { BUNNY_API_KEY: "test-bunny-key" } },
  () => {
    beforeEach(() => setEffectiveDomainForTest("mysite.bunny.run"));
    afterEach(() => resetEffectiveDomain());

    test("returns pull zone ID when matching hostname is found", async () => {
      await withMocks(
        () =>
          stubFetchJson(
            pullZoneResponse([
              { Id: 111, hostname: "other.b-cdn.net" },
              { Id: 222, hostname: "mysite.b-cdn.net" },
            ]),
          ),
        async () => {
          const result = await bunnyCdnApi.findPullZoneId();
          expect(result).toEqual({ ok: true, id: 222 });
        },
      );
    });

    test("sends correct request to Bunny API", async () => {
      const calls: { url: string; init: RequestInit | undefined }[] = [];
      const response = pullZoneResponse([
        { Id: 42, hostname: "mysite.b-cdn.net" },
      ]);
      await withMocks(
        () =>
          stub(
            globalThis,
            "fetch",
            (input: string | URL | Request, init?: RequestInit) => {
              calls.push({ url: String(input), init });
              return Promise.resolve(new Response(JSON.stringify(response)));
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
          stubFetchJson(
            pullZoneResponse([{ Id: 111, hostname: "other.b-cdn.net" }]),
          ),
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
            Promise.resolve(new Response("Unauthorized", { status: 401 })),
          ),
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
            Promise.resolve(new Response(jsonBody, { status: 429 })),
          ),
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
  },
);

describeWithEnv(
  "validateCustomDomain (real implementation)",
  { env: { BUNNY_API_KEY: "test-bunny-key" } },
  () => {
    beforeEach(() => setEffectiveDomainForTest("mysite.bunny.run"));
    afterEach(() => resetEffectiveDomain());

    const fixedPullZone = {
      findPullZoneId: () => Promise.resolve({ ok: true as const, id: 12345 }),
    };

    test("returns ok when all API calls succeed", async () => {
      await withMockBunnyCdnApi(fixedPullZone, async () => {
        await withMocks(
          () =>
            stub(globalThis, "fetch", () =>
              Promise.resolve(new Response(null, { status: 204 })),
            ),
          async () => {
            const result =
              await bunnyCdnApi.validateCustomDomain("cdn.example.com");
            expect(result).toEqual({ ok: true });
          },
        );
      });
    });

    test("sends correct requests to Bunny API", async () => {
      await withMockBunnyCdnApi(fixedPullZone, async () => {
        const calls: { url: string; init: RequestInit | undefined }[] = [];
        await withMocks(
          () => stubFetchWithRecorder(calls),
          async () => {
            await bunnyCdnApi.validateCustomDomain("cdn.example.com");
            expect(calls).toHaveLength(3);
            expect(calls.at(0)!.url).toBe(
              "https://api.bunny.net/pullzone/12345/addHostname",
            );
            expect(calls.at(1)!.url).toBe(
              "https://api.bunny.net/pullzone/loadFreeCertificate?hostname=cdn.example.com",
            );
            expect(calls.at(2)!.url).toBe(
              "https://api.bunny.net/pullzone/12345/setForceSSL",
            );
          },
        );
      });
    });

    test("returns error when findPullZoneId fails", async () => {
      await withMockBunnyCdnApi(
        {
          findPullZoneId: () =>
            Promise.resolve({
              ok: false as const,
              error: "No pull zone found with hostname mysite.b-cdn.net",
            }),
        },
        async () => {
          const result =
            await bunnyCdnApi.validateCustomDomain("cdn.example.com");
          expect(result).toEqual({
            ok: false,
            error: "No pull zone found with hostname mysite.b-cdn.net",
          });
        },
      );
    });

    test("returns error when addHostname fails", async () => {
      await withMockBunnyCdnApi(fixedPullZone, async () => {
        await withMocks(
          () =>
            stub(globalThis, "fetch", () =>
              Promise.resolve(
                new Response("Hostname already exists", { status: 400 }),
              ),
            ),
          async () => {
            const result =
              await bunnyCdnApi.validateCustomDomain("cdn.example.com");
            expect(result).toEqual({
              ok: false,
              error: "Add hostname failed (400): Hostname already exists",
            });
          },
        );
      });
    });

    test("extracts errorKey from JSON error response", async () => {
      await withMockBunnyCdnApi(fixedPullZone, async () => {
        const jsonBody = JSON.stringify({
          ErrorKey: "pullzone.some_other_error",
          Message: "Something went wrong.",
        });
        await withMocks(
          () =>
            stub(globalThis, "fetch", () =>
              Promise.resolve(new Response(jsonBody, { status: 400 })),
            ),
          async () => {
            const result =
              await bunnyCdnApi.validateCustomDomain("cdn.example.com");
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
      await withMockBunnyCdnApi(fixedPullZone, async () => {
        let callCount = 0;
        const jsonBody = JSON.stringify({
          ErrorKey: "pullzone.hostname_already_registered",
          Message: "The hostname is already registered.",
        });
        await withMocks(
          () =>
            stub(globalThis, "fetch", () => {
              callCount++;
              if (callCount === 1) {
                return Promise.resolve(new Response(jsonBody, { status: 400 }));
              }
              return Promise.resolve(new Response(null, { status: 204 }));
            }),
          async () => {
            const result =
              await bunnyCdnApi.validateCustomDomain("cdn.example.com");
            expect(result).toEqual({ ok: true });
            expect(callCount).toBe(3);
          },
        );
      });
    });

    test("stops on addHostname failure without calling subsequent APIs", async () => {
      await withMockBunnyCdnApi(fixedPullZone, async () => {
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
      await withMockBunnyCdnApi(fixedPullZone, async () => {
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
            const result =
              await bunnyCdnApi.validateCustomDomain("cdn.example.com");
            expect(result).toEqual({
              ok: false,
              error: "Load free certificate failed (400): Certificate error",
            });
            expect(callCount).toBe(2);
          },
        );
      });
    });

    test("returns error when setForceSSL fails", async () => {
      await withMockBunnyCdnApi(fixedPullZone, async () => {
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
            const result =
              await bunnyCdnApi.validateCustomDomain("cdn.example.com");
            expect(result).toEqual({
              ok: false,
              error: "Set force SSL failed (500): SSL error",
            });
          },
        );
      });
    });
  },
);

describeWithEnv(
  "isBunnyDnsEnabled",
  { env: { BUNNY_API_KEY: undefined, BUNNY_DNS_ZONE_ID: undefined } },
  () => {
    test("returns false when neither env var is set", () => {
      expect(isBunnyDnsEnabled()).toBe(false);
    });

    test("returns false when only BUNNY_API_KEY is set", () => {
      Deno.env.set("BUNNY_API_KEY", "key");
      expect(isBunnyDnsEnabled()).toBe(false);
    });

    test("returns false when only BUNNY_DNS_ZONE_ID is set", () => {
      Deno.env.set("BUNNY_DNS_ZONE_ID", "123");
      expect(isBunnyDnsEnabled()).toBe(false);
    });

    test("returns true when both are set", () => {
      Deno.env.set("BUNNY_API_KEY", "key");
      Deno.env.set("BUNNY_DNS_ZONE_ID", "123");
      expect(isBunnyDnsEnabled()).toBe(true);
    });
  },
);

describeWithEnv(
  "getDnsZone",
  { env: { BUNNY_API_KEY: "test-key", BUNNY_DNS_ZONE_ID: "42" } },
  () => {
    test("returns zone data on success", async () => {
      const zone = {
        Id: 42,
        Domain: "example.com",
        Records: [{ Id: 1, Type: 5, Name: "existing", Value: "target.com" }],
      };
      await withMocks(
        () => stubFetchJson(zone),
        async () => {
          const result = await bunnyCdnApi.getDnsZone();
          expect(result).toEqual({ ok: true, zone });
        },
      );
    });

    test("sends correct request", async () => {
      const calls: { url: string; init: RequestInit | undefined }[] = [];
      const zone = { Id: 42, Domain: "example.com", Records: [] };
      await withMocks(
        () =>
          stub(
            globalThis,
            "fetch",
            (input: string | URL | Request, init?: RequestInit) => {
              calls.push({ url: String(input), init });
              return Promise.resolve(new Response(JSON.stringify(zone)));
            },
          ),
        async () => {
          await bunnyCdnApi.getDnsZone();
          expect(calls).toHaveLength(1);
          expect(calls.at(0)!.url).toBe("https://api.bunny.net/dnszone/42");
          expect(calls.at(0)!.init!.headers).toEqual({
            AccessKey: "test-key",
          });
        },
      );
    });

    test("returns error when API fails", async () => {
      await withMocks(
        () =>
          stub(globalThis, "fetch", () =>
            Promise.resolve(new Response("Not found", { status: 404 })),
          ),
        async () => {
          const result = await bunnyCdnApi.getDnsZone();
          expect(result).toEqual({
            ok: false,
            error: "Get DNS zone failed (404): Not found",
          });
        },
      );
    });
  },
);

/** Build a mock getDnsZone override with the given records */
const mockDnsZone = (records: { Name: string }[]) => ({
  getDnsZone: () =>
    Promise.resolve({
      ok: true as const,
      zone: {
        Id: 42,
        Domain: "example.com",
        Records: records.map((r, i) => ({
          Id: i,
          Type: 5,
          ...r,
          Value: "target.com",
        })),
      },
    }),
});

describeWithEnv(
  "checkSubdomainAvailable",
  {
    env: {
      BUNNY_API_KEY: "test-key",
      BUNNY_DNS_ZONE_ID: "42",
      BUNNY_DNS_SUBDOMAIN_SUFFIX: ".tickets",
    },
  },
  () => {
    test("returns available when no matching record exists", async () => {
      await withMockBunnyCdnApi(
        mockDnsZone([{ Name: "other.tickets" }]),
        async () => {
          const result = await checkSubdomainAvailable("myevent");
          expect(result).toEqual({
            ok: true,
            available: true,
            fullDomain: "myevent.tickets.example.com",
          });
        },
      );
    });

    test("returns not available when matching record exists", async () => {
      await withMockBunnyCdnApi(
        mockDnsZone([{ Name: "myevent.tickets" }]),
        async () => {
          const result = await checkSubdomainAvailable("myevent");
          expect(result).toEqual({
            ok: true,
            available: false,
            fullDomain: "myevent.tickets.example.com",
          });
        },
      );
    });

    test("returns error when getDnsZone fails", async () => {
      await withMockBunnyCdnApi(
        {
          getDnsZone: () =>
            Promise.resolve({ ok: false as const, error: "API error" }),
        },
        async () => {
          const result = await checkSubdomainAvailable("myevent");
          expect(result).toEqual({ ok: false, error: "API error" });
        },
      );
    });
  },
);

describeWithEnv(
  "checkSubdomainAvailable without suffix",
  {
    env: {
      BUNNY_API_KEY: "test-key",
      BUNNY_DNS_ZONE_ID: "42",
      BUNNY_DNS_SUBDOMAIN_SUFFIX: undefined,
    },
  },
  () => {
    test("uses subdomain as record name when suffix is unset", async () => {
      await withMockBunnyCdnApi(mockDnsZone([]), async () => {
        const result = await checkSubdomainAvailable("myevent");
        expect(result).toEqual({
          ok: true,
          available: true,
          fullDomain: "myevent.example.com",
        });
      });
    });
  },
);

describeWithEnv(
  "registerBunnySubdomain",
  {
    env: {
      BUNNY_API_KEY: "test-key",
      BUNNY_DNS_ZONE_ID: "42",
      BUNNY_DNS_SUBDOMAIN_SUFFIX: ".tickets",
    },
  },
  () => {
    beforeEach(() => setEffectiveDomainForTest("mysite.bunny.run"));
    afterEach(() => resetEffectiveDomain());

    const availableMock = {
      checkSubdomainAvailable: () =>
        Promise.resolve({
          ok: true as const,
          available: true,
          fullDomain: "myevent.tickets.example.com",
        }),
    };

    test("returns error when availability check fails", async () => {
      await withMockBunnyCdnApi(
        {
          checkSubdomainAvailable: () =>
            Promise.resolve({ ok: false as const, error: "DNS zone error" }),
        },
        async () => {
          const result = await registerBunnySubdomain("myevent");
          expect(result).toEqual({ ok: false, error: "DNS zone error" });
        },
      );
    });

    test("returns error when subdomain is taken", async () => {
      await withMockBunnyCdnApi(
        {
          checkSubdomainAvailable: () =>
            Promise.resolve({
              ok: true as const,
              available: false,
              fullDomain: "myevent.tickets.example.com",
            }),
        },
        async () => {
          const result = await registerBunnySubdomain("myevent");
          expect(result).toEqual({
            ok: false,
            error: 'Subdomain "myevent" is already taken',
          });
        },
      );
    });

    test("creates CNAME record and registers with CDN on success", async () => {
      const calls: { url: string; init: RequestInit | undefined }[] = [];
      await withMockBunnyCdnApi(
        {
          ...availableMock,
          validateCustomDomain: () => Promise.resolve({ ok: true as const }),
        },
        async () => {
          await withMocks(
            () => stubFetchWithRecorder(calls),
            async () => {
              const result = await registerBunnySubdomain("myevent");
              expect(result).toEqual({
                ok: true,
                fullDomain: "myevent.tickets.example.com",
              });
              expect(calls).toHaveLength(1);
              expect(calls.at(0)!.url).toBe(
                "https://api.bunny.net/dnszone/42/records",
              );
              expect(JSON.parse(calls.at(0)!.init!.body as string)).toEqual({
                Type: 5,
                Name: "myevent.tickets",
                Value: "mysite.bunny.run",
                Ttl: 300,
              });
            },
          );
        },
      );
    });

    test("returns error when DNS record creation fails", async () => {
      await withMockBunnyCdnApi(availableMock, async () => {
        await withMocks(
          () =>
            stub(globalThis, "fetch", () =>
              Promise.resolve(new Response("DNS error", { status: 500 })),
            ),
          async () => {
            const result = await registerBunnySubdomain("myevent");
            expect(result).toEqual({
              ok: false,
              error: "Add DNS CNAME record failed (500): DNS error",
            });
          },
        );
      });
    });

    test("returns error when CDN validation fails", async () => {
      await withMockBunnyCdnApi(
        {
          ...availableMock,
          validateCustomDomain: () =>
            Promise.resolve({ ok: false as const, error: "SSL failed" }),
        },
        async () => {
          await withMocks(
            () =>
              stub(globalThis, "fetch", () =>
                Promise.resolve(new Response(null, { status: 204 })),
              ),
            async () => {
              const result = await registerBunnySubdomain("myevent");
              expect(result).toEqual({ ok: false, error: "SSL failed" });
            },
          );
        },
      );
    });
  },
);

describeWithEnv("domain settings", { db: true }, () => {
  test("updateCustomDomain stores and clears domain", async () => {
    await settings.update.customDomain("tickets.example.com");
    expect(settings.customDomain).toBe("tickets.example.com");
    await settings.update.customDomain("");
    expect(settings.customDomain).toBeNull();
  });

  test("updateCustomDomainLastValidated stores an ISO timestamp", async () => {
    await settings.update.customDomainLastValidated();
    const value = settings.customDomainLastValidated;
    expect(value).not.toBeNull();
    expect(new Date(value!).toISOString()).toBe(value);
  });

  test("bunnySubdomain stores and clears", async () => {
    await settings.update.bunnySubdomain("myevent.tickets.example.com");
    expect(settings.bunnySubdomain).toBe("myevent.tickets.example.com");
    await settings.update.bunnySubdomain("");
    expect(settings.bunnySubdomain).toBeNull();
  });
});
