import { expect } from "@std/expect";
import { afterEach, beforeEach, describe, it as test } from "@std/testing/bdd";
import { stub } from "@std/testing/mock";
import {
  bunnyCdnApi,
  checkSubdomainAvailable,
  getCdnHostname,
  registerBunnySubdomain,
  validateCustomDomain,
} from "#lib/bunny-cdn.ts";
import {
  getBunnyScriptId,
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

/** Build an edge script API response */
const edgeScriptResponse = (
  pullZones: {
    Id: number;
    PullZoneName: string;
    DefaultHostname: string;
  }[] = [],
  defaultHostname = "mysite.b-cdn.net",
) => ({
  Id: 1,
  DefaultHostname: defaultHostname,
  LinkedPullZones: pullZones,
});

describeWithEnv(
  "isBunnyCdnEnabled",
  { env: { BUNNY_API_KEY: undefined, BUNNY_SCRIPT_ID: undefined } },
  () => {
    test("returns false when neither env var is set", () => {
      expect(isBunnyCdnEnabled()).toBe(false);
    });

    test("returns false when only BUNNY_API_KEY is set", () => {
      Deno.env.set("BUNNY_API_KEY", "test-key");
      expect(isBunnyCdnEnabled()).toBe(false);
    });

    test("returns false when only BUNNY_SCRIPT_ID is set", () => {
      Deno.env.set("BUNNY_SCRIPT_ID", "123");
      expect(isBunnyCdnEnabled()).toBe(false);
    });

    test("returns true when both env vars are set", () => {
      Deno.env.set("BUNNY_API_KEY", "test-key");
      Deno.env.set("BUNNY_SCRIPT_ID", "123");
      expect(isBunnyCdnEnabled()).toBe(true);
    });
  },
);

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
  "getBunnyScriptId",
  { env: { BUNNY_SCRIPT_ID: undefined } },
  () => {
    test("getBunnyScriptId returns the env var value", () => {
      Deno.env.set("BUNNY_SCRIPT_ID", "42");
      expect(getBunnyScriptId()).toBe("42");
    });
  },
);

describeWithEnv(
  "getEdgeScript",
  { env: { BUNNY_API_KEY: "test-bunny-key", BUNNY_SCRIPT_ID: "99" } },
  () => {
    test("returns edge script data on success", async () => {
      const response = edgeScriptResponse([
        {
          Id: 222,
          PullZoneName: "mysite",
          DefaultHostname: "mysite.b-cdn.net",
        },
      ]);
      await withMocks(
        () => stubFetchJson(response),
        async () => {
          const result = await bunnyCdnApi.getEdgeScript();
          expect(result).toEqual({ ok: true, data: response });
        },
      );
    });

    test("sends correct request to Bunny API", async () => {
      const calls: { url: string; init: RequestInit | undefined }[] = [];
      const response = edgeScriptResponse();
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
          await bunnyCdnApi.getEdgeScript();
          expect(calls).toHaveLength(1);
          expect(calls.at(0)!.url).toBe(
            "https://api.bunny.net/compute/script/99",
          );
          expect(calls.at(0)!.init!.headers).toEqual({
            AccessKey: "test-bunny-key",
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
          const result = await bunnyCdnApi.getEdgeScript();
          expect(result).toEqual({
            ok: false,
            error: "Get edge script failed (401): Unauthorized",
          });
        },
      );
    });

    test("returns errorKey from JSON error response", async () => {
      const jsonBody = JSON.stringify({
        ErrorKey: "script.not_found",
        Message: "Script not found.",
      });
      await withMocks(
        () =>
          stub(globalThis, "fetch", () =>
            Promise.resolve(new Response(jsonBody, { status: 404 })),
          ),
        async () => {
          const result = await bunnyCdnApi.getEdgeScript();
          expect(result).toEqual({
            ok: false,
            error: "Get edge script failed (404): Script not found.",
            errorKey: "script.not_found",
          });
        },
      );
    });
  },
);

describeWithEnv(
  "findPullZoneId",
  { env: { BUNNY_API_KEY: "test-bunny-key", BUNNY_SCRIPT_ID: "99" } },
  () => {
    test("returns pull zone ID from first linked pull zone", async () => {
      const response = edgeScriptResponse([
        {
          Id: 222,
          PullZoneName: "mysite",
          DefaultHostname: "mysite.b-cdn.net",
        },
      ]);
      await withMocks(
        () => stubFetchJson(response),
        async () => {
          const result = await bunnyCdnApi.findPullZoneId();
          expect(result).toEqual({ ok: true, id: 222 });
        },
      );
    });

    test("returns error when no linked pull zones", async () => {
      const response = edgeScriptResponse([]);
      await withMocks(
        () => stubFetchJson(response),
        async () => {
          const result = await bunnyCdnApi.findPullZoneId();
          expect(result).toEqual({
            ok: false,
            error: "Edge script 99 has no linked pull zones",
          });
        },
      );
    });

    test("returns error when edge script API fails", async () => {
      await withMocks(
        () =>
          stub(globalThis, "fetch", () =>
            Promise.resolve(new Response("Unauthorized", { status: 401 })),
          ),
        async () => {
          const result = await bunnyCdnApi.findPullZoneId();
          expect(result).toEqual({
            ok: false,
            error: "Get edge script failed (401): Unauthorized",
          });
        },
      );
    });
  },
);

describe("getCdnHostname", () => {
  test("delegates to bunnyCdnApi.getCdnHostname", async () => {
    const original = bunnyCdnApi.getCdnHostname;
    bunnyCdnApi.getCdnHostname = () =>
      Promise.resolve({ ok: true as const, hostname: "mysite.b-cdn.net" });
    try {
      const result = await getCdnHostname();
      expect(result).toEqual({ ok: true, hostname: "mysite.b-cdn.net" });
    } finally {
      bunnyCdnApi.getCdnHostname = original;
    }
  });

  test("returns error from bunnyCdnApi", async () => {
    const original = bunnyCdnApi.getCdnHostname;
    bunnyCdnApi.getCdnHostname = () =>
      Promise.resolve({ ok: false as const, error: "API error" });
    try {
      const result = await getCdnHostname();
      expect(result).toEqual({ ok: false, error: "API error" });
    } finally {
      bunnyCdnApi.getCdnHostname = original;
    }
  });
});

describeWithEnv(
  "getCdnHostname (real implementation)",
  { env: { BUNNY_API_KEY: "test-bunny-key", BUNNY_SCRIPT_ID: "99" } },
  () => {
    test("strips https and converts bunny.run to b-cdn.net", async () => {
      const response = edgeScriptResponse([], "https://mysite.bunny.run");
      await withMocks(
        () => stubFetchJson(response),
        async () => {
          const result = await bunnyCdnApi.getCdnHostname();
          expect(result).toEqual({ ok: true, hostname: "mysite.b-cdn.net" });
        },
      );
    });

    test("passes through already-correct b-cdn.net hostname", async () => {
      const response = edgeScriptResponse([], "mysite.b-cdn.net");
      await withMocks(
        () => stubFetchJson(response),
        async () => {
          const result = await bunnyCdnApi.getCdnHostname();
          expect(result).toEqual({ ok: true, hostname: "mysite.b-cdn.net" });
        },
      );
    });

    test("returns error when edge script API fails", async () => {
      await withMocks(
        () =>
          stub(globalThis, "fetch", () =>
            Promise.resolve(new Response("Not found", { status: 404 })),
          ),
        async () => {
          const result = await bunnyCdnApi.getCdnHostname();
          expect(result).toEqual({
            ok: false,
            error: "Get edge script failed (404): Not found",
          });
        },
      );
    });
  },
);

describeWithEnv(
  "validateCustomDomain (real implementation)",
  { env: { BUNNY_API_KEY: "test-bunny-key", BUNNY_SCRIPT_ID: "99" } },
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
              error: "Edge script 99 has no linked pull zones",
            }),
        },
        async () => {
          const result =
            await bunnyCdnApi.validateCustomDomain("cdn.example.com");
          expect(result).toEqual({
            ok: false,
            error: "Edge script 99 has no linked pull zones",
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

describeWithEnv("custom domain settings", { db: true }, () => {
  test("getCustomDomainFromDb returns empty string when not set", () => {
    expect(settings.customDomain).toBe("");
  });
});

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
        Records: [{ Id: 1, Type: 2, Name: "existing", Value: "target.com" }],
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
          Type: 2,
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
    const availableMock = {
      checkSubdomainAvailable: () =>
        Promise.resolve({
          ok: true as const,
          available: true,
          fullDomain: "myevent.tickets.example.com",
        }),
      getCdnHostname: () =>
        Promise.resolve({
          ok: true as const,
          hostname: "mysite.b-cdn.net",
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
                Type: 2,
                Name: "myevent.tickets",
                Value: "mysite.b-cdn.net",
                Ttl: 300,
              });
            },
          );
        },
      );
    });

    test("returns error when CDN hostname lookup fails", async () => {
      await withMockBunnyCdnApi(
        {
          ...availableMock,
          getCdnHostname: () =>
            Promise.resolve({ ok: false as const, error: "No pull zones" }),
        },
        async () => {
          const result = await registerBunnySubdomain("myevent");
          expect(result).toEqual({ ok: false, error: "No pull zones" });
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

    test("returns error and deletes DNS record when CDN validation fails after all retries", async () => {
      let validateCallCount = 0;
      let deletedZoneId: string | undefined;
      let deletedRecordId: number | undefined;
      await withMockBunnyCdnApi(
        {
          ...availableMock,
          validateCustomDomain: () => {
            validateCallCount++;
            return Promise.resolve({ ok: false as const, error: "SSL failed" });
          },
          deleteDnsRecord: (zoneId: string, recordId: number) => {
            deletedZoneId = zoneId;
            deletedRecordId = recordId;
            return Promise.resolve({ ok: true as const });
          },
          delay: () => Promise.resolve(),
        },
        async () => {
          await withMocks(
            () =>
              stub(globalThis, "fetch", () =>
                Promise.resolve(
                  new Response(JSON.stringify({ Id: 999 }), { status: 200 }),
                ),
              ),
            async () => {
              const result = await registerBunnySubdomain("myevent");
              expect(result).toEqual({ ok: false, error: "SSL failed" });
              expect(validateCallCount).toBe(5);
              expect(deletedZoneId).toBe("42");
              expect(deletedRecordId).toBe(999);
            },
          );
        },
      );
    });

    test("retries certificate loading and succeeds after DNS propagation", async () => {
      let validateCallCount = 0;
      await withMockBunnyCdnApi(
        {
          ...availableMock,
          validateCustomDomain: () => {
            validateCallCount++;
            if (validateCallCount < 3) {
              return Promise.resolve({
                ok: false as const,
                error: "Not pointing to our servers",
              });
            }
            return Promise.resolve({ ok: true as const });
          },
          delay: () => Promise.resolve(),
        },
        async () => {
          await withMocks(
            () =>
              stub(globalThis, "fetch", () =>
                Promise.resolve(new Response(null, { status: 204 })),
              ),
            async () => {
              const result = await registerBunnySubdomain("myevent");
              expect(result).toEqual({
                ok: true,
                fullDomain: "myevent.tickets.example.com",
              });
              expect(validateCallCount).toBe(3);
            },
          );
        },
      );
    });

    test("does not retry when first validation succeeds", async () => {
      let validateCallCount = 0;
      await withMockBunnyCdnApi(
        {
          ...availableMock,
          validateCustomDomain: () => {
            validateCallCount++;
            return Promise.resolve({ ok: true as const });
          },
          delay: () => Promise.resolve(),
        },
        async () => {
          await withMocks(
            () =>
              stub(globalThis, "fetch", () =>
                Promise.resolve(new Response(null, { status: 204 })),
              ),
            async () => {
              const result = await registerBunnySubdomain("myevent");
              expect(result).toEqual({
                ok: true,
                fullDomain: "myevent.tickets.example.com",
              });
              expect(validateCallCount).toBe(1);
            },
          );
        },
      );
    });
  },
);

describeWithEnv(
  "deleteDnsRecord",
  { env: { BUNNY_API_KEY: "test-key", BUNNY_DNS_ZONE_ID: "42" } },
  () => {
    test("sends DELETE request to correct URL", async () => {
      const calls: { url: string; init: RequestInit | undefined }[] = [];
      await withMocks(
        () => stubFetchWithRecorder(calls),
        async () => {
          const result = await bunnyCdnApi.deleteDnsRecord("42", 999);
          expect(result).toEqual({ ok: true });
          expect(calls).toHaveLength(1);
          expect(calls.at(0)!.url).toBe(
            "https://api.bunny.net/dnszone/42/records/999",
          );
          expect(calls.at(0)!.init!.method).toBe("DELETE");
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
          const result = await bunnyCdnApi.deleteDnsRecord("42", 999);
          expect(result).toEqual({
            ok: false,
            error: "Delete DNS record failed (404): Not found",
          });
        },
      );
    });
  },
);

describeWithEnv(
  "deployScriptCode",
  { env: { BUNNY_API_KEY: "test-key", BUNNY_SCRIPT_ID: "99" } },
  () => {
    test("uploads code and publishes script", async () => {
      const calls: { url: string; init: RequestInit | undefined }[] = [];
      await withMocks(
        () => stubFetchWithRecorder(calls),
        async () => {
          const result = await bunnyCdnApi.deployScriptCode("console.log(1)");
          expect(result).toEqual({ ok: true });
          expect(calls).toHaveLength(2);
          expect(calls.at(0)!.url).toBe(
            "https://api.bunny.net/compute/script/99/code",
          );
          expect(calls.at(0)!.init!.method).toBe("POST");
          expect(calls.at(1)!.url).toBe(
            "https://api.bunny.net/compute/script/99/publish",
          );
          expect(calls.at(1)!.init!.method).toBe("POST");
        },
      );
    });

    test("returns error when code upload fails", async () => {
      await withMocks(
        () =>
          stub(globalThis, "fetch", () =>
            Promise.resolve(new Response("Server Error", { status: 500 })),
          ),
        async () => {
          const result = await bunnyCdnApi.deployScriptCode("code");
          expect(result).toEqual({
            ok: false,
            error: "Upload script code failed (500): Server Error",
          });
        },
      );
    });

    test("returns error when publish fails", async () => {
      let callCount = 0;
      await withMocks(
        () =>
          stub(globalThis, "fetch", () => {
            callCount++;
            if (callCount === 1) {
              return Promise.resolve(new Response("{}", { status: 200 }));
            }
            return Promise.resolve(
              new Response("Publish Error", { status: 500 }),
            );
          }),
        async () => {
          const result = await bunnyCdnApi.deployScriptCode("code");
          expect(result).toEqual({
            ok: false,
            error: "Publish script failed (500): Publish Error",
          });
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
    expect(settings.customDomain).toBe("");
  });

  test("getCustomDomainLastValidatedFromDb returns empty string when not set", () => {
    expect(settings.customDomainLastValidated).toBe("");
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
    expect(settings.bunnySubdomain).toBe("");
  });
});

describeWithEnv(
  "createEdgeScript",
  { env: { BUNNY_API_KEY: "test-bunny-key", BUNNY_SCRIPT_ID: "99" } },
  () => {
    test("returns script ID and hostname on success", async () => {
      await withMocks(
        () =>
          stub(globalThis, "fetch", () =>
            Promise.resolve(
              new Response(
                JSON.stringify({
                  Id: 42,
                  DefaultHostname: "test-42.b-cdn.net",
                }),
              ),
            ),
          ),
        async () => {
          const result = await bunnyCdnApi.createEdgeScript(
            "Test Script",
            "console.log('test')",
          );
          expect(result).toEqual({
            ok: true,
            scriptId: 42,
            defaultHostname: "test-42.b-cdn.net",
          });
        },
      );
    });

    test("strips https:// prefix from DefaultHostname", async () => {
      await withMocks(
        () =>
          stub(globalThis, "fetch", () =>
            Promise.resolve(
              new Response(
                JSON.stringify({
                  Id: 42,
                  DefaultHostname: "https://test-42.b-cdn.net",
                }),
              ),
            ),
          ),
        async () => {
          const result = await bunnyCdnApi.createEdgeScript(
            "Test Script",
            "console.log('test')",
          );
          expect(result).toEqual({
            ok: true,
            scriptId: 42,
            defaultHostname: "test-42.b-cdn.net",
          });
        },
      );
    });

    test("defaults hostname to empty string when not in response", async () => {
      await withMocks(
        () =>
          stub(globalThis, "fetch", () =>
            Promise.resolve(new Response(JSON.stringify({ Id: 7 }))),
          ),
        async () => {
          const result = await bunnyCdnApi.createEdgeScript("Test", "code");
          expect(result).toEqual({
            ok: true,
            scriptId: 7,
            defaultHostname: "",
          });
        },
      );
    });

    test("returns error on API failure", async () => {
      await withMocks(
        () =>
          stub(globalThis, "fetch", () =>
            Promise.resolve(
              new Response(JSON.stringify({ Message: "Bad Request" }), {
                status: 400,
              }),
            ),
          ),
        async () => {
          const result = await bunnyCdnApi.createEdgeScript("Test", "code");
          expect(result.ok).toBe(false);
          if (!result.ok) {
            expect(result.error).toContain("Create edge script failed");
          }
        },
      );
    });

    test("sends correct request body with ScriptType 1", async () => {
      const calls: { url: string; init: RequestInit | undefined }[] = [];
      await withMocks(
        () =>
          stub(
            globalThis,
            "fetch",
            (input: string | URL | Request, init?: RequestInit) => {
              calls.push({ url: String(input), init });
              return Promise.resolve(
                new Response(JSON.stringify({ Id: 1, DefaultHostname: "" })),
              );
            },
          ),
        async () => {
          await bunnyCdnApi.createEdgeScript("My Script", "code");
          expect(calls).toHaveLength(1);
          const body = JSON.parse(calls[0]!.init!.body as string);
          expect(body.Name).toBe("My Script");
          expect(body.ScriptType).toBe(1);
          expect(body.CreateLinkedPullZone).toBe(true);
        },
      );
    });
  },
);

describeWithEnv(
  "setEdgeScriptSecret",
  { env: { BUNNY_API_KEY: "test-bunny-key" } },
  () => {
    test("sends PUT request with secret payload", async () => {
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
          const result = await bunnyCdnApi.setEdgeScriptSecret(
            42,
            "DB_URL",
            "libsql://test",
          );
          expect(result.ok).toBe(true);
          expect(calls[0]!.url).toContain("/compute/script/42/secrets");
          expect(calls[0]!.init!.method).toBe("PUT");
          const body = JSON.parse(calls[0]!.init!.body as string);
          expect(body.Name).toBe("DB_URL");
          expect(body.Secret).toBe("libsql://test");
        },
      );
    });

    test("returns error on API failure", async () => {
      await withMocks(
        () =>
          stub(globalThis, "fetch", () =>
            Promise.resolve(new Response("Forbidden", { status: 403 })),
          ),
        async () => {
          const result = await bunnyCdnApi.setEdgeScriptSecret(
            42,
            "DB_URL",
            "test",
          );
          expect(result.ok).toBe(false);
          if (!result.ok) {
            expect(result.error).toContain("Set secret DB_URL failed");
          }
        },
      );
    });
  },
);

describeWithEnv(
  "publishEdgeScript",
  { env: { BUNNY_API_KEY: "test-bunny-key" } },
  () => {
    test("sends POST to publish endpoint", async () => {
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
          const result = await bunnyCdnApi.publishEdgeScript(42);
          expect(result.ok).toBe(true);
          expect(calls[0]!.url).toContain("/compute/script/42/publish");
          expect(calls[0]!.init!.method).toBe("POST");
        },
      );
    });

    test("returns error on API failure", async () => {
      await withMocks(
        () =>
          stub(globalThis, "fetch", () =>
            Promise.resolve(new Response("Server Error", { status: 500 })),
          ),
        async () => {
          const result = await bunnyCdnApi.publishEdgeScript(42);
          expect(result.ok).toBe(false);
          if (!result.ok) {
            expect(result.error).toContain("Publish edge script failed");
          }
        },
      );
    });
  },
);
