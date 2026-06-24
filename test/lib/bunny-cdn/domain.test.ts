import { expect } from "@std/expect";
import { afterEach, beforeEach, it as test } from "@std/testing/bdd";
import { stub } from "@std/testing/mock";
import { FakeTime } from "@std/testing/time";
import {
  buildSubdomainRecordName,
  bunnyCdnApi,
  checkSubdomainAvailable,
  registerBunnySubdomain,
} from "#shared/bunny-cdn.ts";
import {
  resetEffectiveDomain,
  setEffectiveDomainForTest,
} from "#shared/config.ts";
import {
  describeWithEnv,
  stubFetchRecorder,
  stubFetchStatus,
  withMockBunnyCdnApi,
  withMocks,
} from "#test-utils";

/** Register the standard test subdomain under a 204 fetch stub, asserting the
 * canonical success result. */
const registerMyListingOk = (): Promise<void> =>
  withMocks(
    () => stubFetchStatus(204),
    async () => {
      const result = await registerBunnySubdomain("mylisting");
      expect(result).toEqual({
        fullDomain: "mylisting.tickets.example.com",
        ok: true,
      });
    },
  );

// ---------------------------------------------------------------------------
// buildSubdomainRecordName
// ---------------------------------------------------------------------------

describeWithEnv(
  "buildSubdomainRecordName",
  { env: { BUNNY_DNS_SUBDOMAIN_SUFFIX: ".tickets" } },
  () => {
    test("appends suffix to subdomain", () => {
      expect(buildSubdomainRecordName("mylisting")).toBe("mylisting.tickets");
    });
  },
);

describeWithEnv(
  "buildSubdomainRecordName without suffix",
  { env: { BUNNY_DNS_SUBDOMAIN_SUFFIX: undefined } },
  () => {
    test("returns subdomain as-is when no suffix configured", () => {
      expect(buildSubdomainRecordName("mylisting")).toBe("mylisting");
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
      findPullZoneId: () => Promise.resolve({ id: 12345, ok: true as const }),
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
              error: "Edge script 99 has no linked pull zones",
              ok: false as const,
            }),
        },
        async () => {
          const result =
            await bunnyCdnApi.validateCustomDomain("cdn.example.com");
          expect(result).toEqual({
            error: "Edge script 99 has no linked pull zones",
            ok: false,
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
              error: "Add hostname failed (400): Hostname already exists",
              ok: false,
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
              error: "Add hostname failed (400): Something went wrong.",
              errorKey: "pullzone.some_other_error",
              ok: false,
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
              error: "Load free certificate failed (400): Certificate error",
              ok: false,
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
              error: "Set force SSL failed (500): SSL error",
              ok: false,
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
        Domain: "example.com",
        Id: 42,
        Records: [{ Id: 1, Name: "existing", Type: 2, Value: "target.com" }],
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
        () => stubFetchStatus(404, "Not found"),
        async () => {
          const result = await bunnyCdnApi.getDnsZone();
          expect(result).toEqual({
            error: "Get DNS zone failed (404): Not found",
            ok: false,
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
        Domain: "example.com",
        Id: 42,
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
      BUNNY_DNS_SUBDOMAIN_SUFFIX: ".tickets",
      BUNNY_DNS_ZONE_ID: "42",
    },
  },
  () => {
    test("returns available when no matching record exists", async () => {
      await withMockBunnyCdnApi(
        mockDnsZone([{ Name: "other.tickets" }]),
        async () => {
          const result = await checkSubdomainAvailable("mylisting");
          expect(result).toEqual({
            available: true,
            fullDomain: "mylisting.tickets.example.com",
            ok: true,
          });
        },
      );
    });

    test("returns not available when matching record exists", async () => {
      await withMockBunnyCdnApi(
        mockDnsZone([{ Name: "mylisting.tickets" }]),
        async () => {
          const result = await checkSubdomainAvailable("mylisting");
          expect(result).toEqual({
            available: false,
            fullDomain: "mylisting.tickets.example.com",
            ok: true,
          });
        },
      );
    });

    test("returns error when getDnsZone fails", async () => {
      await withMockBunnyCdnApi(
        {
          getDnsZone: () =>
            Promise.resolve({ error: "API error", ok: false as const }),
        },
        async () => {
          const result = await checkSubdomainAvailable("mylisting");
          expect(result).toEqual({ error: "API error", ok: false });
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
      BUNNY_DNS_SUBDOMAIN_SUFFIX: undefined,
      BUNNY_DNS_ZONE_ID: "42",
    },
  },
  () => {
    test("uses subdomain as record name when suffix is unset", async () => {
      await withMockBunnyCdnApi(mockDnsZone([]), async () => {
        const result = await checkSubdomainAvailable("mylisting");
        expect(result).toEqual({
          available: true,
          fullDomain: "mylisting.example.com",
          ok: true,
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
        () => stubFetchStatus(404, "Not found"),
        async () => {
          const result = await bunnyCdnApi.deleteDnsRecord("42", 999);
          expect(result).toEqual({
            error: "Delete DNS record failed (404): Not found",
            ok: false,
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
      BUNNY_DNS_SUBDOMAIN_SUFFIX: ".tickets",
      BUNNY_DNS_ZONE_ID: "42",
    },
  },
  () => {
    const availableMock = {
      checkSubdomainAvailable: () =>
        Promise.resolve({
          available: true,
          fullDomain: "mylisting.tickets.example.com",
          ok: true as const,
        }),
      getCdnHostname: () =>
        Promise.resolve({
          hostname: "mysite.b-cdn.net",
          ok: true as const,
        }),
    };

    test("returns error when availability check fails", async () => {
      await withMockBunnyCdnApi(
        {
          checkSubdomainAvailable: () =>
            Promise.resolve({ error: "DNS zone error", ok: false as const }),
        },
        async () => {
          const result = await registerBunnySubdomain("mylisting");
          expect(result).toEqual({ error: "DNS zone error", ok: false });
        },
      );
    });

    test("returns error when subdomain is taken", async () => {
      await withMockBunnyCdnApi(
        {
          checkSubdomainAvailable: () =>
            Promise.resolve({
              available: false,
              fullDomain: "mylisting.tickets.example.com",
              ok: true as const,
            }),
        },
        async () => {
          const result = await registerBunnySubdomain("mylisting");
          expect(result).toEqual({
            error: 'Subdomain "mylisting" is already taken',
            ok: false,
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
              const result = await registerBunnySubdomain("mylisting");
              expect(result).toEqual({
                fullDomain: "mylisting.tickets.example.com",
                ok: true,
              });
              expect(recorder.calls).toHaveLength(1);
              expect(recorder.calls[0]!.url).toContain("/dnszone/42/records");
              expect(
                JSON.parse(recorder.calls[0]!.init!.body as string),
              ).toEqual({
                Name: "mylisting.tickets",
                Ttl: 300,
                Type: 2,
                Value: "mysite.b-cdn.net",
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
            Promise.resolve({ error: "No pull zones", ok: false as const }),
        },
        async () => {
          const result = await registerBunnySubdomain("mylisting");
          expect(result).toEqual({ error: "No pull zones", ok: false });
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
            const result = await registerBunnySubdomain("mylisting");
            expect(result).toEqual({
              error: "Add DNS CNAME record failed (500): DNS error",
              ok: false,
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
          delay: () => Promise.resolve(),
          validateCustomDomain: () => {
            validateCallCount++;
            if (validateCallCount < 3) {
              return Promise.resolve({
                error: "Not pointing to our servers",
                ok: false as const,
              });
            }
            return Promise.resolve({ ok: true as const });
          },
        },
        async () => {
          await registerMyListingOk();
          expect(validateCallCount).toBe(3);
        },
      );
    });

    test("cleans up DNS record after all retries fail", async () => {
      let validateCallCount = 0;
      let deletedRecordId: number | undefined;
      await withMockBunnyCdnApi(
        {
          ...availableMock,
          delay: () => Promise.resolve(),
          deleteDnsRecord: (_zoneId: string, recordId: number) => {
            deletedRecordId = recordId;
            return Promise.resolve({ ok: true as const });
          },
          validateCustomDomain: () => {
            validateCallCount++;
            return Promise.resolve({
              error: "SSL failed",
              ok: false as const,
            });
          },
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
              const result = await registerBunnySubdomain("mylisting");
              expect(result).toEqual({ error: "SSL failed", ok: false });
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
          delay: () => Promise.resolve(),
          deleteDnsRecord: () => {
            deleteWasCalled = true;
            return Promise.resolve({ ok: true as const });
          },
          validateCustomDomain: () =>
            Promise.resolve({ error: "SSL failed", ok: false as const }),
        },
        async () => {
          await withMocks(
            () =>
              stub(globalThis, "fetch", () =>
                Promise.resolve(new Response("not json", { status: 200 })),
              ),
            async () => {
              const result = await registerBunnySubdomain("mylisting");
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
          delay: () => Promise.resolve(),
          validateCustomDomain: () => {
            validateCallCount++;
            return Promise.resolve({ ok: true as const });
          },
        },
        async () => {
          await registerMyListingOk();
          expect(validateCallCount).toBe(1);
        },
      );
    });
  },
);

// ---------------------------------------------------------------------------
// delay
// ---------------------------------------------------------------------------

describeWithEnv("delay", {}, () => {
  test("resolves after the specified time", async () => {
    using time = new FakeTime();
    let resolved = false;
    void (async () => {
      await bunnyCdnApi.delay(1000);
      resolved = true;
    })();
    time.tick(500);
    await time.runMicrotasks();
    expect(resolved).toBe(false);
    time.tick(500);
    await time.runMicrotasks();
    expect(resolved).toBe(true);
  });
});
