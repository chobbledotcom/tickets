import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { stub } from "@std/testing/mock";
import { builtSites, insertBuiltSite } from "#db/built-sites.ts";
import { addMonthsIso } from "#shared/dates.ts";
import { denoDeployApi } from "#shared/deno-deploy-api.ts";
import { nowIso } from "#shared/now.ts";
import {
  parseReadOnlyFromMs,
  syncReadOnlyFrom,
} from "#shared/site-assignment.ts";
import { describeWithEnv } from "#test-utils/db.ts";

describeWithEnv(
  "syncReadOnlyFrom (Deno site)",
  { db: true, env: { DENO_DEPLOY_TOKEN: "tok123" } },
  () => {
    type SetEnvVarsStub = Pick<ReturnType<typeof stub>, "calls" | "restore">;

    const expectSetEnvVarIncludes = (
      setStub: SetEnvVarsStub,
      key: string,
    ): void => {
      const pairs = setStub.calls[0]!.args[1] as [string, string][];
      expect(pairs.some(([k]) => k === key)).toBe(true);
    };

    const withStubbedSetEnvVars = async <T>(
      body: (setStub: SetEnvVarsStub) => Promise<T>,
    ): Promise<T> => {
      const setStub = stub(denoDeployApi, "setEnvVars", () =>
        Promise.resolve({ ok: true as const, value: undefined }),
      );
      try {
        return await body(setStub);
      } finally {
        setStub.restore();
      }
    };

    test("pushes secrets via denoDeployApi.setEnvVars for a Deno site", async () => {
      await insertBuiltSite(
        "Deno Sync",
        "https://app.deno.dev",
        "",
        "",
        false,
        "app_deno_123",
        "release",
        "deno",
      );
      const site = (await builtSites.getAll()).find(
        (s) => s.name === "Deno Sync",
      )!;

      await withStubbedSetEnvVars(async (setStub) => {
        const result = await syncReadOnlyFrom(site, addMonthsIso(nowIso(), 3));
        expect(result.ok).toBe(true);
        expect(setStub.calls).toHaveLength(1);
        expectSetEnvVarIncludes(setStub, "READ_ONLY_FROM");
      });
    });

    test("pushes both READ_ONLY_FROM and RENEWAL_URL when renewalUrl is provided", async () => {
      await insertBuiltSite(
        "Deno Sync Both",
        "https://app.deno.dev",
        "",
        "",
        false,
        "app_deno_456",
        "release",
        "deno",
      );
      const site = (await builtSites.getAll()).find(
        (s) => s.name === "Deno Sync Both",
      )!;

      await withStubbedSetEnvVars(async (setStub) => {
        const result = await syncReadOnlyFrom(
          site,
          addMonthsIso(nowIso(), 3),
          "https://example.com/renew/token123",
        );
        expect(result.ok).toBe(true);
        expectSetEnvVarIncludes(setStub, "READ_ONLY_FROM");
        expectSetEnvVarIncludes(setStub, "RENEWAL_URL");
      });
    });
  },
);

describe("syncReadOnlyFrom with non-numeric bunny hostingId", () => {
  test("returns error when bunny hostingId is not a valid number", async () => {
    const { testBuiltSite } = await import("#test-utils/factories.ts");
    const site = testBuiltSite({
      hostingId: "not-a-number",
      hostingProvider: "bunny",
    });
    const result = await syncReadOnlyFrom(site, "2099-01-01T00:00:00Z");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("No hostingId");
  });
});

describe("parseReadOnlyFromMs", () => {
  test("returns null for invalid date string", () => {
    expect(parseReadOnlyFromMs({ readOnlyFrom: "not-a-date" })).toBeNull();
  });

  test("returns null for empty string", () => {
    expect(parseReadOnlyFromMs({ readOnlyFrom: "" })).toBeNull();
  });

  test("returns ms for valid date", () => {
    const ms = parseReadOnlyFromMs({ readOnlyFrom: "2026-06-01T00:00:00Z" });
    expect(ms).not.toBeNull();
    expect(ms).toBeGreaterThan(0);
  });
});
