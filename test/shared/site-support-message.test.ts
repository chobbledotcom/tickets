import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { stub } from "@std/testing/mock";
import type { BuiltSite } from "#db/built-sites/types.ts";
import {
  type DenoEnvVarUpdate,
  denoDeployApi,
} from "#shared/deno-deploy-api.ts";
import {
  loadSiteSupportMessage,
  SUPPORT_MESSAGE_KEY,
  type SupportMessageResult,
  saveSiteSupportMessage,
  supportMessageApi,
  supportMessageTooLong,
} from "#shared/site-support-message.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { type FetchReply, stubFetch } from "#test-utils/fetch-stub.ts";
import { withMocks } from "#test-utils/mocks.ts";

/** A readable bunny site record for the module-level paths. */
const bunnySite = (overrides: Partial<BuiltSite> = {}): BuiltSite => ({
  assignable: false,
  assignedAttendeeId: null,
  assignedListingId: null,
  created: "2026-01-01T00:00:00Z",
  dbProvider: "bunny",
  dbToken: "tok",
  dbUrl: "libsql://db",
  hostingId: "501",
  hostingProvider: "bunny",
  id: 1,
  name: "Bunny Site",
  readOnlyFrom: "",
  renewalToken: null,
  renewalTokenIndex: null,
  scheduledTaskKey: null,
  siteDataRevision: 1,
  siteUrl: "https://site.b-cdn.net",
  updates: "release",
  ...overrides,
});

/** A GET /compute/script/{id} body holding a variable list. */
const scriptWithVariables = (
  variables: { DefaultValue?: string | null; Name: string | null }[],
): string => JSON.stringify({ EdgeScriptVariables: variables });

/** Assert what `readSupportMessage` returns while fetch answers with `reply`. */
const expectReadWith = (
  reply: FetchReply,
  expected: SupportMessageResult,
): Promise<void> =>
  withMocks(
    () => stubFetch(reply),
    async () => {
      expect(
        await supportMessageApi.readSupportMessage("bunny", "501"),
      ).toEqual(expected);
    },
  );

/** Assert a failed result whose error contains `contains`. */
const expectErrorResult = (
  result: SupportMessageResult,
  contains: string,
): void => {
  expect(result.ok).toBe(false);
  if (!result.ok) expect(result.error).toContain(contains);
};

describeWithEnv(
  "site support message",
  { env: { BUNNY_API_KEY: "test-bunny-key" } },
  () => {
    test("pins the stored limit's encoded-byte edge", () => {
      expect(supportMessageTooLong("a".repeat(2048))).toBe(false);
      expect(supportMessageTooLong("a".repeat(2049))).toBe(true);
    });

    test("too-long counts the encoded bytes, not the characters", () => {
      // 1025 two-byte characters hold 2050 bytes while looking half the limit.
      expect(supportMessageTooLong("é".repeat(1025))).toBe(true);
    });

    test("reads the set variable value", async () => {
      await expectReadWith(
        new Response(
          scriptWithVariables([
            { DefaultValue: "# Hi", Name: "SUPPORT_PAGE_TEXT" },
          ]),
        ),
        { ok: true, value: "# Hi" },
      );
    });

    test("reads null when the script reports no variables at all", async () => {
      await expectReadWith(new Response('{"EdgeScriptVariables":null}'), {
        ok: true,
        value: null,
      });
    });

    test("reads null when no variable is set", async () => {
      await expectReadWith(new Response(scriptWithVariables([])), {
        ok: true,
        value: null,
      });
    });

    test("reads an empty string value as a value, not an unset message", async () => {
      await expectReadWith(
        new Response(
          scriptWithVariables([
            { DefaultValue: "", Name: SUPPORT_MESSAGE_KEY },
          ]),
        ),
        { ok: true, value: "" },
      );
    });

    test("reads the message when an unrelated entry carries no DefaultValue", async () => {
      await expectReadWith(
        new Response(
          scriptWithVariables([
            { Name: "OTHER_VAR" },
            { DefaultValue: "# Still readable", Name: SUPPORT_MESSAGE_KEY },
          ]),
        ),
        { ok: true, value: "# Still readable" },
      );
    });

    test("reads null when the support entry itself carries no DefaultValue", async () => {
      await expectReadWith(
        new Response(scriptWithVariables([{ Name: SUPPORT_MESSAGE_KEY }])),
        { ok: true, value: null },
      );
    });

    test("reports a failed Bunny read as an error result", async () => {
      await withMocks(
        () => stubFetch(new Response("nope", { status: 500 })),
        async () => {
          expectErrorResult(
            await supportMessageApi.readSupportMessage("bunny", "501"),
            "Read support message",
          );
        },
      );
    });

    test("labels a thrown read failure with the read step's name", async () => {
      await withMocks(
        () => stubFetch(new Error("network down")),
        async () => {
          expectErrorResult(
            await supportMessageApi.readSupportMessage("bunny", "501"),
            "Read support message: network down",
          );
        },
      );
    });

    test("puts the value to the script's variables endpoint", async () => {
      const seen: { body: string; method: string; url: string }[] = [];
      await withMocks(
        () =>
          stubFetch((url: string, init?: RequestInit) => {
            seen.push({
              body: String(init?.body),
              method: String(init?.method),
              url,
            });
            return new Response("{}", { status: 200 });
          }),
        async () => {
          expect(
            await supportMessageApi.setSupportMessage("bunny", "501", "# New"),
          ).toEqual({ ok: true, value: "# New" });
        },
      );
      expect(seen).toEqual([
        {
          body: JSON.stringify({
            DefaultValue: "# New",
            Name: SUPPORT_MESSAGE_KEY,
          }),
          method: "PUT",
          url: "https://api.bunny.net/compute/script/501/variables",
        },
      ]);
    });

    test("reports a failed Bunny write as an error result", async () => {
      await withMocks(
        () => stubFetch(new Response("bad", { status: 400 })),
        async () => {
          expectErrorResult(
            await supportMessageApi.setSupportMessage("bunny", "501", "# New"),
            "Set support message",
          );
        },
      );
    });

    test("labels a thrown write failure with the write step's name", async () => {
      await withMocks(
        () => stubFetch(new Error("network down")),
        async () => {
          expectErrorResult(
            await supportMessageApi.setSupportMessage("bunny", "501", "# New"),
            "Set support message: network down",
          );
        },
      );
    });

    test("reads a Deno app's plain variable and masks its secrets", async () => {
      using _appEnvVars = stub(denoDeployApi, "getAppEnvVars", () =>
        Promise.resolve({
          ok: true as const,
          value: [{ key: SUPPORT_MESSAGE_KEY, secret: false, value: "old" }],
        }),
      );
      expect(
        await supportMessageApi.readSupportMessage("deno", "app-1"),
      ).toEqual({ ok: true, value: "old" });
    });

    test("reads null from a Deno app whose entry is a secret", async () => {
      using _appEnvVars = stub(denoDeployApi, "getAppEnvVars", () =>
        Promise.resolve({
          ok: true as const,
          value: [{ key: SUPPORT_MESSAGE_KEY, secret: true, value: undefined }],
        }),
      );
      expect(
        await supportMessageApi.readSupportMessage("deno", "app-1"),
      ).toEqual({ ok: true, value: null });
    });

    test("reports a malformed Bunny success without the variable list", async () => {
      await withMocks(
        () => stubFetch(new Response('{"DefaultHostname":"x.b-cdn.net"}')),
        async () => {
          expectErrorResult(
            await supportMessageApi.readSupportMessage("bunny", "501"),
            "Read support message",
          );
        },
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

    test("patches one plain variable onto a Deno app", async () => {
      const seen: unknown[] = [];
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
          entry: { key: SUPPORT_MESSAGE_KEY, secret: false, value: "# New" },
        },
      ]);
    });
    test("saves a reachable site's message through its provider", async () => {
      const seen: { hostingId: string; provider: string; value: string }[] = [];
      using _set = stub(
        supportMessageApi,
        "setSupportMessage",
        (provider: string, hostingId: string, value: string) => {
          seen.push({ hostingId, provider, value });
          return Promise.resolve({ ok: true as const, value });
        },
      );
      expect(await saveSiteSupportMessage(bunnySite(), "# Hello")).toEqual({
        ok: true,
        value: "# Hello",
      });
      expect(seen).toEqual([
        { hostingId: "501", provider: "bunny", value: "# Hello" },
      ]);
    });
  },
);

describe("site support message save gate", () => {
  test("refuses to save without the site's provider key", async () => {
    expectErrorResult(
      await saveSiteSupportMessage(bunnySite({ hostingId: "" }), "# No way"),
      "This site has no hosting ID, so its support message can't be set.",
    );
  });
});

describeWithEnv(
  "site support message without the provider keys",
  {
    env: {
      BUNNY_API_KEY: undefined,
      DENO_DEPLOY_TOKEN: undefined,
    },
  },
  () => {
    test("refuses to read a Deno-hosted site without its token", async () => {
      expectErrorResult(
        await loadSiteSupportMessage(
          bunnySite({ hostingId: "app-1", hostingProvider: "deno" }),
        ),
        "DENO_DEPLOY_TOKEN is not configured on this host, so its support message can't be read.",
      );
    });

    test("refuses to set a Bunny site's message without its key", async () => {
      expectErrorResult(
        await supportMessageApi.setSupportMessage("bunny", "501", "# New"),
        "Set support message",
      );
    });
  },
);
