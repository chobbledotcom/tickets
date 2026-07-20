import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import {
  denoDeployApi,
  denoHostingProvider,
  slugifyForDeno,
} from "#shared/deno-deploy-api.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { stubFetch } from "#test-utils/fetch-stub.ts";

const DENO_ENV = {
  DENO_DEPLOY_ORG_ID: "test-org-id",
  DENO_DEPLOY_TOKEN: "test-deno-token",
};

interface CapturedRequest {
  body: unknown;
  contentType?: string | null;
  method?: string;
  url: string | undefined;
}

/** Capture the request URL + JSON body and respond with `responseBody`. */
const captureRequest =
  (responseBody: unknown, captured: CapturedRequest) =>
  (url: string, init?: RequestInit): Response => {
    captured.url = url;
    captured.body = JSON.parse(init?.body as string);
    captured.contentType = new Headers(init?.headers).get("content-type");
    if (init?.method !== undefined) captured.method = init.method;
    return new Response(JSON.stringify(responseBody));
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
    expect(slugifyForDeno("ab")).toBe("abapp");
  });

  test("slugifyForDeno handles single-char input", () => {
    expect(slugifyForDeno("a")).toBe("aapp");
  });

  // ── createApp ──────────────────────────────────────────────────────────────

  test("createApp POSTs to /v2/apps with orgId and slug", async () => {
    const captured: CapturedRequest = { body: undefined, url: undefined };
    using _fetch = stubFetch(
      captureRequest({ id: "app_abc123", slug: "my-app" }, captured),
    );
    const result = await denoDeployApi.createApp("my-app");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.appId).toBe("app_abc123");
      expect(result.value.slug).toBe("my-app");
    }
    expect(captured.url).toContain("/v2/apps");
    expect(captured.body).toEqual({ orgId: "test-org-id", slug: "my-app" });
    expect(captured.contentType).toBe("application/json");
    expect(captured.method).toBe("POST");
  });

  test("createApp uses Bearer auth header", async () => {
    let authHeader: string | undefined;

    using _fetch = stubFetch((_url, init) => {
      authHeader = (init?.headers as Record<string, string>)?.Authorization;
      return new Response(JSON.stringify({ id: "app_auth", slug: "auth-app" }));
    });
    await denoDeployApi.createApp("auth-app");
    expect(authHeader).toBe("Bearer test-deno-token");
  });

  test("createApp returns error when API responds with failure", async () => {
    using _fetch = stubFetch(
      new Response(JSON.stringify({ message: "Invalid slug" }), {
        status: 400,
      }),
    );
    const result = await denoDeployApi.createApp("bad");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("Create app failed (400)");
      expect(result.error).toContain("Invalid slug");
    }
  });

  // ── setEnvVars ─────────────────────────────────────────────────────────────

  test("setEnvVars PATCHes only the supplied vars (no GET)", async () => {
    const captured: CapturedRequest = { body: undefined, url: undefined };
    let callCount = 0;

    using _fetch = stubFetch((url, init) => {
      callCount++;
      return captureRequest({ id: "app_ev", slug: "env-app" }, captured)(
        url,
        init,
      );
    });
    const result = await denoDeployApi.setEnvVars("app_ev", [
      ["NEW_VAR", "new-value"],
    ]);
    expect(result.ok).toBe(true);
    expect(callCount).toBe(1);
    expect(captured.url).toContain("/apps/app_ev");
    expect(captured.method).toBe("PATCH");
    expect(captured.body).toEqual({
      env_vars: [
        {
          contexts: ["production"],
          key: "NEW_VAR",
          secret: true,
          value: "new-value",
        },
      ],
    });
  });

  test("setEnvVars returns error when PATCH fails", async () => {
    using _fetch = stubFetch(
      new Response(JSON.stringify({ error: "invalid env var name" }), {
        status: 422,
      }),
    );
    const result = await denoDeployApi.setEnvVars("app_pe", [["BAD VAR", "v"]]);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("Set app env vars failed (422)");
      expect(result.error).toContain("invalid env var name");
    }
  });

  // ── deployCode ─────────────────────────────────────────────────────────────

  test("deployCode POSTs assets and config to the revision endpoint", async () => {
    const captured: CapturedRequest = { body: undefined, url: undefined };
    using _fetch = stubFetch(
      captureRequest({ domains: ["my-app.deno.dev"], id: "dep_123" }, captured),
    );
    const result = await denoDeployApi.deployCode(
      "app_dc",
      "console.log('hello')",
    );
    expect(result).toEqual({ ok: true, value: undefined });
    expect(captured.url).toBe("https://api.deno.com/v2/apps/app_dc/deploy");
    expect(captured.method).toBe("POST");
    expect(captured.body).toEqual({
      assets: {
        "main.ts": {
          content: "console.log('hello')",
          encoding: "utf-8",
          kind: "file",
        },
      },
      config: { runtime: { entrypoint: "main.ts", type: "dynamic" } },
      production: true,
    });
  });

  test("deployCode returns error when API responds with failure", async () => {
    using _fetch = stubFetch(
      new Response(JSON.stringify({ message: "app not found" }), {
        status: 404,
      }),
    );
    const result = await denoDeployApi.deployCode("app_missing", "code");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("Deploy code failed (404)");
      expect(result.error).toContain("app not found");
    }
  });

  // ── getEnvVarNames ─────────────────────────────────────────────────────────

  test("getEnvVarNames returns names of set env vars", async () => {
    using _fetch = stubFetch(
      new Response(
        JSON.stringify({
          env_vars: {
            DB_TOKEN: { is_secret: true, value: "" },
            DB_URL: { is_secret: true, value: "" },
          },
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
        JSON.stringify({ env_vars: {}, id: "app_empty", slug: "empty" }),
      ),
    );
    const result = await denoDeployApi.getEnvVarNames("app_empty");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toEqual([]);
    }
  });

  test("getEnvVarNames returns empty when env_vars is omitted", async () => {
    using _fetch = stubFetch(
      new Response(JSON.stringify({ id: "app_no_ev", slug: "no-ev" })),
    );
    const result = await denoDeployApi.getEnvVarNames("app_no_ev");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toEqual([]);
    }
  });

  test("getEnvVarNames returns error when API fails", async () => {
    using _fetch = stubFetch(
      new Response(JSON.stringify({ error: "app not found" }), { status: 404 }),
    );
    const result = await denoDeployApi.getEnvVarNames("app_bad");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("Get app failed (404)");
      expect(result.error).toContain("app not found");
    }
  });

  test("hosting provider names its required credential", () => {
    expect(denoHostingProvider.configEnvVar).toBe("DENO_DEPLOY_TOKEN");
  });

  test("hosting publish returns only provider success", async () => {
    using _fetch = stubFetch(
      new Response(JSON.stringify({ domains: ["child.deno.dev"], id: "dep" })),
    );

    expect(await denoHostingProvider.publishSite("app_1", "code")).toEqual({
      ok: true,
    });
  });

  test("hosting publish preserves provider failure", async () => {
    using _fetch = stubFetch(new Response("failed", { status: 500 }));

    expect(await denoHostingProvider.publishSite("app_1", "code")).toEqual({
      error: "Deploy code failed (500): failed",
      ok: false,
    });
  });
});
