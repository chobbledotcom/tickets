import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { stub } from "@std/testing/mock";
import { denoDeployApi, slugifyForDeno } from "#shared/deno-deploy-api.ts";
import { describeWithEnv, withMocks } from "#test-utils";

const DENO_ENV = {
  DENO_DEPLOY_ORG_ID: "test-org-id",
  DENO_DEPLOY_TOKEN: "test-deno-token",
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
    let requestBody: unknown;
    let requestUrl: string | undefined;

    await withMocks(
      () =>
        stub(
          globalThis,
          "fetch",
          (input: string | URL | Request, init?: RequestInit) => {
            requestUrl = String(input);
            requestBody = JSON.parse(init?.body as string);
            return Promise.resolve(
              new Response(
                JSON.stringify({ id: "app_abc123", slug: "my-app" }),
                { status: 200 },
              ),
            );
          },
        ),
      async () => {
        const result = await denoDeployApi.createApp("my-app");
        expect(result.ok).toBe(true);
        if (result.ok) {
          expect(result.appId).toBe("app_abc123");
          expect(result.slug).toBe("my-app");
        }
        expect(requestUrl).toContain("/v2/apps");
        expect(requestBody).toEqual({ orgId: "test-org-id", slug: "my-app" });
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

  test("setEnvVars GETs existing vars then PATCHes merged set", async () => {
    const calls: { method?: string; url: string; body?: unknown }[] = [];

    await withMocks(
      () =>
        stub(
          globalThis,
          "fetch",
          (input: string | URL | Request, init?: RequestInit) => {
            const url = String(input);
            const method = init?.method ?? "GET";
            const body = init?.body
              ? JSON.parse(init.body as string)
              : undefined;
            calls.push({ body, method, url });

            if (method === "GET" || !method) {
              return Promise.resolve(
                new Response(
                  JSON.stringify({
                    env_vars: {
                      EXISTING_VAR: { is_secret: false, value: "old-value" },
                    },
                    id: "app_ev",
                    slug: "env-app",
                  }),
                  { status: 200 },
                ),
              );
            }

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

        const getCall = calls.find((c) => c.method === "GET" || !c.method);
        expect(getCall?.url).toContain("/apps/app_ev");

        const patchCall = calls.find((c) => c.method === "PATCH");
        expect(patchCall).toBeDefined();
        expect(patchCall?.url).toContain("/apps/app_ev");

        const envVars = (patchCall?.body as { env_vars: unknown[] }).env_vars;
        const keys = (envVars as { key: string }[]).map((e) => e.key);
        expect(keys).toContain("EXISTING_VAR");
        expect(keys).toContain("NEW_VAR");
      },
    );
  });

  test("setEnvVars new values override existing ones with same key", async () => {
    let patchBody: { env_vars: { key: string; value: string }[] } | undefined;

    await withMocks(
      () =>
        stub(
          globalThis,
          "fetch",
          (input: string | URL | Request, init?: RequestInit) => {
            const method = init?.method ?? "GET";

            if (method === "PATCH") {
              patchBody = JSON.parse(init?.body as string);
              return Promise.resolve(
                new Response(JSON.stringify({ id: "app_ov" }), { status: 200 }),
              );
            }

            return Promise.resolve(
              new Response(
                JSON.stringify({
                  env_vars: { MY_VAR: { is_secret: true, value: "original" } },
                  id: "app_ov",
                }),
                { status: 200 },
              ),
            );
          },
        ),
      async () => {
        await denoDeployApi.setEnvVars("app_ov", [["MY_VAR", "updated"]]);

        const myVar = patchBody?.env_vars.find((e) => e.key === "MY_VAR");
        expect(myVar?.value).toBe("updated");
      },
    );
  });

  test("setEnvVars returns error when GET fails", async () => {
    await withMocks(
      () =>
        stub(globalThis, "fetch", () =>
          Promise.resolve(new Response("Not Found", { status: 404 })),
        ),
      async () => {
        const result = await denoDeployApi.setEnvVars("app_bad", [["X", "y"]]);
        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.error).toContain("Get app failed (404)");
        }
      },
    );
  });

  test("setEnvVars returns error when PATCH fails", async () => {
    await withMocks(
      () =>
        stub(
          globalThis,
          "fetch",
          (input: string | URL | Request, init?: RequestInit) => {
            const method = init?.method ?? "GET";
            if (method === "PATCH") {
              return Promise.resolve(
                new Response(
                  JSON.stringify({ error: "invalid env var name" }),
                  { status: 422 },
                ),
              );
            }
            return Promise.resolve(
              new Response(JSON.stringify({ env_vars: {}, id: "app_pe" }), {
                status: 200,
              }),
            );
          },
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
    let requestUrl: string | undefined;
    let requestBody: unknown;

    await withMocks(
      () =>
        stub(
          globalThis,
          "fetch",
          (input: string | URL | Request, init?: RequestInit) => {
            requestUrl = String(input);
            requestBody = JSON.parse(init?.body as string);
            return Promise.resolve(
              new Response(
                JSON.stringify({
                  domains: ["my-app.deno.dev"],
                  id: "dep_123",
                }),
                { status: 200 },
              ),
            );
          },
        ),
      async () => {
        const result = await denoDeployApi.deployCode(
          "app_dc",
          "console.log('hello')",
        );
        expect(result.ok).toBe(true);
        if (result.ok) {
          expect(result.hostname).toBe("https://my-app.deno.dev");
        }
        expect(requestUrl).toContain("/apps/app_dc/deployments");
        expect(
          (requestBody as { assets: { "main.ts": { content: string } } })
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
