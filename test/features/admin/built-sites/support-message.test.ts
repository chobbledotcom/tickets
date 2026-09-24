import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { stub } from "@std/testing/mock";
import { supportMessageApi } from "#shared/site-support-message.ts";
import { expectHtmlResponse, expectStatus } from "#test-utils/assertions.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { createTestBuiltSite } from "#test-utils/db-helpers/built-sites.ts";
import { withEnv } from "#test-utils/env.ts";
import { adminGet } from "#test-utils/session.ts";

describeWithEnv(
  "GET /admin/built-sites/:id/support-message",
  {
    db: true,
    env: { BUNNY_API_KEY: "k", CAN_BUILD_SITES: "true" },
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
        expect(html).toContain("data-markdown-preview");
        // Bunny caps a variable's value at 4096 characters.
        expect(html).toContain('maxlength="4096"');
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
        expect(html).toContain("<h1>Quiet hours</h1>");
        expect(html).not.toContain('name="support_message"');
      });

      test("404s for a Deno-hosted site and hides its tab link", async () => {
        const site = await createTestBuiltSite({
          hostingId: "app-9",
          hostingProvider: "deno",
          name: "Deno Site",
        });
        const response = await adminGet(tabPath(site.id));
        expectStatus(404)(response);

        const edit = await adminGet(`/admin/built-sites/${site.id}`);
        const html = await expectHtmlResponse(edit, 200, "Deno Site");
        expect(html).not.toContain("/support-message");
      });
    });
  },
);
