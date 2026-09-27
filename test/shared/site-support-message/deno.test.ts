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
import {
  loadSiteSupportMessage,
  SUPPORT_MESSAGE_KEY,
  supportMessageApi,
} from "#shared/site-support-message.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { bunnySite, expectErrorResult } from "./fixtures.ts";

describe("site support message on Deno Deploy", () => {
  test("reads a Deno app's plain variable and masks its secrets", async () => {
    using _appEnvVars = stub(denoDeployApi, "getAppEnvVars", () =>
      Promise.resolve({
        ok: true as const,
        value: [
          {
            contexts: "all" as const,
            id: "env-1",
            key: SUPPORT_MESSAGE_KEY,
            secret: false,
            value: "old",
          },
        ],
      }),
    );
    expect(await supportMessageApi.readSupportMessage("deno", "app-1")).toEqual(
      { ok: true, value: "old" },
    );
  });

  test("reads null from a Deno app whose entry is a secret", async () => {
    using _appEnvVars = stub(denoDeployApi, "getAppEnvVars", () =>
      Promise.resolve({
        ok: true as const,
        value: [
          {
            contexts: "all" as const,
            id: "env-2",
            key: SUPPORT_MESSAGE_KEY,
            secret: true,
            value: undefined,
          },
        ],
      }),
    );
    expect(await supportMessageApi.readSupportMessage("deno", "app-1")).toEqual(
      { ok: true, value: null },
    );
  });

  test("reads the serving record, not a record for another context", async () => {
    // Deno's documented contexts can hold the same key in a preview
    // record beside the production-serving one; the tab edits the
    // production side.
    using _appEnvVars = stub(denoDeployApi, "getAppEnvVars", () =>
      Promise.resolve({
        ok: true as const,
        value: [
          {
            contexts: ["preview"] as const,
            id: "env-3",
            key: SUPPORT_MESSAGE_KEY,
            secret: false,
            value: "preview copy",
          },
          {
            contexts: "all" as const,
            id: "env-4",
            key: SUPPORT_MESSAGE_KEY,
            secret: false,
            value: "serving copy",
          },
        ],
      }),
    );
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
    using _appEnvVars = stub(denoDeployApi, "getAppEnvVars", () =>
      Promise.resolve({ ok: true as const, value: [] }),
    );
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
    expectErrorResult(
      await supportMessageApi.setSupportMessage("deno", "app-1", "# New"),
      "Get app failed (404)",
    );
  });

  test("updates the serving record in place and creates one when absent", async () => {
    // An existing record keeps its id, so a dashboard-created
    // all-contexts record is edited in place instead of shadowed by a
    // second production entry the tab would never read again.
    const seen: unknown[] = [];
    using _appEnvVars = stub(denoDeployApi, "getAppEnvVars", () =>
      Promise.resolve({
        ok: true as const,
        value: [
          {
            contexts: "all" as const,
            id: "env-9",
            key: SUPPORT_MESSAGE_KEY,
            secret: false,
            value: "old",
          },
        ],
      }),
    );
    using _setEnvVar = stub(
      denoDeployApi,
      "setEnvVar",
      (appId: string, entry: DenoEnvVarUpdate) => {
        seen.push({ appId, entry });
        return Promise.resolve({ ok: true as const, value: undefined });
      },
    );
    expect(
      await supportMessageApi.setSupportMessage("deno", "app-1", "# New"),
    ).toEqual({ ok: true, value: "# New" });
    expect(seen).toEqual([
      {
        appId: "app-1",
        entry: {
          contexts: "all",
          id: "env-9",
          key: SUPPORT_MESSAGE_KEY,
          secret: false,
          value: "# New",
        },
      },
    ]);
  });
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
