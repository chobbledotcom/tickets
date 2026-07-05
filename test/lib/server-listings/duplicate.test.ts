// jscpd:ignore-start
import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import {
  adminGet,
  assertAdminHtml,
  awaitTestRequest,
  createTestListing,
  describeWithEnv,
  setupListingAndLogin,
  testRequiresAuth,
} from "#test-utils";

// jscpd:ignore-end

describeWithEnv("server listings > duplicate", { db: true }, () => {
  describe("GET /admin/listing/:id/duplicate", () => {
    testRequiresAuth("/admin/listing/1/duplicate", {
      setup: async () => {
        await createTestListing({
          maxAttendees: 100,
          thankYouUrl: "https://example.com",
        });
      },
    });

    test("returns 404 for non-existent listing", async () => {
      const response = await adminGet("/admin/listing/999/duplicate");
      expect(response.status).toBe(404);
    });

    test("shows duplicate form pre-filled with listing settings but no name", async () => {
      await setupListingAndLogin({
        maxAttendees: 75,
        name: "Original Listing",
        thankYouUrl: "https://example.com/thanks",
        unitPrice: 2000,
        webhookUrl: "https://example.com/webhook",
      });

      const html = await assertAdminHtml(
        "/admin/listing/1/duplicate",
        "Duplicate Listing",
        "Original Listing",
        'value="75"',
        'value="20.00"',
        'value="https://example.com/thanks"',
        'value="https://example.com/webhook"',
      );
      // Name field should be empty (not pre-filled)
      expect(html).not.toContain('value="Original Listing"');
      // Form posts to create endpoint
      expect(html).toContain('action="/admin/listing"');
      // Name field has autofocus
      expect(html).toContain("autofocus");
    });

    /** Sets up a plain listing and returns its rendered Actions tab HTML —
     *  shared by the link-presence checks below. */
    const getActionsTabHtml = async (): Promise<string> => {
      const { cookie } = await setupListingAndLogin({
        maxAttendees: 100,
        thankYouUrl: "https://example.com",
      });
      const response = await awaitTestRequest("/admin/listing/1/actions", {
        cookie: cookie,
      });
      return response.text();
    };

    test("shows Duplicate link on the Actions tab", async () => {
      const html = await getActionsTabHtml();
      expect(html).toContain('href="/admin/listing/1/duplicate"');
      expect(html).toContain("<span>Duplicate</span>");
    });

    test("shows the JSON export link on the Actions tab", async () => {
      const html = await getActionsTabHtml();
      expect(html).toContain('href="/admin/listing/1/export.json"');
      expect(html).toContain("<span>Export</span>");
    });
  });
});
