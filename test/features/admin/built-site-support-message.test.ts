import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { stub } from "@std/testing/mock";
import { supportMessageApi } from "#shared/site-support-message.ts";
import { expectFlashRedirect } from "#test-utils/assertions.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { createTestBuiltSite } from "#test-utils/db-helpers/built-sites.ts";
import { adminFormPost } from "#test-utils/session.ts";

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
      body: (saved: { hostingId: string; value: string }[]) => Promise<void>,
    ): Promise<void> => {
      const saved: { hostingId: string; value: string }[] = [];
      using _set = stub(
        supportMessageApi,
        "setSupportMessage",
        (hostingId: string, value: string) => {
          saved.push({ hostingId, value });
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
            value: "# New hours\n\nCall after 6pm.",
          },
        ]);
      });
    });

    test("rejects text past Bunny's variable limit", async () => {
      const site = await createTestBuiltSite({
        hostingId: "8201",
        name: "Long Site",
      });
      await withSavedWrites(async (saved) => {
        const { response } = await adminFormPost(tabPath(site.id), {
          // One character past the 4096 characters a Bunny value allows.
          support_message: "x".repeat(4097),
        });
        await expectFlashRedirect(
          tabPath(site.id),
          "The support message is too long. Use at most 4,096 characters.",
          false,
        )(response);
        expect(saved).toEqual([]);
      });
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
