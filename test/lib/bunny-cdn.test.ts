import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { stub } from "@std/testing/mock";
import {
  bunnyCdnApi,
  getCdnHostname,
  validateCustomDomain,
} from "#lib/bunny-cdn.ts";
import {
  getBunnyApiKey,
  getBunnyScriptId,
  isBunnyCdnEnabled,
} from "#lib/config.ts";
import { settings } from "#lib/db/settings.ts";
import { describeWithEnv, withMocks } from "#test-utils";

/** Temporarily replace bunnyCdnApi.validateCustomDomain with a mock */
const withMockValidate = async (
  mockResult: { ok: true } | { ok: false; error: string; errorKey?: string },
  fn: () => Promise<void>,
): Promise<void> => {
  const original = bunnyCdnApi.validateCustomDomain;
  bunnyCdnApi.validateCustomDomain = () => Promise.resolve(mockResult);
  try {
    await fn();
  } finally {
    bunnyCdnApi.validateCustomDomain = original;
  }
};

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
    const mockResult = { ok: true as const };
    await withMockValidate(mockResult, async () => {
      const result = await validateCustomDomain("test.example.com");
      expect(result).toEqual(mockResult);
    });
  });

  test("returns error from bunnyCdnApi", async () => {
    const mockResult = { ok: false as const, error: "test error" };
    await withMockValidate(mockResult, async () => {
      const result = await validateCustomDomain("test.example.com");
      expect(result).toEqual(mockResult);
    });
  });
});

describeWithEnv("getBunnyApiKey", { env: { BUNNY_API_KEY: undefined } }, () => {
  test("getBunnyApiKey returns the env var value", () => {
    Deno.env.set("BUNNY_API_KEY", "my-api-key");
    expect(getBunnyApiKey()).toBe("my-api-key");
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
    test("returns DefaultHostname from edge script", async () => {
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
    /** Helper: stub findPullZoneId to return a fixed ID */
    const withFixedPullZoneId = (fn: () => Promise<void>): Promise<void> => {
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
      await withFixedPullZoneId(async () => {
        const calls: { url: string; init: RequestInit | undefined }[] = [];
        await withMocks(
          () => stubFetchWithRecorder(calls),
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
          error: "Edge script 99 has no linked pull zones",
        });
      try {
        const result =
          await bunnyCdnApi.validateCustomDomain("cdn.example.com");
        expect(result).toEqual({
          ok: false,
          error: "Edge script 99 has no linked pull zones",
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
  test("getCustomDomainFromDb returns null when not set", () => {
    expect(settings.customDomain).toBeNull();
  });

  test("updateCustomDomain stores and retrieves domain", async () => {
    await settings.update.customDomain("tickets.example.com");
    expect(settings.customDomain).toBe("tickets.example.com");
  });

  test("updateCustomDomain with empty string clears domain", async () => {
    await settings.update.customDomain("tickets.example.com");
    await settings.update.customDomain("");
    expect(settings.customDomain).toBeNull();
  });

  test("getCustomDomainLastValidatedFromDb returns null when not set", () => {
    expect(settings.customDomainLastValidated).toBeNull();
  });

  test("updateCustomDomainLastValidated stores a timestamp", async () => {
    await settings.update.customDomainLastValidated();
    const value = settings.customDomainLastValidated;
    expect(value).not.toBeNull();
    // Should be a valid ISO 8601 date
    expect(new Date(value!).toISOString()).toBe(value);
  });
});
