import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { stub } from "@std/testing/mock";
import { denoDeployApi, slugifyForDeno } from "#shared/deno-deploy-api.ts";
import { describeWithEnv, withMocks } from "#test-utils";

const DENO_ENV = {
  DENO_DEPLOY_ORG_ID: "test-org-id",
  DENO_DEPLOY_TOKEN: "test-deno-token",
};

/** Stub `fetch` to capture the request URL + JSON body and respond with `responseBody`. */
const captureRequest = (responseBody: unknown) => {
  const captured: {
    body: unknown;
    restore?: () => void;
    url: string | undefined;
  } = { body: undefined, url: undefined };
  return {
    captured,
    fetchStub: stub(
      globalThis,
      "fetch",
      (input: string | URL | Request, init?: RequestInit) => {
        captured.url = String(input);
        captured.body = JSON.parse(init?.body as string);
        return Promise.resolve(
          new Response(JSON.stringify(responseBody), { status: 200 }),
        );
      },
    ),
  };
};

describeWithEnv("deno-deploy-api", { env: DENO_ENV }, () => {
  // ── slugifyForDeno ─────────────────────────────────────────────────────────

  test("slugifyForDeno lowercases and replaces special chars with hyphens", () => {
    expect(slugifyForDeno("My Site Name")).toBe("my-site-name");
    expect(slugifyForDeno("Hello_World!")).toBe("hello-world");
  });

  test("slugifyForDeno collapses consecutive hyphens", () => {
    expect(slugifyForDeno("a  b  c")).toBe("a-b-c");
  });

  test("slugifyForDeno strips leading and trailing hyphens", () => {
    expect(slugifyForDeno("--leading")).toBe("leading");
    expect(slugifyForDeno("trailing--")).toBe("trailing");
  });

  test("slugifyForDeno truncates to 32 chars", () => {
    const result = slugifyForDeno("a".repeat(40));
    expect(result.length).toBeLessThanOrEqual(32);
  });

  test("slugifyForDeno does not produce trailing hyphen when truncation lands on separator", () => {
    const result = slugifyForDeno("Tickets - 12345678901234567890123 A");
    expect(result.endsWith("-")).toBe(false);
    expect(result.length).toBeLessThanOrEqual(32);
  });

  test("slugifyForDeno pads short slugs to at least 3 chars", () => {
    const result = slugifyForDeno("ab");
    expect(result.length).toBeGreaterThanOrEqual(3);
  });

  test("slugifyForDeno handles single-char input", () => {
    const result = slugifyForDeno("a");
    expect(result.length).toBeGreaterThanOrEqual(3);
  });

  // ── createApp ──────────────────────────────────────────────────────────────

  test("createApp POSTs to /v2/apps with orgId and slug", async () => {
    await withMocks(
      () => captureRequest({ id: "app_abc123", slug: "my-app" }),
      async ({ captured }) => {
        const result = await denoDeployApi.createApp("my-app");
        expect(result.ok).toBe(true);
        if (result.ok) {
          expect(result.appId).toBe("app_abc123");
          expect(result.slug).toBe("my-app");
        }
        expect(captured.url).toContain("/v2/apps");
        expect(captured.body).toEqual({ orgId: "test-org-id", slug: "my-app" });
      },
    );
  });

  test("createApp uses Bearer auth header", async () => {
    let authHeader: string | undefined;

    await withMocks(
      () =>
        stub(
          globalThis,
          "fetch",
          (input: string | URL | Request, init?: RequestInit) => {
            authHeader = (init?.headers as Record<string, string>)
              ?.Authorization;
            return Promise.resolve(
              new Response(
                JSON.stringify({ id: "app_auth", slug: "auth-app" }),
                { status: 200 },
              ),
            );
          },
        ),
      async () => {
        await denoDeployApi.createApp("auth-app");
        expect(authHeader).toBe("Bearer test-deno-token");
      },
    );
  });

  test("createApp returns error when API responds with failure", async () => {
    await withMocks(
      () =>
        stub(globalThis, "fetch", () =>
          Promise.resolve(
            new Response(JSON.stringify({ message: "Invalid slug" }), {
              status: 400,
            }),
          ),
        ),
      async () => {
        const result = await denoDeployApi.createApp("bad");
        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.error).toContain("Create app failed (400)");
          expect(result.error).toContain("Invalid slug");
        }
      },
    );
  });

  // ── setEnvVars ─────────────────────────────────────────────────────────────

  test("setEnvVars PATCHes only the supplied vars (no GET)", async () => {
    let patchUrl: string | undefined;
    let patchBody: unknown;
    let callCount = 0;

    await withMocks(
      () =>
        stub(
          globalThis,
          "fetch",
          (input: string | URL | Request, init?: RequestInit) => {
            callCount++;
            patchUrl = String(input);
            patchBody = JSON.parse(init?.body as string);
            return Promise.resolve(
              new Response(JSON.stringify({ id: "app_ev", slug: "env-app" }), {
                status: 200,
              }),
            );
          },
        ),
      async () => {
        const result = await denoDeployApi.setEnvVars("app_ev", [
          ["NEW_VAR", "new-value"],
        ]);
        expect(result.ok).toBe(true);
        expect(callCount).toBe(1);
        expect(patchUrl).toContain("/apps/app_ev");
        const envVars = (patchBody as { env_vars: { key: string }[] }).env_vars;
        expect(envVars.map((e) => e.key)).toContain("NEW_VAR");
      },
    );
  });

  test("setEnvVars returns error when PATCH fails", async () => {
    await withMocks(
      () =>
        stub(globalThis, "fetch", () =>
          Promise.resolve(
            new Response(JSON.stringify({ error: "invalid env var name" }), {
              status: 422,
            }),
          ),
        ),
      async () => {
        const result = await denoDeployApi.setEnvVars("app_pe", [
          ["BAD VAR", "v"],
        ]);
        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.error).toContain("Set app env vars failed (422)");
          expect(result.error).toContain("invalid env var name");
        }
      },
    );
  });

  // ── deployCode ─────────────────────────────────────────────────────────────

  test("deployCode POSTs assets and config to /deployments endpoint", async () => {
    await withMocks(
      () => captureRequest({ domains: ["my-app.deno.dev"], id: "dep_123" }),
      async ({ captured }) => {
        const result = await denoDeployApi.deployCode(
          "app_dc",
          "console.log('hello')",
        );
        expect(result.ok).toBe(true);
        if (result.ok) {
          expect(result.hostname).toBe("https://my-app.deno.dev");
        }
        expect(captured.url).toContain("/apps/app_dc/deployments");
        expect(
          (captured.body as { assets: { "main.ts": { content: string } } })
            .assets["main.ts"].content,
        ).toBe("console.log('hello')");
      },
    );
  });

  test("deployCode falls back to hostnames when domains is empty", async () => {
    await withMocks(
      () =>
        stub(globalThis, "fetch", () =>
          Promise.resolve(
            new Response(
              JSON.stringify({
                hostnames: ["fallback.deno.dev"],
                id: "dep_fb",
              }),
              { status: 200 },
            ),
          ),
        ),
      async () => {
        const result = await denoDeployApi.deployCode("app_fb", "code");
        expect(result.ok).toBe(true);
        if (result.ok) {
          expect(result.hostname).toBe("https://fallback.deno.dev");
        }
      },
    );
  });

  test("deployCode returns error when response has no hostname", async () => {
    await withMocks(
      () =>
        stub(globalThis, "fetch", () =>
          Promise.resolve(
            new Response(JSON.stringify({ id: "dep_nh" }), { status: 200 }),
          ),
        ),
      async () => {
        const result = await denoDeployApi.deployCode("app_nh", "code");
        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.error).toContain("no hostname");
        }
      },
    );
  });

  test("deployCode returns error when API responds with failure", async () => {
    await withMocks(
      () =>
        stub(globalThis, "fetch", () =>
          Promise.resolve(
            new Response(JSON.stringify({ message: "app not found" }), {
              status: 404,
            }),
          ),
        ),
      async () => {
        const result = await denoDeployApi.deployCode("app_missing", "code");
        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.error).toContain("Deploy code failed (404)");
          expect(result.error).toContain("app not found");
        }
      },
    );
  });

  // ── getEnvVarNames ─────────────────────────────────────────────────────────

  test("getEnvVarNames returns names of set env vars", async () => {
    await withMocks(
      () =>
        stub(globalThis, "fetch", () =>
          Promise.resolve(
            new Response(
              JSON.stringify({
                env_vars: {
                  DB_TOKEN: { is_secret: true, value: "" },
                  DB_URL: { is_secret: true, value: "" },
                },
                id: "app_gn",
                slug: "gn-app",
              }),
              { status: 200 },
            ),
          ),
        ),
      async () => {
        const result = await denoDeployApi.getEnvVarNames("app_gn");
        expect(result.ok).toBe(true);
        if (result.ok) {
          expect(result.names).toContain("DB_URL");
          expect(result.names).toContain("DB_TOKEN");
          expect(result.names.length).toBe(2);
        }
      },
    );
  });

  test("getEnvVarNames returns empty array when no env vars are set", async () => {
    await withMocks(
      () =>
        stub(globalThis, "fetch", () =>
          Promise.resolve(
            new Response(
              JSON.stringify({ env_vars: {}, id: "app_empty", slug: "empty" }),
              { status: 200 },
            ),
          ),
        ),
      async () => {
        const result = await denoDeployApi.getEnvVarNames("app_empty");
        expect(result.ok).toBe(true);
        if (result.ok) {
          expect(result.names).toEqual([]);
        }
      },
    );
  });

  test("getEnvVarNames returns empty array when env_vars field is absent", async () => {
    await withMocks(
      () =>
        stub(globalThis, "fetch", () =>
          Promise.resolve(
            new Response(JSON.stringify({ id: "app_no_ev", slug: "no-ev" }), {
              status: 200,
            }),
          ),
        ),
      async () => {
        const result = await denoDeployApi.getEnvVarNames("app_no_ev");
        expect(result.ok).toBe(true);
        if (result.ok) {
          expect(result.names).toEqual([]);
        }
      },
    );
  });

  test("getEnvVarNames returns error when API fails", async () => {
    await withMocks(
      () =>
        stub(globalThis, "fetch", () =>
          Promise.resolve(
            new Response(JSON.stringify({ error: "app not found" }), {
              status: 404,
            }),
          ),
        ),
      async () => {
        const result = await denoDeployApi.getEnvVarNames("app_bad");
        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.error).toContain("Get app failed (404)");
          expect(result.error).toContain("app not found");
        }
      },
    );
  });
});
