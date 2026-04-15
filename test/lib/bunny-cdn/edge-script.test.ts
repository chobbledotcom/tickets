import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { stub } from "@std/testing/mock";
import { bunnyCdnApi } from "#lib/bunny-cdn.ts";
import {
  describeWithEnv,
  stubFetchJson,
  stubFetchRecorder,
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
  Id: 1,
  DefaultHostname: defaultHostname,
  LinkedPullZones: pullZones,
});

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

    test("extracts errorKey from JSON error response", async () => {
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
      await withMocks(
        () => stubFetchJson(edgeScriptResponse([])),
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

describeWithEnv(
  "getCdnHostname",
  { env: { BUNNY_API_KEY: "test-bunny-key", BUNNY_SCRIPT_ID: "99" } },
  () => {
    test("converts .bunny.run hostname to .b-cdn.net", async () => {
      await withMocks(
        () => stubFetchJson(edgeScriptResponse([], "https://mysite.bunny.run")),
        async () => {
          const result = await bunnyCdnApi.getCdnHostname();
          expect(result).toEqual({ ok: true, hostname: "mysite.b-cdn.net" });
        },
      );
    });

    test("passes through already-correct b-cdn.net hostname", async () => {
      await withMocks(
        () => stubFetchJson(edgeScriptResponse([], "mysite.b-cdn.net")),
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
  "createEdgeScript",
  { env: { BUNNY_API_KEY: "test-bunny-key", BUNNY_SCRIPT_ID: "99" } },
  () => {
    test("returns script ID, pull zone ID, and hostname on success", async () => {
      await withMocks(
        () =>
          stubFetchJson({
            Id: 42,
            DefaultHostname: "test-42.b-cdn.net",
            LinkedPullZones: [{ Id: 99 }],
          }),
        async () => {
          const result = await bunnyCdnApi.createEdgeScript(
            "Test Script",
            "console.log('test')",
          );
          expect(result).toEqual({
            ok: true,
            scriptId: 42,
            pullZoneId: 99,
            defaultHostname: "test-42.b-cdn.net",
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
            ok: true,
            scriptId: 7,
            pullZoneId: 50,
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
        () =>
          stub(globalThis, "fetch", () =>
            Promise.resolve(new Response("Server Error", { status: 500 })),
          ),
        async () => {
          const result = await bunnyCdnApi.updatePullZone(99, {
            DisableCookies: false,
          });
          expect(result.ok).toBe(false);
          if (!result.ok) {
            expect(result.error).toContain("Update pull zone failed");
          }
        },
      );
    });
  },
);
