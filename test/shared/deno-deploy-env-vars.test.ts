import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { denoDeployApi } from "#shared/deno-deploy-api.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { stubFetch } from "#test-utils/fetch-stub.ts";

/** The env-var view of a Deno Deploy app, exercised against stubbed API
 * responses. Shared by the secrets backfill (names) and the Support message
 * tab (values). */
describeWithEnv(
  "deno-deploy-api env vars",
  { env: { DENO_DEPLOY_ORG_ID: "org", DENO_DEPLOY_TOKEN: "token" } },
  () => {
    test("getEnvVarNames returns names of set env vars", async () => {
      using _fetch = stubFetch(
        new Response(
          JSON.stringify({
            env_vars: [
              { key: "DB_TOKEN", secret: true },
              { key: "DB_URL", secret: true },
            ],
            id: "app_gn",
            slug: "gn-app",
          }),
        ),
      );
      const result = await denoDeployApi.getEnvVarNames("app_gn");
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toContain("DB_URL");
        expect(result.value).toContain("DB_TOKEN");
        expect(result.value.length).toBe(2);
      }
    });

    test("getEnvVarNames returns empty array when no env vars are set", async () => {
      using _fetch = stubFetch(
        new Response(
          JSON.stringify({ env_vars: [], id: "app_empty", slug: "empty" }),
        ),
      );
      const result = await denoDeployApi.getEnvVarNames("app_empty");
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toEqual([]);
      }
    });

    test("getEnvVarNames rejects an app response without env vars", async () => {
      using _fetch = stubFetch(
        new Response(JSON.stringify({ id: "app_no_ev", slug: "no-ev" })),
      );
      await expect(denoDeployApi.getEnvVarNames("app_no_ev")).rejects.toThrow();
    });

    test("getEnvVarNames returns error when API fails", async () => {
      using _fetch = stubFetch(
        new Response(JSON.stringify({ error: "app not found" }), {
          status: 404,
        }),
      );
      const result = await denoDeployApi.getEnvVarNames("app_bad");
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toContain("Get app failed (404)");
        expect(result.error).toContain("app not found");
      }
    });

    test("getAppEnvVars reports plain values and secret masking", async () => {
      using _fetch = stubFetch(
        new Response(
          JSON.stringify({
            env_vars: [
              { key: "PLAIN", secret: false, value: "shown" },
              { key: "SECRET", secret: true },
            ],
            id: "app_ga",
            slug: "ga-app",
          }),
        ),
      );
      const result = await denoDeployApi.getAppEnvVars("app_ga");
      expect(result).toEqual({
        ok: true,
        value: [
          { key: "PLAIN", secret: false, value: "shown" },
          { key: "SECRET", secret: true, value: undefined },
        ],
      });
    });

    test("getAppEnvVars rejects a plain entry that carries no value", async () => {
      using _fetch = stubFetch(
        new Response(
          JSON.stringify({
            env_vars: [{ key: "SUPPORT_PAGE_TEXT", secret: false }],
            id: "app_pv",
            slug: "pv-app",
          }),
        ),
      );
      await expect(denoDeployApi.getAppEnvVars("app_pv")).rejects.toThrow();
    });

    test("setEnvVar PATCHes one entry with its plain/secret flag", async () => {
      const captured: { body: unknown; method?: string | undefined } = {
        body: undefined,
      };
      using _fetch = stubFetch((_url: string, init?: RequestInit) => {
        captured.body = JSON.parse(init?.body as string);
        captured.method = init?.method;
        return new Response(JSON.stringify({ id: "app_se", slug: "se-app" }));
      });
      const result = await denoDeployApi.setEnvVar("app_se", {
        key: "SUPPORT_PAGE_TEXT",
        secret: false,
        value: "# Help",
      });
      expect(result.ok).toBe(true);
      expect(captured.method).toBe("PATCH");
      expect(captured.body).toEqual({
        env_vars: [
          {
            contexts: ["production"],
            key: "SUPPORT_PAGE_TEXT",
            secret: false,
            value: "# Help",
          },
        ],
      });
    });

    test("setEnvVar returns error when PATCH fails", async () => {
      using _fetch = stubFetch(
        new Response(JSON.stringify({ error: "bad var" }), { status: 422 }),
      );
      const result = await denoDeployApi.setEnvVar("app_bad", {
        key: "K",
        value: "v",
      });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toContain("Set app env var failed (422)");
      }
    });
  },
);
