import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import type { BuiltSite } from "#db/built-sites/types.ts";
import {
  loadSiteSupportMessage,
  SUPPORT_MESSAGE_MAX_LENGTH,
  type SupportMessageResult,
  saveSiteSupportMessage,
  supportMessageApi,
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
  variables: { Name: string | null; DefaultValue: string | null }[],
): string => JSON.stringify({ EdgeScriptVariables: variables });

/** Assert what `readSupportMessage` returns while fetch answers with `reply`. */
const expectReadWith = (
  reply: FetchReply,
  expected: SupportMessageResult,
): Promise<void> =>
  withMocks(
    () => stubFetch(reply),
    async () => {
      expect(await supportMessageApi.readSupportMessage("501")).toEqual(
        expected,
      );
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
    test("pins the limit on a variable value to Bunny's documented cap", () => {
      expect(SUPPORT_MESSAGE_MAX_LENGTH).toBe(4096);
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

    test("reports a failed Bunny read as an error result", async () => {
      await withMocks(
        () => stubFetch(new Response("nope", { status: 500 })),
        async () => {
          expectErrorResult(
            await supportMessageApi.readSupportMessage("501"),
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
            await supportMessageApi.readSupportMessage("501"),
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
            await supportMessageApi.setSupportMessage("501", "# New"),
          ).toEqual({ ok: true, value: "# New" });
        },
      );
      expect(seen).toEqual([
        {
          body: JSON.stringify({
            DefaultValue: "# New",
            Name: "SUPPORT_PAGE_TEXT",
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
            await supportMessageApi.setSupportMessage("501", "# New"),
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
            await supportMessageApi.setSupportMessage("501", "# New"),
            "Set support message: network down",
          );
        },
      );
    });
  },
);

describe("site support message gates", () => {
  test("refuses to read a Deno-hosted site", async () => {
    expectErrorResult(
      await loadSiteSupportMessage(
        bunnySite({ hostingId: "app-1", hostingProvider: "deno" }),
      ),
      "This site is not hosted on Bunny, so its support message can't be read.",
    );
  });

  test("refuses a site without a hosting ID", async () => {
    expectErrorResult(
      await loadSiteSupportMessage(bunnySite({ hostingId: "" })),
      "This site has no hosting ID, so its support message can't be read.",
    );
  });
});

describeWithEnv(
  "site support message without the Bunny key",
  { env: { BUNNY_API_KEY: undefined } },
  () => {
    test("refuses to write when the host has no BUNNY_API_KEY", async () => {
      expectErrorResult(
        await saveSiteSupportMessage(bunnySite(), "# New"),
        "BUNNY_API_KEY is not configured on this host, so its support message can't be set.",
      );
    });
  },
);
