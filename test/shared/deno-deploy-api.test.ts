import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { stub } from "@std/testing/mock";
import { denoDeployApi, denoHostingProvider } from "#shared/deno-deploy-api.ts";
import { okResult } from "#shared/result.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { stubFetch } from "#test-utils/fetch-stub.ts";
import { withVirtualBackoff } from "#test-utils/virtual-time.ts";

const DENO_ENV = {
  DENO_DEPLOY_ORG_ID: "test-org-id",
  DENO_DEPLOY_ORG_SLUG: "test-org",
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
      captureRequest({ id: "dep_123", status: "succeeded" }, captured),
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

  test("deployCode waits for an accepted revision to succeed", async () => {
    const requests: string[] = [];
    const requestTimes: number[] = [];
    const responses = [
      { id: "revision-1", status: "queued" },
      { id: "revision-1", status: "building" },
      { id: "revision-1", status: "succeeded" },
    ];
    using _fetch = stubFetch((url) => {
      requests.push(String(url));
      requestTimes.push(Date.now());
      return Response.json(responses.shift());
    });

    expect(
      await withVirtualBackoff(() => denoDeployApi.deployCode("app_1", "code")),
    ).toEqual({ ok: true, value: undefined });
    expect(requests).toEqual([
      "https://api.deno.com/v2/apps/app_1/deploy",
      "https://api.deno.com/v2/revisions/revision-1",
      "https://api.deno.com/v2/revisions/revision-1",
    ]);
    expect(requestTimes.map((time) => time - requestTimes[0]!)).toEqual([
      0, 1_000, 2_000,
    ]);
  });

  test("deployCode reports a failed accepted revision", async () => {
    using _fetch = stubFetch(
      Response.json({
        failure_reason: "error",
        id: "revision-failed",
        status: "failed",
      }),
    );

    expect(await denoDeployApi.deployCode("app_1", "code")).toEqual({
      error: "Deno revision revision-failed failed: error",
      ok: false,
    });
  });

  test("deployCode reports a skipped accepted revision", async () => {
    using _fetch = stubFetch(
      Response.json({ id: "revision-skipped", status: "skipped" }),
    );

    expect(await denoDeployApi.deployCode("app_1", "code")).toEqual({
      error: "Deno revision revision-skipped skipped: skipped",
      ok: false,
    });
  });

  test("deployCode reports a revision that never finishes", async () => {
    using _fetch = stubFetch(() =>
      Response.json({ id: "revision-pending", status: "queued" }),
    );

    expect(
      await withVirtualBackoff(() => denoDeployApi.deployCode("app_1", "code")),
    ).toEqual({
      error: "Deno revision revision-pending did not finish within 20 seconds",
      ok: false,
    });
  });

  test("deployCode reports repeated revision read failures", async () => {
    const calls = { value: 0 };
    using _fetch = stubFetch(() => {
      calls.value += 1;
      return calls.value === 1
        ? Response.json({ id: "revision-unreadable", status: "queued" })
        : new Response("unavailable", { status: 503 });
    });

    expect(
      await withVirtualBackoff(() => denoDeployApi.deployCode("app_1", "code")),
    ).toEqual({
      error:
        "Deno revision revision-unreadable could not be read: Get revision failed (503): unavailable",
      ok: false,
    });
  });

  test("deployCode rejects an undocumented revision response", async () => {
    using _fetch = stubFetch(
      Response.json({ id: "revision-unknown", status: "running" }),
    );

    await expect(denoDeployApi.deployCode("app_1", "code")).rejects.toThrow();
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
          env_vars: [{ key: "DB_TOKEN" }, { key: "DB_URL" }],
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

  test("hosting provider builds the Deno v2 production domain", async () => {
    using _create = stub(denoDeployApi, "createApp", () =>
      Promise.resolve(okResult({ appId: "app_1", slug: "child" })),
    );
    using _secrets = stub(denoDeployApi, "setEnvVars", () =>
      Promise.resolve(okResult(undefined)),
    );

    expect(await denoHostingProvider.prepareSite("Child", "code", [])).toEqual({
      ok: true,
      value: {
        defaultHostname: "https://child.test-org.deno.net",
        hostingId: "app_1",
      },
    });
  });

  test("hosting publish returns only provider success", async () => {
    using _fetch = stubFetch(Response.json({ id: "dep", status: "succeeded" }));

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
