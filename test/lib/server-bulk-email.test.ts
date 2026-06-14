import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { serializeDraft } from "#shared/bulk-email.ts";
import {
  getAllActivityLog,
  getListingActivityLog,
} from "#shared/db/activityLog.ts";
import {
  getEmailStats,
  hashEmail,
  unsubscribeHash,
} from "#shared/db/email-preferences.ts";
import { settings } from "#shared/db/settings.ts";
import {
  adminFormPost,
  awaitTestRequest,
  createTestManagerSession,
  describeWithEnv,
  expectFlash,
  expectHtmlResponse,
  expectRedirect,
  expectRedirectWithFlash,
  getTestPrivateKey,
  testCookie,
  testRequiresAuth,
  useFetchStub,
} from "#test-utils";
import {
  createTestAttendeeDirect,
  createTestListing,
} from "#test-utils/db-helpers.ts";

/** Configure the owner's own (bulk-capable) email provider. */
const useResend = () =>
  settings.setForTest({
    email_api_key: "re_key",
    email_from_address: "tickets@example.com",
    email_provider: "resend",
  });

const seedSingleAttendeeListing = async () => {
  const listing = await createTestListing({ maxAttendees: 50, name: "Solo" });
  await createTestAttendeeDirect(listing.id, "Alice", "alice@example.com");
  return listing;
};

const seedListingWithAttendees = async () => {
  const listing = await createTestListing({ maxAttendees: 50, name: "Gig" });
  await createTestAttendeeDirect(listing.id, "Alice", "alice@example.com");
  await createTestAttendeeDirect(listing.id, "Bob", "bob@example.com");
  return listing;
};

describeWithEnv("server (bulk email)", { db: true }, () => {
  describe("GET /admin/emails", () => {
    testRequiresAuth("/admin/emails");

    test("renders the compose page for an owner", async () => {
      await awaitTestRequest("/admin/emails", {
        cookie: await testCookie(),
      }).then((r) =>
        expectHtmlResponse(r, 200, "Send a bulk email", "Audience"),
      );
    });

    test("shows the disabled notice when no own provider is configured", async () => {
      const html = await awaitTestRequest("/admin/emails", {
        cookie: await testCookie(),
      }).then((r) => r.text());
      expect(html).toContain("Heads up");
    });

    test("hides the disabled notice when a bulk provider is configured", async () => {
      useResend();
      const html = await awaitTestRequest("/admin/emails", {
        cookie: await testCookie(),
      }).then((r) => r.text());
      expect(html).not.toContain("Heads up");
    });

    test("targets a single listing via ?listing", async () => {
      const listing = await seedListingWithAttendees();
      const html = await awaitTestRequest(
        `/admin/emails?listing=${listing.id}`,
        {
          cookie: await testCookie(),
        },
      ).then((r) => r.text());
      expect(html).toContain("attendees of Gig");
    });

    test("404s for a non-existent listing", async () => {
      const response = await awaitTestRequest("/admin/emails?listing=9999", {
        cookie: await testCookie(),
      });
      expect(response.status).toBe(404);
    });

    test("404s for a non-numeric listing", async () => {
      const response = await awaitTestRequest("/admin/emails?listing=abc", {
        cookie: await testCookie(),
      });
      expect(response.status).toBe(404);
    });

    test("falls back to the default audience for an unknown one", async () => {
      await awaitTestRequest("/admin/emails?audience=bogus", {
        cookie: await testCookie(),
      }).then((r) => expectHtmlResponse(r, 200, "Send a bulk email"));
    });

    test("accepts an explicit valid audience", async () => {
      const html = await awaitTestRequest("/admin/emails?audience=upcoming", {
        cookie: await testCookie(),
      }).then((r) => r.text());
      expect(html).toContain('<option selected value="upcoming">');
    });

    test("prefills a saved draft and counts a single recipient", async () => {
      const listing = await seedSingleAttendeeListing();
      await adminFormPost("/admin/emails/preview", {
        body: "Saved body",
        listing_id: String(listing.id),
        marketing: "1",
        subject: "Saved subject",
      });
      const html = await awaitTestRequest(
        `/admin/emails?listing=${listing.id}`,
        {
          cookie: await testCookie(),
        },
      ).then((r) => r.text());
      expect(html).toContain('value="Saved subject"');
      expect(html).toContain("checked");
      expect(html).toContain("recipient. That's everyone");
      expect(html).not.toContain("recipients");
    });

    test("forbids non-owner admins", async () => {
      const cookie = await createTestManagerSession();
      const response = await awaitTestRequest("/admin/emails", { cookie });
      expect(response.status).toBe(403);
    });
  });

  describe("POST /admin/emails/preview", () => {
    test("saves the draft and redirects to the preview", async () => {
      const { response } = await adminFormPost("/admin/emails/preview", {
        audience: "active",
        body: "Hello everyone",
        subject: "News",
      });
      expectRedirectWithFlash(
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
      expectRedirectWithFlash(
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
      expectRedirectWithFlash(
        "/admin/emails",
        "That listing no longer exists.",
        false,
      )(response);
    });
  });

  describe("GET /admin/emails/preview", () => {
    test("redirects to compose when there is no draft", async () => {
      const response = await awaitTestRequest("/admin/emails/preview", {
        cookie: await testCookie(),
      });
      expectRedirect(response, "/admin/emails");
    });

    test("renders the draft with a working send button when sendable", async () => {
      useResend();
      const listing = await seedListingWithAttendees();
      await adminFormPost("/admin/emails/preview", {
        body: "Hello **world**",
        listing_id: String(listing.id),
        subject: "Big news",
      });
      const html = await awaitTestRequest("/admin/emails/preview", {
        cookie: await testCookie(),
      }).then((r) => r.text());
      expect(html).toContain("Big news");
      expect(html).toContain("<strong>world</strong>");
      expect(html).toContain("via Resend");
      expect(html).toContain('action="/admin/emails/send"');
      expect(html).toContain("Transactional / service email");
    });

    test("disables sending and explains marketing when not sendable", async () => {
      const listing = await seedListingWithAttendees();
      await adminFormPost("/admin/emails/preview", {
        body: "Promo time",
        listing_id: String(listing.id),
        marketing: "1",
        subject: "Sale",
      });
      const html = await awaitTestRequest("/admin/emails/preview", {
        cookie: await testCookie(),
      }).then((r) => r.text());
      expect(html).toContain("Sending is disabled");
      expect(html).toContain("Marketing email");
      expect(html).toContain("unsubscribe footer is appended");
    });

    test("shows the audience description for an audience send", async () => {
      useResend();
      await seedSingleAttendeeListing();
      await adminFormPost("/admin/emails/preview", {
        audience: "active",
        body: "Newsletter",
        subject: "Monthly news",
      });
      const html = await awaitTestRequest("/admin/emails/preview", {
        cookie: await testCookie(),
      }).then((r) => r.text());
      expect(html).toContain("Active listing attendees");
      expect(html).toContain(
        "Everyone booked onto a listing that is currently active.",
      );
      expect(html).toContain("1 recipient");
      expect(html).not.toContain("1 recipients");
    });

    test("labels a target whose listing has since been deleted", async () => {
      useResend();
      settings.setForTest({
        bulk_email_draft: serializeDraft({
          body: "Body",
          marketing: false,
          subject: "Subject",
          target: { kind: "listing", listingId: 987654 },
        }),
      });
      const html = await awaitTestRequest("/admin/emails/preview", {
        cookie: await testCookie(),
      }).then((r) => r.text());
      expect(html).toContain("Listing attendees");
    });

    test("notes how many unsubscribed recipients are skipped", async () => {
      useResend();
      const listing = await seedListingWithAttendees();
      await unsubscribeHash(await hashEmail("alice@example.com"));
      await adminFormPost("/admin/emails/preview", {
        body: "Promo",
        listing_id: String(listing.id),
        marketing: "1",
        subject: "Sale",
      });
      const html = await awaitTestRequest("/admin/emails/preview", {
        cookie: await testCookie(),
      }).then((r) => r.text());
      expect(html).toContain("1 unsubscribed will be skipped");
    });
  });

  describe("POST /admin/emails/send", () => {
    const fetch = useFetchStub();

    test("errors when there is no draft", async () => {
      const { response } = await adminFormPost("/admin/emails/send", {});
      expectRedirectWithFlash(
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
      expectRedirectWithFlash(
        "/admin/emails/preview",
        "Configure your own email provider before sending bulk email.",
        false,
      )(response);
      expect(fetch.callCount()).toBe(0);
    });

    test("sends to recipients, clears the draft, and logs activity", async () => {
      useResend();
      const listing = await seedListingWithAttendees();
      await adminFormPost("/admin/emails/preview", {
        body: "Hello",
        listing_id: String(listing.id),
        subject: "Update",
      });

      const { response } = await adminFormPost("/admin/emails/send", {});

      expectRedirectWithFlash(
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
      const listing = await seedListingWithAttendees();
      await adminFormPost("/admin/emails/preview", {
        body: "Hello",
        listing_id: String(listing.id),
        subject: "Update",
      });
      // The provider acknowledges the batch with queued message IDs.
      fetch.restubFetch(() =>
        Promise.resolve(
          new Response('{"data":[{"id":"msg_1"}]}', { status: 200 }),
        ),
      );

      const { response } = await adminFormPost("/admin/emails/send", {});

      expectRedirectWithFlash(
        "/admin/emails",
        'Sent to 2 recipients via Resend. The email provider responded with HTTP 200: {"data":[{"id":"msg_1"}]}.',
      )(response);
      // The reply is stored against this listing's log, not just the global one.
      const listingLog = await getListingActivityLog(listing.id);
      expect(
        listingLog.some((e) => e.message.includes('{"data":[{"id":"msg_1"}]}')),
      ).toBe(true);
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

    test("errors when the audience has no recipients", async () => {
      useResend();
      const empty = await createTestListing({ maxAttendees: 5, name: "Empty" });
      await adminFormPost("/admin/emails/preview", {
        body: "Body",
        listing_id: String(empty.id),
        subject: "Subject",
      });
      const { response } = await adminFormPost("/admin/emails/send", {});
      expectRedirectWithFlash(
        "/admin/emails/preview",
        "There are no recipients to send to.",
        false,
      )(response);
    });

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
      expectRedirectWithFlash(
        "/admin/emails/preview",
        "Everyone in this audience has unsubscribed.",
        false,
      )(response);
    });

    test("excludes unsubscribed recipients from a marketing send", async () => {
      useResend();
      const listing = await seedListingWithAttendees();
      await unsubscribeHash(await hashEmail("alice@example.com"));
      await adminFormPost("/admin/emails/preview", {
        body: "Promo",
        listing_id: String(listing.id),
        marketing: "1",
        subject: "Sale",
      });

      await adminFormPost("/admin/emails/send", {});

      const body = fetch.getFetchJsonBody();
      expect(body).toHaveLength(1);
      expect(body[0].to).toEqual(["bob@example.com"]);
    });
  });

  describe("listing page Email link", () => {
    test("owners see the link on the listing page", async () => {
      const listing = await seedListingWithAttendees();
      const html = await awaitTestRequest(`/admin/listing/${listing.id}`, {
        cookie: await testCookie(),
      }).then((r) => r.text());
      expect(html).toContain(`/admin/emails?listing=${listing.id}`);
      expect(html).toContain(">Email</a>");
    });

    test("managers do not see the link", async () => {
      const listing = await seedListingWithAttendees();
      const cookie = await createTestManagerSession();
      const html = await awaitTestRequest(`/admin/listing/${listing.id}`, {
        cookie,
      }).then((r) => r.text());
      expect(html).not.toContain("/admin/emails?listing=");
    });
  });

  describe("draft helpers", () => {
    test("a malformed stored draft is treated as absent", async () => {
      settings.setForTest({ bulk_email_draft: "{garbage" });
      const response = await awaitTestRequest("/admin/emails/preview", {
        cookie: await testCookie(),
      });
      expectRedirect(response, "/admin/emails");
    });

    test("a valid stored draft renders the preview", async () => {
      useResend();
      const listing = await seedListingWithAttendees();
      settings.setForTest({
        bulk_email_draft: serializeDraft({
          body: "Stored body",
          marketing: false,
          subject: "Stored subject",
          target: { kind: "listing", listingId: listing.id },
        }),
      });
      await awaitTestRequest("/admin/emails/preview", {
        cookie: await testCookie(),
      }).then((r) => expectHtmlResponse(r, 200, "Stored subject"));
    });
  });

  describe("contact history", () => {
    useFetchStub(); // stub network so sends don't hit a real provider

    const previewListing = async (listing: { id: number }) => {
      await adminFormPost("/admin/emails/preview", {
        body: "Hello",
        listing_id: String(listing.id),
        subject: "Update",
      });
      return awaitTestRequest("/admin/emails/preview", {
        cookie: await testCookie(),
      }).then((r) => r.text());
    };

    test("preview reports never-contacted recipients", async () => {
      useResend();
      const listing = await seedListingWithAttendees();
      const html = await previewListing(listing);
      expect(html).toContain(
        "These attendees have never been contacted through this page.",
      );
    });

    test("a send records a contact, surfaced on the next preview", async () => {
      useResend();
      const listing = await seedListingWithAttendees();
      await adminFormPost("/admin/emails/preview", {
        body: "Hello",
        listing_id: String(listing.id),
        subject: "First",
      });
      await adminFormPost("/admin/emails/send", {});

      // Each recipient now has one contact.
      const stats = await getEmailStats(
        await hashEmail("alice@example.com"),
        await getTestPrivateKey(),
      );
      expect(stats.contactCount).toBe(1);
      expect(stats.lastSubject).toBe("First");

      const html = await previewListing(listing);
      expect(html).toContain(
        "These attendees have been contacted through this page 1 times each.",
      );
    });

    test("the attendee page shows email history", async () => {
      useResend();
      const listing = await createTestListing({
        maxAttendees: 5,
        name: "Solo",
      });
      const { attendee } = await createTestAttendeeDirect(
        listing.id,
        "Alice",
        "alice@example.com",
      );

      const before = await awaitTestRequest(`/admin/attendees/${attendee.id}`, {
        cookie: await testCookie(),
      }).then((r) => r.text());
      expect(before).toContain("Email History");
      expect(before).toContain("Never contacted by bulk email.");

      await adminFormPost("/admin/emails/preview", {
        body: "Hello",
        listing_id: String(listing.id),
        subject: "Newsletter",
      });
      await adminFormPost("/admin/emails/send", {});

      const after = await awaitTestRequest(`/admin/attendees/${attendee.id}`, {
        cookie: await testCookie(),
      }).then((r) => r.text());
      expect(after).toContain("Total messages:");
      expect(after).toContain("Newsletter");
    });
  });
});
