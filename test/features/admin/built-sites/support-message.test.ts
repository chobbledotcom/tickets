import { assert } from "@std/assert";
import { describe, it as test } from "@std/testing/bdd";
import { stub } from "@std/testing/mock";
import { supportMessageApi } from "#shared/site-support-message.ts";
import { expectHtmlResponse } from "#test-utils/assertions.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { createTestBuiltSite } from "#test-utils/db-helpers/built-sites.ts";
import { withEnv } from "#test-utils/env.ts";
import { says } from "#test-utils/says.ts";
import { adminGet } from "#test-utils/session.ts";

describeWithEnv(
  "GET /admin/built-sites/:id/support-message",
  {
    db: true,
    env: {
      BUNNY_API_KEY: "k",
      CAN_BUILD_SITES: "true",
      DENO_DEPLOY_TOKEN: "deno-token",
    },
  },
  () => {
    const tabPath = (id: number): string =>
      `/admin/built-sites/${id}/support-message`;

    describe("the Support message tab", () => {
      test("loads the markdown editor with the current value", async () => {
        const site = await createTestBuiltSite({
          hostingId: "8100",
          name: "Reader Site",
        });
        using _read = stub(supportMessageApi, "readSupportMessage", () =>
          Promise.resolve({ ok: true as const, value: "# Ask us" }),
        );
        const response = await adminGet(tabPath(site.id));
        await expectHtmlResponse(response, 200, "Support message", "# Ask us");
      });

      test("renders the editor with an empty value when none is set", async () => {
        const site = await createTestBuiltSite({
          hostingId: "8101",
          name: "Empty Site",
        });
        using _read = stub(supportMessageApi, "readSupportMessage", () =>
          Promise.resolve({ ok: true as const, value: null }),
        );
        const response = await adminGet(tabPath(site.id));
        const html = await expectHtmlResponse(response, 200, "Support message");
        says(html, "data-markdown-preview");
        // The byte-budget hint replaces a character maxlength, which cannot
        // express the UTF-8 byte rule.
        says(html, "at most 2,048 bytes");
      });

      test("shows the read error on the panel on Bunny failure", async () => {
        const site = await createTestBuiltSite({
          hostingId: "8102",
          name: "Failure Site",
        });
        using _read = stub(supportMessageApi, "readSupportMessage", () =>
          Promise.resolve({
            error: "Read support message failed (500): boom",
            ok: false as const,
          }),
        );
        const response = await adminGet(tabPath(site.id));
        await expectHtmlResponse(
          response,
          200,
          "The support message could not be read",
        );
      });

      test("renders the current message as Markdown when read-only", async () => {
        const site = await createTestBuiltSite({
          hostingId: "8103",
          name: "Read-only Site",
        });
        using _read = stub(supportMessageApi, "readSupportMessage", () =>
          Promise.resolve({
            ok: true as const,
            value: "# Quiet hours\n\nCall after 6pm.",
          }),
        );
        using _env = withEnv({ READ_ONLY_FROM: "2020-01-01T00:00:00.000Z" });
        const response = await adminGet(tabPath(site.id));
        const html = await expectHtmlResponse(response, 200, "Support message");
        says(html, "<h1>Quiet hours</h1>");
        assert(!html.includes('name="support_message"'));
      });

      test("opens the tab for a Deno-hosted site too", async () => {
        const site = await createTestBuiltSite({
          hostingId: "app-9",
          hostingProvider: "deno",
          name: "Deno Site",
        });
        using _read = stub(supportMessageApi, "readSupportMessage", () =>
          Promise.resolve({ ok: true as const, value: "# Deno help" }),
        );
        const response = await adminGet(tabPath(site.id));
        await expectHtmlResponse(
          response,
          200,
          "Support message",
          "# Deno help",
        );

        const edit = await adminGet(`/admin/built-sites/${site.id}`);
        const html = await expectHtmlResponse(edit, 200, "Deno Site");
        says(html, tabPath(site.id));
      });
    });
  },
);
