/**
 * The Deno half of the Support message module: a plain env var record the
 * production isolate serves, read through its documented id and contexts and
 * written back in place.
 */

import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { stub } from "@std/testing/mock";
import {
  type DenoEnvVarUpdate,
  denoDeployApi,
} from "#shared/deno-deploy-api.ts";
import type { DenoEnvVar } from "#shared/deno-deploy-schema.ts";
import {
  loadSiteSupportMessage,
  SUPPORT_MESSAGE_KEY,
  supportMessageApi,
} from "#shared/site-support-message.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { withMocks } from "#test-utils/mocks.ts";
import { bunnySite, expectErrorResult } from "./fixtures.ts";

/** One documented Deno env var record for a stub. */
const record = (
  id: string,
  contexts: "all" | string[],
  value: string | undefined,
): DenoEnvVar =>
  value === undefined
    ? { contexts, id, key: SUPPORT_MESSAGE_KEY, secret: true }
    : { contexts, id, key: SUPPORT_MESSAGE_KEY, secret: false, value };

/** The getAppEnvVars stub answering `records`. */
const appEnvVars = (records: DenoEnvVar[]) =>
  stub(denoDeployApi, "getAppEnvVars", () =>
    Promise.resolve({ ok: true as const, value: records }),
  );

describe("site support message on Deno Deploy", () => {
  test("reads a Deno app's plain variable and masks its secrets", async () => {
    using _appEnvVars = appEnvVars([record("env-1", "all", "old")]);
    expect(await supportMessageApi.readSupportMessage("deno", "app-1")).toEqual(
      { ok: true, value: "old" },
    );
  });

  test("reads null from a Deno app whose entry is a secret", async () => {
    using _appEnvVars = appEnvVars([record("env-2", "all", undefined)]);
    expect(await supportMessageApi.readSupportMessage("deno", "app-1")).toEqual(
      { ok: true, value: null },
    );
  });

  test("reads the serving record, not a record for another context", async () => {
    // Deno's documented contexts can hold the same key in several records.
    // A production-specific record overrides the all-context fallback on the
    // site, so the editor reads and updates the production one even when the
    // fallback is listed first.
    using _appEnvVars = appEnvVars([
      record("env-3", "all", "fallback copy"),
      record("env-4", ["production"], "serving copy"),
    ]);
    expect(await supportMessageApi.readSupportMessage("deno", "app-1")).toEqual(
      { ok: true, value: "serving copy" },
    );
  });

  test("reports a failed Deno env-var read as an error result", async () => {
    using _appEnvVars = stub(denoDeployApi, "getAppEnvVars", () =>
      Promise.resolve({
        error: "Get app failed (404): no app",
        ok: false as const,
      }),
    );
    expectErrorResult(
      await supportMessageApi.readSupportMessage("deno", "app-1"),
      "Get app failed (404)",
    );
  });

  test("reports a failed Deno env-var write as an error result", async () => {
    using _appEnvVars = appEnvVars([]);
    using _setEnvVar = stub(denoDeployApi, "setEnvVar", () =>
      Promise.resolve({
        error: "Set app env var failed (422): bad var",
        ok: false as const,
      }),
    );
    expectErrorResult(
      await supportMessageApi.setSupportMessage("deno", "app-1", "# New"),
      "Set app env var failed (422)",
    );
  });

  test("reports a failed read before the Deno write starts", async () => {
    using _appEnvVars = stub(denoDeployApi, "getAppEnvVars", () =>
      Promise.resolve({
        error: "Get app failed (404): no app",
        ok: false as const,
      }),
    );
    using _setEnvVar = stub(denoDeployApi, "setEnvVar", () =>
      Promise.resolve({ ok: true as const, value: undefined }),
    );
    expectErrorResult(
      await supportMessageApi.setSupportMessage("deno", "app-1", "# New"),
      "Get app failed (404)",
    );
    // The read failure stops the write before it starts.
    expect(_setEnvVar.calls).toHaveLength(0);
  });

  test("updates the serving record's id and creates one when absent", async () => {
    // An existing record keeps its id, so a dashboard-created all-contexts
    // record is edited in place instead of shadowed by a second production
    // entry the tab would never read again. When a production-specific
    // record exists beside the fallback, it is the one that gets updated.
    const seen: { appId: string; entry: DenoEnvVarUpdate }[] = [];
    using _setEnvVar = stub(
      denoDeployApi,
      "setEnvVar",
      (appId: string, entry: DenoEnvVarUpdate) => {
        seen.push({ appId, entry });
        return Promise.resolve({ ok: true as const, value: undefined });
      },
    );

    await withMocks(
      () => appEnvVars([record("env-9", "all", "old")]),
      async () => {
        expect(
          await supportMessageApi.setSupportMessage("deno", "app-1", "# New"),
        ).toEqual({ ok: true, value: "# New" });
        expect(seen).toEqual([
          {
            appId: "app-1",
            entry: { ...record("env-9", "all", "# New") },
          },
        ]);
      },
    );

    await withMocks(
      () =>
        appEnvVars([
          record("env-5", "all", "fallback"),
          record("env-6", ["production"], "serving"),
        ]),
      async () => {
        expect(
          await supportMessageApi.setSupportMessage("deno", "app-1", "# Newer"),
        ).toEqual({ ok: true, value: "# Newer" });
        expect(seen).toEqual([
          {
            appId: "app-1",
            entry: { ...record("env-9", "all", "# New") },
          },
          {
            appId: "app-1",
            entry: { ...record("env-6", ["production"], "# Newer") },
          },
        ]);
      },
    );
  });

  describeWithEnv(
    "site support message on Deno Deploy without the provider keys",
    { env: { BUNNY_API_KEY: undefined, DENO_DEPLOY_TOKEN: undefined } },
    () => {
      test("refuses to read a Deno-hosted site without its token", async () => {
        expectErrorResult(
          await loadSiteSupportMessage(
            bunnySite({ hostingId: "app-1", hostingProvider: "deno" }),
          ),
          "DENO_DEPLOY_TOKEN is not configured on this host, so its support message can't be read.",
        );
      });
    },
  );
});
