/* jscpd:ignore-start -- imports */
import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { bunnyCdnApi } from "#shared/bunny-cdn.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { stubFetch } from "#test-utils/fetch-stub.ts";
import { withMocks } from "#test-utils/mocks.ts";
/* jscpd:ignore-end */
import { expectErrorResult } from "./bunny/fixtures.ts";

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
