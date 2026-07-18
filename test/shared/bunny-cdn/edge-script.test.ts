import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { bunnyCdnApi } from "#shared/bunny-cdn.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { stubFetch } from "#test-utils/fetch-stub.ts";
import { withMocks } from "#test-utils/mocks.ts";

/** Build an edge script API response */
const edgeScriptResponse = (
  pullZones: {
    Id: number;
    PullZoneName: string;
    DefaultHostname: string;
  }[] = [],
  defaultHostname = "mysite.b-cdn.net",
) => ({
  DefaultHostname: defaultHostname,
  Id: 1,
  LinkedPullZones: pullZones,
});

/** The single linked pull zone most edge-script tests exercise. */
const SINGLE_PULL_ZONE = [
  { DefaultHostname: "mysite.b-cdn.net", Id: 222, PullZoneName: "mysite" },
];

/** Assert a `{ ok: false; error }` result whose error contains `contains`. */
const expectErrorResult = (
  result: { ok: boolean; error?: string },
  contains: string,
): void => {
  expect(result.ok).toBe(false);
  if (!result.ok) expect(result.error).toContain(contains);
};

describeWithEnv(
  "getEdgeScript",
  { env: { BUNNY_API_KEY: "test-bunny-key", BUNNY_SCRIPT_ID: "99" } },
  () => {
    test("returns edge script data on success", async () => {
      const response = edgeScriptResponse(SINGLE_PULL_ZONE);
      await withMocks(
        () => stubFetch(new Response(JSON.stringify(response))),
        async () => {
          const result = await bunnyCdnApi.getEdgeScript();
          expect(result).toEqual({ data: response, ok: true });
        },
      );
    });

    test("returns error when API request fails", async () => {
      await withMocks(
        () => stubFetch(new Response("Unauthorized", { status: 401 })),
        async () => {
          const result = await bunnyCdnApi.getEdgeScript();
          expect(result).toEqual({
            error: "Get edge script failed (401): Unauthorized",
            ok: false,
          });
        },
      );
    });

    test("extracts errorKey from JSON error response", async () => {
      const jsonBody = JSON.stringify({
        ErrorKey: "script.not_found",
        Message: "Script not found.",
      });
      await withMocks(
        () => stubFetch(new Response(jsonBody, { status: 404 })),
        async () => {
          const result = await bunnyCdnApi.getEdgeScript();
          expect(result).toEqual({
            error: "Get edge script failed (404): Script not found.",
            errorKey: "script.not_found",
            ok: false,
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
      const response = edgeScriptResponse(SINGLE_PULL_ZONE);
      await withMocks(
        () => stubFetch(new Response(JSON.stringify(response))),
        async () => {
          const result = await bunnyCdnApi.findPullZoneId();
          expect(result).toEqual({ id: 222, ok: true });
        },
      );
    });

    test("returns error when no linked pull zones", async () => {
      await withMocks(
        () => stubFetch(new Response(JSON.stringify(edgeScriptResponse([])))),
        async () => {
          const result = await bunnyCdnApi.findPullZoneId();
          expect(result).toEqual({
            error: "Edge script 99 has no linked pull zones",
            ok: false,
          });
        },
      );
    });

    test("returns error when edge script API fails", async () => {
      await withMocks(
        () => stubFetch(new Response("Unauthorized", { status: 401 })),
        async () => {
          const result = await bunnyCdnApi.findPullZoneId();
          expect(result).toEqual({
            error: "Get edge script failed (401): Unauthorized",
            ok: false,
          });
        },
      );
    });
  },
);

describeWithEnv(
  "getCdnHostname",
  { env: { BUNNY_API_KEY: "test-bunny-key", BUNNY_SCRIPT_ID: "99" } },
  () => {
    const expectCdnHostname = async (hostname: string): Promise<void> => {
      using _fetch = stubFetch(
        new Response(JSON.stringify(edgeScriptResponse([], hostname))),
      );
      const result = await bunnyCdnApi.getCdnHostname();
      expect(result).toEqual({ hostname: "mysite.b-cdn.net", ok: true });
    };

    test("converts .bunny.run hostname to .b-cdn.net", async () => {
      await expectCdnHostname("https://mysite.bunny.run");
    });

    test("passes through already-correct b-cdn.net hostname", async () => {
      await expectCdnHostname("mysite.b-cdn.net");
    });

    test("returns error when edge script API fails", async () => {
      await withMocks(
        () => stubFetch(new Response("Not found", { status: 404 })),
        async () => {
          const result = await bunnyCdnApi.getCdnHostname();
          expect(result).toEqual({
            error: "Get edge script failed (404): Not found",
            ok: false,
          });
        },
      );
    });
  },
);

describeWithEnv(
  "createEdgeScript",
  { env: { BUNNY_API_KEY: "test-bunny-key", BUNNY_SCRIPT_ID: "99" } },
  () => {
    test("returns script ID, pull zone ID, and hostname on success", async () => {
      await withMocks(
        () =>
          stubFetch(
            new Response(
              JSON.stringify({
                DefaultHostname: "test-42.b-cdn.net",
                Id: 42,
                LinkedPullZones: [{ Id: 99 }],
              }),
            ),
          ),
        async (fetchStub) => {
          const result = await bunnyCdnApi.createEdgeScript(
            "Test Script",
            "console.log('test')",
          );
          expect(result).toEqual({
            defaultHostname: "test-42.b-cdn.net",
            ok: true,
            pullZoneId: 99,
            scriptId: 42,
          });
          const [url, init] = fetchStub.calls[0]!.args as [string, RequestInit];
          expect(url).toBe("https://api.bunny.net/compute/script");
          expect(init.method).toBe("POST");
          expect(new Headers(init.headers).get("content-type")).toBe(
            "application/json",
          );
          expect(JSON.parse(init.body as string)).toEqual({
            Code: "console.log('test')",
            CreateLinkedPullZone: true,
            Name: "Test Script",
            ScriptType: 1,
          });
        },
      );
    });

    test("defaults hostname to empty string when not in response", async () => {
      await withMocks(
        () =>
          stubFetch(
            new Response(
              JSON.stringify({ Id: 7, LinkedPullZones: [{ Id: 50 }] }),
            ),
          ),
        async () => {
          const result = await bunnyCdnApi.createEdgeScript("Test", "code");
          expect(result).toEqual({
            defaultHostname: "",
            ok: true,
            pullZoneId: 50,
            scriptId: 7,
          });
        },
      );
    });

    test("returns error on API failure", async () => {
      await withMocks(
        () =>
          stubFetch(
            new Response(JSON.stringify({ Message: "Bad Request" }), {
              status: 400,
            }),
          ),
        async () => {
          const result = await bunnyCdnApi.createEdgeScript("Test", "code");
          expectErrorResult(result, "Create edge script failed");
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
      await withMocks(
        () => stubFetch(() => new Response(null, { status: 204 })),
        async (fetchStub) => {
          const result = await bunnyCdnApi.deployScriptCode("console.log(1)");
          expect(result).toEqual({ ok: true });
          expect(fetchStub.calls).toHaveLength(2);
          expect(String(fetchStub.calls[0]!.args[0])).toContain(
            "/compute/script/99/code",
          );
          expect(String(fetchStub.calls[1]!.args[0])).toContain(
            "/compute/script/99/publish",
          );
          expect(
            fetchStub.calls.map(({ args }) => (args[1] as RequestInit).method),
          ).toEqual(["POST", "POST"]);
          expect(
            JSON.parse(
              (fetchStub.calls[0]!.args[1] as RequestInit).body as string,
            ),
          ).toEqual({ Code: "console.log(1)" });
          expect((fetchStub.calls[1]!.args[1] as RequestInit).body).toBe("{}");
        },
      );
    });

    test("deploys to an explicit script id instead of the host's", async () => {
      await withMocks(
        () => stubFetch(() => new Response(null, { status: 204 })),
        async (fetchStub) => {
          const result = await bunnyCdnApi.deployScriptCode("code", 12345);
          expect(result).toEqual({ ok: true });
          expect(String(fetchStub.calls[0]!.args[0])).toContain(
            "/compute/script/12345/code",
          );
          expect(String(fetchStub.calls[1]!.args[0])).toContain(
            "/compute/script/12345/publish",
          );
        },
      );
    });

    test("returns error when code upload fails", async () => {
      await withMocks(
        () => stubFetch(new Response("Server Error", { status: 500 })),
        async () => {
          const result = await bunnyCdnApi.deployScriptCode("code");
          expect(result).toEqual({
            error: "Upload script code failed (500): Server Error",
            ok: false,
          });
        },
      );
    });

    test("returns error when publish fails", async () => {
      await withMocks(
        () =>
          stubFetch(
            new Response("{}"),
            new Response("Publish Error", { status: 500 }),
          ),
        async () => {
          const result = await bunnyCdnApi.deployScriptCode("code");
          expect(result).toEqual({
            error: "Publish script failed (500): Publish Error",
            ok: false,
          });
        },
      );
    });
  },
);

describeWithEnv(
  "publishEdgeScript",
  { env: { BUNNY_API_KEY: "test-bunny-key" } },
  () => {
    test("publishes script successfully", async () => {
      using fetchStub = stubFetch(new Response(null, { status: 204 }));
      const result = await bunnyCdnApi.publishEdgeScript(42);
      expect(result.ok).toBe(true);
      expect(String(fetchStub.calls[0]!.args[0])).toContain(
        "/compute/script/42/publish",
      );
      expect((fetchStub.calls[0]!.args[1] as RequestInit).method).toBe("POST");
      expect((fetchStub.calls[0]!.args[1] as RequestInit).body).toBe("{}");
    });

    test("returns error on API failure", async () => {
      using _fetch = stubFetch(new Response("Server Error", { status: 500 }));
      const result = await bunnyCdnApi.publishEdgeScript(42);
      expectErrorResult(result, "Publish edge script failed");
    });
  },
);

describeWithEnv(
  "setEdgeScriptSecret",
  { env: { BUNNY_API_KEY: "test-bunny-key" } },
  () => {
    test("sends PUT request with secret payload", async () => {
      using fetchStub = stubFetch(new Response(null, { status: 204 }));
      const result = await bunnyCdnApi.setEdgeScriptSecret(
        42,
        "DB_URL",
        "libsql://test",
      );
      expect(result.ok).toBe(true);
      expect(String(fetchStub.calls[0]!.args[0])).toContain(
        "/compute/script/42/secrets",
      );
      const init = fetchStub.calls[0]!.args[1] as RequestInit;
      expect(init.method).toBe("PUT");
      const body = JSON.parse(init.body as string);
      expect(body.Name).toBe("DB_URL");
      expect(body.Secret).toBe("libsql://test");
    });

    test("returns error on API failure", async () => {
      using _fetch = stubFetch(new Response("Forbidden", { status: 403 }));
      const result = await bunnyCdnApi.setEdgeScriptSecret(
        42,
        "DB_URL",
        "test",
      );
      expectErrorResult(result, "Set secret DB_URL failed");
    });
  },
);

describeWithEnv(
  "listEdgeScriptSecrets",
  { env: { BUNNY_API_KEY: "test-bunny-key" } },
  () => {
    test("returns the secrets reported by the API", async () => {
      const secrets = [
        { Id: 1, LastModified: "2026-01-01T00:00:00Z", Name: "DB_URL" },
        { Id: 2, LastModified: "2026-01-02T00:00:00Z", Name: "NTFY_URL" },
      ];
      await withMocks(
        () => stubFetch(new Response(JSON.stringify({ Secrets: secrets }))),
        async () => {
          const result = await bunnyCdnApi.listEdgeScriptSecrets(42);
          expect(result).toEqual({ ok: true, secrets });
        },
      );
    });

    test("GETs the script secrets endpoint", async () => {
      await withMocks(
        () => stubFetch(new Response(JSON.stringify({ Secrets: [] }))),
        async (fetchStub) => {
          await bunnyCdnApi.listEdgeScriptSecrets(7);
          expect(String(fetchStub.calls[0]!.args[0])).toContain(
            "/compute/script/7/secrets",
          );
          // GET is the default method (no explicit method on the request init).
          expect(
            (fetchStub.calls[0]!.args[1] as RequestInit | undefined)?.method,
          ).toBeUndefined();
        },
      );
    });

    test("treats a null Secrets array as empty", async () => {
      using _fetch = stubFetch(new Response(JSON.stringify({ Secrets: null })));
      const result = await bunnyCdnApi.listEdgeScriptSecrets(42);
      expect(result).toEqual({ ok: true, secrets: [] });
    });

    test("returns error on API failure", async () => {
      using _fetch = stubFetch(new Response("Forbidden", { status: 403 }));
      const result = await bunnyCdnApi.listEdgeScriptSecrets(42);
      expectErrorResult(result, "List secrets failed (403)");
    });
  },
);

describeWithEnv(
  "deleteEdgeScriptSecret",
  { env: { BUNNY_API_KEY: "test-bunny-key" } },
  () => {
    test("deletes one secret by id", async () => {
      using fetchStub = stubFetch(new Response(null, { status: 204 }));

      expect(await bunnyCdnApi.deleteEdgeScriptSecret(42, 8)).toEqual({
        ok: true,
      });
      const [url, init] = fetchStub.calls[0]!.args as [string, RequestInit];
      expect(url).toBe("https://api.bunny.net/compute/script/42/secrets/8");
      expect(init.method).toBe("DELETE");
      expect(init.body).toBe("{}");
    });

    test("labels a secret delete failure", async () => {
      using _fetch = stubFetch(new Response("failed", { status: 500 }));

      expect(await bunnyCdnApi.deleteEdgeScriptSecret(42, 8)).toEqual({
        error: "Delete secret failed (500): failed",
        ok: false,
      });
    });
  },
);

describeWithEnv(
  "updatePullZone",
  { env: { BUNNY_API_KEY: "test-bunny-key" } },
  () => {
    test("sends POST to pull zone with settings payload", async () => {
      using fetchStub = stubFetch(new Response());
      const result = await bunnyCdnApi.updatePullZone(99, {
        DisableCookies: false,
      });
      expect(result.ok).toBe(true);
      expect(String(fetchStub.calls[0]!.args[0])).toBe(
        "https://api.bunny.net/pullzone/99",
      );
      const init = fetchStub.calls[0]!.args[1] as RequestInit;
      expect(init.method).toBe("POST");
      expect(new Headers(init.headers).get("content-type")).toBe(
        "application/json",
      );
      const body = JSON.parse(init.body as string);
      expect(body.DisableCookies).toBe(false);
    });

    test("returns error on API failure", async () => {
      using _fetch = stubFetch(new Response("Server Error", { status: 500 }));
      const result = await bunnyCdnApi.updatePullZone(99, {
        DisableCookies: false,
      });
      expectErrorResult(result, "Update pull zone failed");
    });
  },
);
