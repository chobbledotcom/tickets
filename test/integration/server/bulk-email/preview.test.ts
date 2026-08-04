import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { settings } from "#shared/db/settings.ts";
import {
  seedDraft,
  seedListingWithAttendees,
  seedSingleAttendeeListing,
  useResend,
} from "#test/integration/server/bulk-email/helpers.ts";
import {
  expectFlash,
  expectFlashRedirect,
  expectRedirect,
} from "#test-utils/assertions.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { adminFormPost, adminGet } from "#test-utils/session.ts";

/** Read the rendered preview page's HTML. */
const getPreviewHtml = async (): Promise<string> =>
  (await adminGet("/admin/emails/preview")).text();

/** Post a draft to the compose form, then read the resulting preview HTML. */
const postPreviewHtml = async (
  fields: Record<string, string>,
): Promise<string> => {
  await adminFormPost("/admin/emails/preview", fields);
  return getPreviewHtml();
};

/** Seed a draft targeting a listing id that doesn't exist (as if the
 * listing were deleted after the draft was saved), then read the preview. */
const staleListingDraftHtml = async (): Promise<string> => {
  await seedDraft({
    body: "Body",
    marketing: false,
    subject: "Subject",
    target: { kind: "listing", listingId: 987654 },
  });
  return getPreviewHtml();
};

describeWithEnv("server bulk email > preview", { db: true }, () => {
  describe("POST /admin/emails/preview", () => {
    test("saves the draft and redirects to the preview", async () => {
      const { response } = await adminFormPost("/admin/emails/preview", {
        audience: "active",
        body: "Hello everyone",
        subject: "News",
      });
      await expectFlashRedirect(
        "/admin/emails/preview",
        "Review your email below before sending.",
      )(response);
      expect(settings.bulkEmailDraft).not.toBe("");
    });

    test("defaults the audience when none is posted", async () => {
      const { response } = await adminFormPost("/admin/emails/preview", {
        body: "Hello",
        subject: "News",
      });
      expectRedirect(response, "/admin/emails/preview");
    });

    test("rejects an empty subject", async () => {
      const { response } = await adminFormPost("/admin/emails/preview", {
        audience: "active",
        body: "Body",
        subject: "",
      });
      expectRedirect(response, "/admin/emails?audience=active");
      expectFlash(response, "Subject is required", false);
    });

    test("rejects a posted listing that no longer exists", async () => {
      const { response } = await adminFormPost("/admin/emails/preview", {
        body: "Body",
        listing_id: "9999",
        subject: "Subject",
      });
      await expectFlashRedirect(
        "/admin/emails",
        "That listing no longer exists.",
        false,
      )(response);
    });

    test("rejects a posted non-positive listing id", async () => {
      const { response } = await adminFormPost("/admin/emails/preview", {
        body: "Body",
        listing_id: "0",
        subject: "Subject",
      });
      await expectFlashRedirect(
        "/admin/emails",
        "That listing no longer exists.",
        false,
      )(response);
    });
  });

  describe("GET /admin/emails/preview", () => {
    test("redirects to compose when there is no draft", async () => {
      const response = await adminGet("/admin/emails/preview");
      expectRedirect(response, "/admin/emails");
    });

    test("renders the draft with a working send button when sendable", async () => {
      useResend();
      const listing = await seedListingWithAttendees();
      const html = await postPreviewHtml({
        body: "Hello **world**",
        listing_id: String(listing.id),
        subject: "Big news",
      });
      expect(html).toContain("Big news");
      expect(html).toContain("<strong>world</strong>");
      expect(html).toContain("via Resend");
      expect(html).toContain('action="/admin/emails/send"');
      expect(html).toContain("Transactional / service email");
      expect(html).toContain('class="recipient-emails"');
      expect(html).toContain("alice@example.com, bob@example.com");
    });

    test("BCCs several recipients from the owner's business email", async () => {
      useResend();
      settings.setForTest({ business_email: "owner@example.com" });
      const listing = await seedListingWithAttendees();
      const html = await postPreviewHtml({
        body: "Hello",
        listing_id: String(listing.id),
        subject: "Big news",
      });
      expect(html).toContain("everyone in BCC");
      expect(html).toContain("Open a BCC draft to 2 recipients");
      expect(html).toContain("mailto:owner%40example.com?bcc=");
    });

    test("addresses a lone recipient directly instead of using BCC", async () => {
      useResend();
      // A business email is set but must be ignored for a single recipient.
      settings.setForTest({ business_email: "owner@example.com" });
      const listing = await seedSingleAttendeeListing();
      const html = await postPreviewHtml({
        body: "Hello",
        listing_id: String(listing.id),
        subject: "Big news",
      });
      expect(html).toContain("Open a draft to 1 recipient");
      expect(html).toContain("addressed straight to your one recipient");
      expect(html).toContain("mailto:alice%40example.com?");
      expect(html).not.toContain("Open a BCC draft");
      expect(html).not.toContain("everyone in BCC");
    });

    test("omits the address list when there are no recipients", async () => {
      useResend();
      const html = await staleListingDraftHtml();
      expect(html).not.toContain('class="recipient-emails"');
    });

    test("disables sending and explains marketing when not sendable", async () => {
      const listing = await seedListingWithAttendees();
      const html = await postPreviewHtml({
        body: "Promo time",
        listing_id: String(listing.id),
        marketing: "1",
        subject: "Sale",
      });
      expect(html).toContain("Sending is disabled");
      expect(html).toContain("Marketing email");
      expect(html).toContain("unsubscribe footer is appended");
    });

    test("shows the audience description for an audience send", async () => {
      useResend();
      await seedSingleAttendeeListing();
      const html = await postPreviewHtml({
        audience: "active",
        body: "Newsletter",
        subject: "Monthly news",
      });
      expect(html).toContain("Active listing attendees");
      expect(html).toContain(
        "Everyone booked onto a listing that is currently active.",
      );
      expect(html).toContain("1 recipient");
      expect(html).not.toContain("1 recipients");
    });

    test("labels a target whose listing has since been deleted", async () => {
      useResend();
      const html = await staleListingDraftHtml();
      expect(html).toContain("Listing attendees");
    });
  });
});
