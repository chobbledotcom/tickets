import { expect } from "@std/expect";
import { afterEach, beforeEach, it as test } from "@std/testing/bdd";
import { stub } from "@std/testing/mock";
import {
  buildSubdomainRecordName,
  bunnyCdnApi,
  checkSubdomainAvailable,
  registerBunnySubdomain,
} from "#lib/bunny-cdn.ts";
import {
  resetEffectiveDomain,
  setEffectiveDomainForTest,
} from "#lib/config.ts";
import {
  describeWithEnv,
  stubFetchRecorder,
  withMockBunnyCdnApi,
  withMocks,
} from "#test-utils";

// ---------------------------------------------------------------------------
// buildSubdomainRecordName
// ---------------------------------------------------------------------------

describeWithEnv(
  "buildSubdomainRecordName",
  { env: { BUNNY_DNS_SUBDOMAIN_SUFFIX: ".tickets" } },
  () => {
    test("appends suffix to subdomain", () => {
      expect(buildSubdomainRecordName("myevent")).toBe("myevent.tickets");
    });
  },
);

describeWithEnv(
  "buildSubdomainRecordName without suffix",
  { env: { BUNNY_DNS_SUBDOMAIN_SUFFIX: undefined } },
  () => {
    test("returns subdomain as-is when no suffix configured", () => {
      expect(buildSubdomainRecordName("myevent")).toBe("myevent");
    });
  },
);

// ---------------------------------------------------------------------------
// validateCustomDomain
// ---------------------------------------------------------------------------

describeWithEnv(
  "validateCustomDomain",
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

    test("treats hostname_already_registered as success and continues", async () => {
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

// ---------------------------------------------------------------------------
// getDnsZone
// ---------------------------------------------------------------------------

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
        () =>
          stub(globalThis, "fetch", () =>
            Promise.resolve(new Response(JSON.stringify(zone))),
          ),
        async () => {
          const result = await bunnyCdnApi.getDnsZone();
          expect(result).toEqual({ ok: true, zone });
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

// ---------------------------------------------------------------------------
// checkSubdomainAvailable
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// deleteDnsRecord
// ---------------------------------------------------------------------------

describeWithEnv(
  "deleteDnsRecord",
  { env: { BUNNY_API_KEY: "test-key", BUNNY_DNS_ZONE_ID: "42" } },
  () => {
    test("sends DELETE request and returns ok", async () => {
      await withMocks(
        () => stubFetchRecorder(),
        async (recorder) => {
          const result = await bunnyCdnApi.deleteDnsRecord("42", 999);
          expect(result).toEqual({ ok: true });
          expect(recorder.calls).toHaveLength(1);
          expect(recorder.calls[0]!.url).toContain("/dnszone/42/records/999");
          expect(recorder.calls[0]!.init!.method).toBe("DELETE");
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

// ---------------------------------------------------------------------------
// registerBunnySubdomain
// ---------------------------------------------------------------------------

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
      await withMockBunnyCdnApi(
        {
          ...availableMock,
          validateCustomDomain: () => Promise.resolve({ ok: true as const }),
        },
        async () => {
          await withMocks(
            () => stubFetchRecorder(),
            async (recorder) => {
              const result = await registerBunnySubdomain("myevent");
              expect(result).toEqual({
                ok: true,
                fullDomain: "myevent.tickets.example.com",
              });
              expect(recorder.calls).toHaveLength(1);
              expect(recorder.calls[0]!.url).toContain("/dnszone/42/records");
              expect(
                JSON.parse(recorder.calls[0]!.init!.body as string),
              ).toEqual({
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

    test("cleans up DNS record after all retries fail", async () => {
      let validateCallCount = 0;
      let deletedRecordId: number | undefined;
      await withMockBunnyCdnApi(
        {
          ...availableMock,
          validateCustomDomain: () => {
            validateCallCount++;
            return Promise.resolve({
              ok: false as const,
              error: "SSL failed",
            });
          },
          deleteDnsRecord: (_zoneId: string, recordId: number) => {
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
              expect(deletedRecordId).toBe(999);
            },
          );
        },
      );
    });

    test("skips DNS cleanup when response has no record ID", async () => {
      let deleteWasCalled = false;
      await withMockBunnyCdnApi(
        {
          ...availableMock,
          validateCustomDomain: () =>
            Promise.resolve({ ok: false as const, error: "SSL failed" }),
          deleteDnsRecord: () => {
            deleteWasCalled = true;
            return Promise.resolve({ ok: true as const });
          },
          delay: () => Promise.resolve(),
        },
        async () => {
          await withMocks(
            () =>
              stub(globalThis, "fetch", () =>
                Promise.resolve(new Response("not json", { status: 200 })),
              ),
            async () => {
              const result = await registerBunnySubdomain("myevent");
              expect(result.ok).toBe(false);
              expect(deleteWasCalled).toBe(false);
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
