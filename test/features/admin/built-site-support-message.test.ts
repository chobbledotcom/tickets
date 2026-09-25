import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { stub } from "@std/testing/mock";
import { handleRequest } from "#routes";
import {
  type SupportMessageResult,
  supportMessageApi,
} from "#shared/site-support-message.ts";
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

    test("saves markdown indentation without trimming", async () => {
      const site = await createTestBuiltSite({
        hostingId: "8206",
        name: "Indent Site",
      });
      await withSavedWrites(async (saved) => {
        const { response } = await adminFormPost(tabPath(site.id), {
          // The four leading spaces open an indented code block in markdown.
          support_message: "    plain code block",
        });
        await expectFlashRedirect(
          tabPath(site.id),
          "Support message saved.",
        )(response);
        expect(saved).toEqual([
          {
            hostingId: "8206",
            hostingProvider: "bunny",
            value: "    plain code block",
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
          "The support message is too long. A site holds at most 2,048 bytes of text.",
          false,
        )(response);
        expect(saved).toEqual([]);
      });
    });

    /** Submit a support message whose save fails, then follow the refused
     * save's own redirect: the page the operator lands on, and what the
     * follow-up read answered in the editor's place. */
    const followedRefusedSave = async (
      siteId: number,
      read: SupportMessageResult,
      value: string,
    ): Promise<string> => {
      using _read = stub(supportMessageApi, "readSupportMessage", () =>
        Promise.resolve(read),
      );
      using _set = stub(supportMessageApi, "setSupportMessage", () =>
        Promise.resolve({
          error: "Set support message failed (500): try later",
          ok: false as const,
        }),
      );
      const { response } = await adminFormPost(tabPath(siteId), {
        support_message: value,
      });
      const followed = await followRedirectWithFlash(
        response,
        handleRequest,
        await testCookie(),
      );
      expect(followed.status).toBe(200);
      return await followed.text();
    };

    test("re-fills the refused draft over the stored text", async () => {
      const site = await createTestBuiltSite({
        hostingId: "8203",
        name: "Retry Site",
      });
      const html = await followedRefusedSave(
        site.id,
        { ok: true, value: "# Old text" },
        "# Draft that failed to save",
      );
      expect(html).toContain("# Draft that failed to save");
      expect(html).not.toContain("# Old text");
      expect(html).toContain("The support message could not be saved");
    });

    test("keeps the refused draft above the error when the follow-up read fails", async () => {
      const site = await createTestBuiltSite({
        hostingId: "8204",
        name: "Outage Site",
      });
      const html = await followedRefusedSave(
        site.id,
        {
          error: "Read support message failed (500): outage",
          ok: false,
        },
        "# Draft kept through the outage",
      );
      expect(html).toContain("# Draft kept through the outage");
      expect(html).toContain('name="support_message"');
      expect(html).toContain("The support message could not be read");
    });

    test("keeps a refused empty draft empty over the stored text", async () => {
      const site = await createTestBuiltSite({
        hostingId: "8205",
        name: "Clear Site",
      });
      const html = await followedRefusedSave(
        site.id,
        { ok: true, value: "# Old text" },
        "",
      );
      // The refused clear must keep the empty editor to retry, not fall
      // back to the stored text the operator asked to remove.
      const editorStart = html.indexOf(">", html.indexOf("<textarea")) + 1;
      expect(html.slice(editorStart, html.indexOf("</textarea>"))).toBe("");
      expect(html).toContain("</textarea>");
      expect(html).not.toContain("# Old text");
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
