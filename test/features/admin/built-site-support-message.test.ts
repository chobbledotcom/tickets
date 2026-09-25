import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { stub } from "@std/testing/mock";
import { handleRequest } from "#routes";
import { supportMessageApi } from "#shared/site-support-message.ts";
import {
  expectFlashRedirect,
  followRedirectWithFlash,
} from "#test-utils/assertions.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { createTestBuiltSite } from "#test-utils/db-helpers/built-sites.ts";
import { adminFormPost, testCookie } from "#test-utils/session.ts";

describeWithEnv(
  "POST /admin/built-sites/:id/support-message",
  {
    db: true,
    env: { BUNNY_API_KEY: "k", CAN_BUILD_SITES: "true" },
  },
  () => {
    const tabPath = (id: number): string =>
      `/admin/built-sites/${id}/support-message`;

    /** Record every support-message write while `body` runs. */
    const withSavedWrites = async (
      body: (
        saved: { hostingProvider: string; hostingId: string; value: string }[],
      ) => Promise<void>,
    ): Promise<void> => {
      const saved: {
        hostingProvider: string;
        hostingId: string;
        value: string;
      }[] = [];
      using _set = stub(
        supportMessageApi,
        "setSupportMessage",
        (provider: string, hostingId: string, value: string) => {
          saved.push({ hostingId, hostingProvider: provider, value });
          return Promise.resolve({ ok: true as const, value });
        },
      );
      await body(saved);
    };

    test("saves the form's markdown to the site's variable", async () => {
      const site = await createTestBuiltSite({
        hostingId: "8200",
        name: "Writer Site",
      });
      await withSavedWrites(async (saved) => {
        const { response } = await adminFormPost(tabPath(site.id), {
          support_message: "# New hours\n\nCall after 6pm.",
        });
        await expectFlashRedirect(
          tabPath(site.id),
          "Support message saved.",
        )(response);
        expect(saved).toEqual([
          {
            hostingId: "8200",
            hostingProvider: "bunny",
            value: "# New hours\n\nCall after 6pm.",
          },
        ]);
      });
    });

    test("rejects text past the stored byte limit", async () => {
      const site = await createTestBuiltSite({
        hostingId: "8201",
        name: "Long Site",
      });
      await withSavedWrites(async (saved) => {
        const { response } = await adminFormPost(tabPath(site.id), {
          // 1025 two-byte characters hold 2050 bytes: past the 2048-byte cap
          // while seating under it in characters.
          support_message: "é".repeat(1025),
        });
        await expectFlashRedirect(
          tabPath(site.id),
          "The support message is too long. A site can hold at most about 2,000 characters.",
          false,
        )(response);
        expect(saved).toEqual([]);
      });
    });

    test("re-fills the refused draft over the stored text", async () => {
      const site = await createTestBuiltSite({
        hostingId: "8203",
        name: "Retry Site",
      });
      using _read = stub(supportMessageApi, "readSupportMessage", () =>
        Promise.resolve({ ok: true as const, value: "# Old text" }),
      );
      using _set = stub(supportMessageApi, "setSupportMessage", () =>
        Promise.resolve({
          error: "Set support message failed (500): try later",
          ok: false as const,
        }),
      );
      const { response } = await adminFormPost(tabPath(site.id), {
        support_message: "# Draft that failed to save",
      });
      const followed = await followRedirectWithFlash(
        response,
        handleRequest,
        await testCookie(),
      );
      const html = await followed.text();
      expect(followed.status).toBe(200);
      expect(html).toContain("# Draft that failed to save");
      expect(html).not.toContain("# Old text");
      expect(html).toContain("The support message could not be saved");
    });

    test("shows the Bunny error when the write fails", async () => {
      const site = await createTestBuiltSite({
        hostingId: "8202",
        name: "Refused Site",
      });
      using _set = stub(supportMessageApi, "setSupportMessage", () =>
        Promise.resolve({
          error: "Set support message failed (400): name is in use",
          ok: false as const,
        }),
      );
      const { response } = await adminFormPost(tabPath(site.id), {
        support_message: "hi",
      });
      await expectFlashRedirect(
        tabPath(site.id),
        "The support message could not be saved: Set support message failed (400): name is in use",
        false,
      )(response);
    });
  },
);
