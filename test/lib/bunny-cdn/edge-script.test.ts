import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { stub } from "@std/testing/mock";
import { bunnyCdnApi } from "#shared/bunny-cdn.ts";
import {
  describeWithEnv,
  stubFetchJson,
  stubFetchRecorder,
  stubFetchStatus,
  withMocks,
} from "#test-utils";

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
        () => stubFetchJson(response),
        async () => {
          const result = await bunnyCdnApi.getEdgeScript();
          expect(result).toEqual({ data: response, ok: true });
        },
      );
    });

    test("returns error when API request fails", async () => {
      await withMocks(
        () => stubFetchStatus(401, "Unauthorized"),
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
        () => stubFetchStatus(404, jsonBody),
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
        () => stubFetchJson(response),
        async () => {
          const result = await bunnyCdnApi.findPullZoneId();
          expect(result).toEqual({ id: 222, ok: true });
        },
      );
    });

    test("returns error when no linked pull zones", async () => {
      await withMocks(
        () => stubFetchJson(edgeScriptResponse([])),
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
        () => stubFetchStatus(401, "Unauthorized"),
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
    test("converts .bunny.run hostname to .b-cdn.net", async () => {
      await withMocks(
        () => stubFetchJson(edgeScriptResponse([], "https://mysite.bunny.run")),
        async () => {
          const result = await bunnyCdnApi.getCdnHostname();
          expect(result).toEqual({ hostname: "mysite.b-cdn.net", ok: true });
        },
      );
    });

    test("passes through already-correct b-cdn.net hostname", async () => {
      await withMocks(
        () => stubFetchJson(edgeScriptResponse([], "mysite.b-cdn.net")),
        async () => {
          const result = await bunnyCdnApi.getCdnHostname();
          expect(result).toEqual({ hostname: "mysite.b-cdn.net", ok: true });
        },
      );
    });

    test("returns error when edge script API fails", async () => {
      await withMocks(
        () => stubFetchStatus(404, "Not found"),
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
          stubFetchJson({
            DefaultHostname: "test-42.b-cdn.net",
            Id: 42,
            LinkedPullZones: [{ Id: 99 }],
          }),
        async () => {
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
        },
      );
    });

    test("defaults hostname to empty string when not in response", async () => {
      await withMocks(
        () => stubFetchJson({ Id: 7, LinkedPullZones: [{ Id: 50 }] }),
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
        () => stubFetchStatus(400, JSON.stringify({ Message: "Bad Request" })),
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
        () => stubFetchRecorder(),
        async (recorder) => {
          const result = await bunnyCdnApi.deployScriptCode("console.log(1)");
          expect(result).toEqual({ ok: true });
          expect(recorder.calls).toHaveLength(2);
          expect(recorder.calls[0]!.url).toContain("/compute/script/99/code");
          expect(recorder.calls[1]!.url).toContain(
            "/compute/script/99/publish",
          );
        },
      );
    });

    test("deploys to an explicit script id instead of the host's", async () => {
      await withMocks(
        () => stubFetchRecorder(),
        async (recorder) => {
          const result = await bunnyCdnApi.deployScriptCode("code", 12345);
          expect(result).toEqual({ ok: true });
          expect(recorder.calls[0]!.url).toContain(
            "/compute/script/12345/code",
          );
          expect(recorder.calls[1]!.url).toContain(
            "/compute/script/12345/publish",
          );
        },
      );
    });

    test("returns error when code upload fails", async () => {
      await withMocks(
        () => stubFetchStatus(500, "Server Error"),
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
      await withMocks(
        () => stubFetchRecorder(),
        async (recorder) => {
          const result = await bunnyCdnApi.publishEdgeScript(42);
          expect(result.ok).toBe(true);
          expect(recorder.calls[0]!.url).toContain(
            "/compute/script/42/publish",
          );
          expect(recorder.calls[0]!.init!.method).toBe("POST");
        },
      );
    });

    test("returns error on API failure", async () => {
      await withMocks(
        () => stubFetchStatus(500, "Server Error"),
        async () => {
          const result = await bunnyCdnApi.publishEdgeScript(42);
          expectErrorResult(result, "Publish edge script failed");
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
      await withMocks(
        () => stubFetchRecorder(),
        async (recorder) => {
          const result = await bunnyCdnApi.setEdgeScriptSecret(
            42,
            "DB_URL",
            "libsql://test",
          );
          expect(result.ok).toBe(true);
          expect(recorder.calls[0]!.url).toContain(
            "/compute/script/42/secrets",
          );
          expect(recorder.calls[0]!.init!.method).toBe("PUT");
          const body = JSON.parse(recorder.calls[0]!.init!.body as string);
          expect(body.Name).toBe("DB_URL");
          expect(body.Secret).toBe("libsql://test");
        },
      );
    });

    test("returns error on API failure", async () => {
      await withMocks(
        () => stubFetchStatus(403, "Forbidden"),
        async () => {
          const result = await bunnyCdnApi.setEdgeScriptSecret(
            42,
            "DB_URL",
            "test",
          );
          expectErrorResult(result, "Set secret DB_URL failed");
        },
      );
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
        () => stubFetchJson({ Secrets: secrets }),
        async () => {
          const result = await bunnyCdnApi.listEdgeScriptSecrets(42);
          expect(result).toEqual({ ok: true, secrets });
        },
      );
    });

    test("GETs the script secrets endpoint", async () => {
      const calls: { url: string; init?: RequestInit }[] = [];
      await withMocks(
        () =>
          stub(
            globalThis,
            "fetch",
            (input: string | URL | Request, init?: RequestInit) => {
              calls.push({ init, url: String(input) });
              return Promise.resolve(
                new Response(JSON.stringify({ Secrets: [] })),
              );
            },
          ),
        async () => {
          await bunnyCdnApi.listEdgeScriptSecrets(7);
          expect(calls[0]!.url).toContain("/compute/script/7/secrets");
          // GET is the default method (no explicit method on the request init).
          expect(calls[0]!.init?.method).toBeUndefined();
        },
      );
    });

    test("treats a null Secrets array as empty", async () => {
      await withMocks(
        () => stubFetchJson({ Secrets: null }),
        async () => {
          const result = await bunnyCdnApi.listEdgeScriptSecrets(42);
          expect(result).toEqual({ ok: true, secrets: [] });
        },
      );
    });

    test("returns error on API failure", async () => {
      await withMocks(
        () => stubFetchStatus(403, "Forbidden"),
        async () => {
          const result = await bunnyCdnApi.listEdgeScriptSecrets(42);
          expectErrorResult(result, "List secrets failed (403)");
        },
      );
    });
  },
);

describeWithEnv(
  "updatePullZone",
  { env: { BUNNY_API_KEY: "test-bunny-key" } },
  () => {
    test("sends POST to pull zone with settings payload", async () => {
      await withMocks(
        () => stubFetchRecorder({ status: 200 }),
        async (recorder) => {
          const result = await bunnyCdnApi.updatePullZone(99, {
            DisableCookies: false,
          });
          expect(result.ok).toBe(true);
          expect(recorder.calls[0]!.url).toContain("/pullzone/99");
          expect(recorder.calls[0]!.init!.method).toBe("POST");
          const body = JSON.parse(recorder.calls[0]!.init!.body as string);
          expect(body.DisableCookies).toBe(false);
        },
      );
    });

    test("returns error on API failure", async () => {
      await withMocks(
        () => stubFetchStatus(500, "Server Error"),
        async () => {
          const result = await bunnyCdnApi.updatePullZone(99, {
            DisableCookies: false,
          });
          expectErrorResult(result, "Update pull zone failed");
        },
      );
    });
  },
);
