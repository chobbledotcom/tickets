import { assert, assertStringIncludes } from "@std/assert";
import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { settings } from "#db/settings.ts";
import {
  seedDraft,
  seedListingWithAttendees,
  seedMarketingDraftWithUnsubscriber,
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
      // The error is aimed at the compose form, so the page can show it
      // beside the field rather than only at the top.
      assertStringIncludes(
        response.headers.get("location") ?? "",
        "form=bulk-email",
      );
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
      assertStringIncludes(html, "Big news");
      assertStringIncludes(html, "<strong>world</strong>");
      assertStringIncludes(html, "via Resend");
      assertStringIncludes(html, 'action="/admin/emails/send"');
      assertStringIncludes(html, "Transactional / service email");
      assertStringIncludes(html, 'class="recipient-emails"');
      assertStringIncludes(html, "alice@example.com, bob@example.com");
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
      assertStringIncludes(html, "everyone in BCC");
      assertStringIncludes(html, "Open a BCC draft to 2 recipients");
      assertStringIncludes(html, "mailto:owner%40example.com?bcc=");
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
      assertStringIncludes(html, "Open a draft to 1 recipient");
      assertStringIncludes(html, "addressed straight to your one recipient");
      assertStringIncludes(html, "mailto:alice%40example.com?");
      assert(
        !html.includes("Open a BCC draft"),
        "the value should not contain the searched item",
      );
      assert(
        !html.includes("everyone in BCC"),
        "the value should not contain the searched item",
      );
    });

    test("omits the address list when there are no recipients", async () => {
      useResend();
      const html = await staleListingDraftHtml();
      assert(
        !html.includes('class="recipient-emails"'),
        "the value should not contain the searched item",
      );
    });

    test("disables sending and explains marketing when not sendable", async () => {
      const listing = await seedListingWithAttendees();
      const html = await postPreviewHtml({
        body: "Promo time",
        listing_id: String(listing.id),
        marketing: "1",
        subject: "Sale",
      });
      assertStringIncludes(html, "Sending is disabled");
      assertStringIncludes(html, "Marketing email");
      assertStringIncludes(html, "unsubscribe footer is appended");
    });

    test("shows the audience description for an audience send", async () => {
      useResend();
      await seedSingleAttendeeListing();
      const html = await postPreviewHtml({
        audience: "active",
        body: "Newsletter",
        subject: "Monthly news",
      });
      assertStringIncludes(html, "Active listing attendees");
      assertStringIncludes(
        html,
        "Everyone booked onto a listing that is currently active.",
      );
      assertStringIncludes(html, "1 recipient");
      assert(
        !html.includes("1 recipients"),
        "the value should not contain the searched item",
      );
    });

    /**
     * The skipped-count the preview only renders when somebody is being left
     * out. The story `attendees.writing-to-the-people-who-booked` tells the
     * same thing in the owner's terms; this owns the direct cover of the
     * branch, which a Cucumber journey may never be the only one of.
     */
    test("notes how many unsubscribed recipients are skipped", async () => {
      useResend();
      await seedMarketingDraftWithUnsubscriber();
      const html = await getPreviewHtml();
      assertStringIncludes(html, "1 unsubscribed will be skipped");
      // The other attendee is still sendable, so the send is not empty.
      assertStringIncludes(html, "1 recipient");
    });

    test("skips nobody when the same audience gets a plain send", async () => {
      useResend();
      const listing = await seedMarketingDraftWithUnsubscriber();
      // Same audience, same unsubscriber, but not marketing. The
      // unsubscribed list does not apply, so nobody is left out.
      await seedDraft({
        body: "Body",
        marketing: false,
        subject: "Subject",
        target: { kind: "listing", listingId: listing.id },
      });

      const html = await getPreviewHtml();

      assert(
        !html.includes("will be skipped"),
        "the value should not contain the searched item",
      );
      assertStringIncludes(html, "2 recipients");
    });

    test("labels a target whose listing has since been deleted", async () => {
      useResend();
      const html = await staleListingDraftHtml();
      assertStringIncludes(html, "Listing attendees");
    });
  });
});
