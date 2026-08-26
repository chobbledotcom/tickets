import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { hashEmail, unsubscribeHash } from "#db/contact-preferences.ts";
import { settings } from "#db/settings.ts";
import {
  seedDraft,
  seedListingWithAttendees,
  seedMarketingDraftWithUnsubscriber,
  useResend,
} from "#test/integration/server/bulk-email/helpers.ts";
import {
  getAllActivityLog,
  getListingActivityLog,
} from "#test-utils/activity-log.ts";
import { expectFlashRedirect, expectRedirect } from "#test-utils/assertions.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { createTestAttendeeDirect } from "#test-utils/db-helpers/attendees.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";
import { useFetchStub } from "#test-utils/mocks.ts";
import { adminFormPost, adminGet } from "#test-utils/session.ts";

describeWithEnv("server bulk email > send", { db: true }, () => {
  describe("POST /admin/emails/send", () => {
    const fetch = useFetchStub();

    test("errors when there is no draft", async () => {
      const { response } = await adminFormPost("/admin/emails/send", {});
      await expectFlashRedirect(
        "/admin/emails",
        "There's no email to send.",
        false,
      )(response);
    });

    test("rejects the post when no provider is configured", async () => {
      const listing = await seedListingWithAttendees();
      await adminFormPost("/admin/emails/preview", {
        body: "Body",
        listing_id: String(listing.id),
        subject: "Subject",
      });
      const { response } = await adminFormPost("/admin/emails/send", {});
      await expectFlashRedirect(
        "/admin/emails/preview",
        "Configure your own email provider before sending bulk email.",
        false,
      )(response);
      expect(fetch.callCount()).toBe(0);
    });

    /** Draft an email to a two-attendee listing, answer the provider with
     * this reply, and send it. */
    const sendDraft = async (body = "", status = 200) => {
      const listing = await seedListingWithAttendees();
      await adminFormPost("/admin/emails/preview", {
        body: "Hello",
        listing_id: String(listing.id),
        subject: "Update",
      });
      fetch.restubFetch(() => Promise.resolve(new Response(body, { status })));
      const { response } = await adminFormPost("/admin/emails/send", {});
      return { listing, response };
    };

    test("sends to recipients, clears the draft, and logs activity", async () => {
      useResend();

      const { response } = await sendDraft();

      await expectFlashRedirect(
        "/admin/emails",
        "Sent to 2 recipients via Resend. The email provider responded with HTTP 200.",
      )(response);
      expect(fetch.callCount()).toBe(1);
      expect(settings.bulkEmailDraft).toBe("");
      const log = await getAllActivityLog(10);
      expect(log.some((e) => e.message.includes("Sent bulk email"))).toBe(true);
    });

    test("relays the provider's reply in the flash and the listing log", async () => {
      useResend();

      // The provider acknowledges the batch with queued message IDs.
      const { listing, response } = await sendDraft(
        '{"data":[{"id":"msg_1"}]}',
      );

      await expectFlashRedirect(
        "/admin/emails",
        'Sent to 2 recipients via Resend. The email provider responded with HTTP 200: {"data":[{"id":"msg_1"}]}.',
      )(response);
      // The reply is stored against this listing's log, not just the global one.
      const listingLog = await getListingActivityLog(listing.id);
      expect(
        listingLog.some((e) => e.message.includes('{"data":[{"id":"msg_1"}]}')),
      ).toBe(true);
    });

    test("counts only what the provider took when it refuses a message", async () => {
      settings.setForTest({
        email_api_key: "pm_key",
        email_from_address: "tickets@example.com",
        email_provider: "postmark",
      });
      // Postmark takes the batch, then refuses one message inside it.
      const { response } = await sendDraft(
        '[{"ErrorCode":0,"Message":"OK"},' +
          '{"ErrorCode":406,"Message":"Inactive recipient"}]',
      );

      await expectFlashRedirect(
        "/admin/emails",
        "Sent to 1 of 2 recipients via Postmark." +
          ' The email provider responded with HTTP 200: [{"ErrorCode":0,' +
          '"Message":"OK"},{"ErrorCode":406,"Message":"Inactive recipient"}].' +
          " It refused 1 message. Postmark error 406: Inactive recipient.",
      )(response);
      const log = await getAllActivityLog(10);
      expect(log.some((e) => e.message.includes("to 1 of 2 recipients"))).toBe(
        true,
      );
    });

    test("does not tell the operator an unconfirmed send failed", async () => {
      settings.setForTest({
        email_api_key: "pm_key",
        email_from_address: "tickets@example.com",
        email_provider: "postmark",
      });

      // Postmark took the batch, then answered with something unreadable.
      const { response } = await sendDraft("not json at all");

      // The mail may be queued, so the operator must not be told it failed
      // and go on to send the whole thing a second time.
      await expectFlashRedirect(
        "/admin/emails",
        "Sent to 2 recipients via Postmark." +
          " The email provider responded with HTTP 200: not json at all." +
          " It did not confirm 2 messages. They may still have been sent." +
          " Check the provider before you send them again.",
      )(response);
    });

    test("does not call a send a success when every message was refused", async () => {
      useResend();

      const { response } = await sendDraft("nope", 500);

      await expectFlashRedirect(
        "/admin/emails",
        "Resend sent none of your 2 messages." +
          " The email provider responded with HTTP 500: nope." +
          " It refused 2 messages.",
        false,
      )(response);
    });

    test("logs an audience send against no specific listing", async () => {
      useResend();
      await seedListingWithAttendees();
      await adminFormPost("/admin/emails/preview", {
        audience: "active",
        body: "Newsletter",
        subject: "Monthly",
      });

      const { response } = await adminFormPost("/admin/emails/send", {});

      expectRedirect(response, "/admin/emails");
      const log = await getAllActivityLog(10);
      const entry = log.find((e) =>
        e.message.includes('Sent bulk email "Monthly"'),
      );
      expect(entry?.listing_id).toBe(null);
    });

    /**
     * The two branches that decide who a promotion reaches: the unsubscribed
     * set the send is built against, and the refusal when it leaves nobody.
     * The story `attendees.writing-to-the-people-who-booked` tells both in the
     * owner's terms; these own the direct cover, which a Cucumber journey may
     * never be the only one of.
     */
    test("errors when every marketing recipient has unsubscribed", async () => {
      useResend();
      const listing = await createTestListing({
        maxAttendees: 5,
        name: "Solo",
      });
      await createTestAttendeeDirect(listing.id, "Alice", "alice@example.com");
      await unsubscribeHash(await hashEmail("alice@example.com"));
      await adminFormPost("/admin/emails/preview", {
        body: "Promo",
        listing_id: String(listing.id),
        marketing: "1",
        subject: "Sale",
      });
      const { response } = await adminFormPost("/admin/emails/send", {});
      await expectFlashRedirect(
        "/admin/emails/preview",
        "Everyone in this audience has unsubscribed.",
        false,
      )(response);
    });

    test("excludes unsubscribed recipients from a marketing send", async () => {
      useResend();
      await seedMarketingDraftWithUnsubscriber();

      await adminFormPost("/admin/emails/send", {});

      const body = fetch.getFetchJsonBody();
      expect(body).toHaveLength(1);
      expect(body[0].to).toEqual(["bob@example.com"]);
    });

    test("errors when the audience has no recipients", async () => {
      useResend();
      const empty = await createTestListing({ maxAttendees: 5, name: "Empty" });
      await adminFormPost("/admin/emails/preview", {
        body: "Body",
        listing_id: String(empty.id),
        subject: "Subject",
      });
      const { response } = await adminFormPost("/admin/emails/send", {});
      await expectFlashRedirect(
        "/admin/emails/preview",
        "There are no recipients to send to.",
        false,
      )(response);
    });
  });

  describe("single-attendee email (?attendee)", () => {
    const fetch = useFetchStub();

    const seedSoloAttendee = async () => {
      const listing = await createTestListing({
        maxAttendees: 5,
        name: "Solo",
      });
      const { attendee, token } = await createTestAttendeeDirect(
        listing.id,
        "Alice",
        "alice@example.com",
      );
      return { attendee, listing, token };
    };

    test("compose page targets just the one attendee", async () => {
      const { token } = await seedSoloAttendee();
      const html = await (
        await adminGet(`/admin/emails?attendee=${encodeURIComponent(token)}`)
      ).text();
      expect(html).toContain("Email an attendee");
      expect(html).toContain("alice@example.com");
      // The token round-trips through a hidden field so the POST keeps the target.
      expect(html).toContain('name="attendee"');
      expect(html).toContain("Preview to confirm the message before sending.");
    });

    test("404s for an unknown attendee token", async () => {
      const response = await adminGet("/admin/emails?attendee=gone");
      expect(response.status).toBe(404);
    });

    test("404s for an attendee with no email on file", async () => {
      const listing = await createTestListing({
        maxAttendees: 5,
        name: "Solo",
      });
      const { token } = await createTestAttendeeDirect(listing.id, "Nemo", "");
      const response = await adminGet(
        `/admin/emails?attendee=${encodeURIComponent(token)}`,
      );
      expect(response.status).toBe(404);
    });

    test("404s for a listing whose attendees have no email", async () => {
      const listing = await createTestListing({
        maxAttendees: 5,
        name: "Solo",
      });
      await createTestAttendeeDirect(listing.id, "Nemo", "");
      const response = await adminGet(`/admin/emails?listing=${listing.id}`);
      expect(response.status).toBe(404);
    });

    test("preview falls back to a generic label for a stale token", async () => {
      useResend();
      await seedDraft({
        body: "Body",
        marketing: false,
        subject: "Subject",
        target: { kind: "attendee", token: "gone" },
      });
      const html = await (await adminGet("/admin/emails/preview")).text();
      expect(html).toContain("the selected attendee");
    });

    test("preview labels the recipient with their own address", async () => {
      useResend();
      const { token } = await seedSoloAttendee();
      await adminFormPost("/admin/emails/preview", {
        attendee: token,
        body: "Just for you",
        subject: "Hello Alice",
      });
      const html = await (await adminGet("/admin/emails/preview")).text();
      expect(html).toContain("Hello Alice");
      expect(html).toContain("alice@example.com");
      expect(html).toContain("1 recipient");
    });

    test("sends to only that attendee and logs against no listing", async () => {
      useResend();
      const { token } = await seedSoloAttendee();
      await adminFormPost("/admin/emails/preview", {
        attendee: token,
        body: "Personal note",
        subject: "Just you",
      });

      const { response } = await adminFormPost("/admin/emails/send", {});

      await expectFlashRedirect(
        "/admin/emails",
        "Sent to 1 recipient via Resend. The email provider responded with HTTP 200.",
      )(response);
      const body = fetch.getFetchJsonBody();
      expect(body[0].to).toEqual(["alice@example.com"]);
      const log = await getAllActivityLog(10);
      const entry = log.find((e) =>
        e.message.includes('Sent bulk email "Just you"'),
      );
      expect(entry?.listing_id).toBe(null);
      // The log names one recipient in the singular, and says so exactly.
      expect(entry?.message).toContain("to 1 recipient.");
    });
  });
});
