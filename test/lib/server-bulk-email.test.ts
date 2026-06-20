import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { type BulkEmailDraft, serializeDraft } from "#shared/bulk-email.ts";
import { encryptWithOwnerKey } from "#shared/crypto/keys.ts";
import {
  getAllActivityLog,
  getListingActivityLog,
} from "#shared/db/activityLog.ts";
import { getDb } from "#shared/db/client.ts";
import {
  getContactRecord,
  hashEmail,
  hashPhone,
  recordBooking,
  saveContactRecord,
  toContactHashParam,
  unsubscribeHash,
} from "#shared/db/contact-preferences.ts";
import { settings } from "#shared/db/settings.ts";
import { MAX_EMAIL_TEMPLATES } from "#shared/limits.ts";
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

/**
 * Seed a stored draft the way production does: encrypted with the owner's
 * public key so the route's keypair-based decrypt can read it back.
 */
const seedDraft = async (draft: BulkEmailDraft) =>
  settings.setForTest({
    bulk_email_draft: await encryptWithOwnerKey(
      serializeDraft(draft),
      settings.publicKey,
    ),
  });

describeWithEnv("server (bulk email)", { db: true }, () => {
  describe("GET /admin/emails", () => {
    testRequiresAuth("/admin/emails");

    test("renders the compose page for an owner", async () => {
      expectHtmlResponse(
        await awaitTestRequest("/admin/emails", {
          cookie: await testCookie(),
        }),
        200,
        "Send a bulk email",
        "Audience",
      );
    });

    test("shows the disabled notice when no own provider is configured", async () => {
      const html = await (
        await awaitTestRequest("/admin/emails", {
          cookie: await testCookie(),
        })
      ).text();
      expect(html).toContain("Heads up");
    });

    test("hides the disabled notice when a bulk provider is configured", async () => {
      useResend();
      const html = await (
        await awaitTestRequest("/admin/emails", {
          cookie: await testCookie(),
        })
      ).text();
      expect(html).not.toContain("Heads up");
    });

    test("targets a single listing via ?listing", async () => {
      const listing = await seedListingWithAttendees();
      const html = await (
        await awaitTestRequest(`/admin/emails?listing=${listing.id}`, {
          cookie: await testCookie(),
        })
      ).text();
      expect(html).toContain("Recipients:</strong> Attendees of Gig");
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
      expectHtmlResponse(
        await awaitTestRequest("/admin/emails?audience=bogus", {
          cookie: await testCookie(),
        }),
        200,
        "Send a bulk email",
      );
    });

    test("accepts an explicit valid audience", async () => {
      const html = await (
        await awaitTestRequest("/admin/emails?audience=upcoming", {
          cookie: await testCookie(),
        })
      ).text();
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
      const html = await (
        await awaitTestRequest(`/admin/emails?listing=${listing.id}`, {
          cookie: await testCookie(),
        })
      ).text();
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
      const html = await (
        await awaitTestRequest("/admin/emails/preview", {
          cookie: await testCookie(),
        })
      ).text();
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
      await adminFormPost("/admin/emails/preview", {
        body: "Hello",
        listing_id: String(listing.id),
        subject: "Big news",
      });
      const html = await (
        await awaitTestRequest("/admin/emails/preview", {
          cookie: await testCookie(),
        })
      ).text();
      expect(html).toContain("everyone in BCC");
      expect(html).toContain("Open a BCC draft to 2 recipients");
      expect(html).toContain("mailto:owner%40example.com?bcc=");
    });

    test("addresses a lone recipient directly instead of using BCC", async () => {
      useResend();
      // A business email is set but must be ignored for a single recipient.
      settings.setForTest({ business_email: "owner@example.com" });
      const listing = await seedSingleAttendeeListing();
      await adminFormPost("/admin/emails/preview", {
        body: "Hello",
        listing_id: String(listing.id),
        subject: "Big news",
      });
      const html = await (
        await awaitTestRequest("/admin/emails/preview", {
          cookie: await testCookie(),
        })
      ).text();
      expect(html).toContain("Open a draft to 1 recipient");
      expect(html).toContain("addressed straight to your one recipient");
      expect(html).toContain("mailto:alice%40example.com?");
      expect(html).not.toContain("Open a BCC draft");
      expect(html).not.toContain("everyone in BCC");
    });

    test("omits the address list when there are no recipients", async () => {
      useResend();
      await seedDraft({
        body: "Body",
        marketing: false,
        subject: "Subject",
        target: { kind: "listing", listingId: 987654 },
      });
      const html = await (
        await awaitTestRequest("/admin/emails/preview", {
          cookie: await testCookie(),
        })
      ).text();
      expect(html).not.toContain('class="recipient-emails"');
    });

    test("disables sending and explains marketing when not sendable", async () => {
      const listing = await seedListingWithAttendees();
      await adminFormPost("/admin/emails/preview", {
        body: "Promo time",
        listing_id: String(listing.id),
        marketing: "1",
        subject: "Sale",
      });
      const html = await (
        await awaitTestRequest("/admin/emails/preview", {
          cookie: await testCookie(),
        })
      ).text();
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
      const html = await (
        await awaitTestRequest("/admin/emails/preview", {
          cookie: await testCookie(),
        })
      ).text();
      expect(html).toContain("Active listing attendees");
      expect(html).toContain(
        "Everyone booked onto a listing that is currently active.",
      );
      expect(html).toContain("1 recipient");
      expect(html).not.toContain("1 recipients");
    });

    test("labels a target whose listing has since been deleted", async () => {
      useResend();
      await seedDraft({
        body: "Body",
        marketing: false,
        subject: "Subject",
        target: { kind: "listing", listingId: 987654 },
      });
      const html = await (
        await awaitTestRequest("/admin/emails/preview", {
          cookie: await testCookie(),
        })
      ).text();
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
      const html = await (
        await awaitTestRequest("/admin/emails/preview", {
          cookie: await testCookie(),
        })
      ).text();
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
        await awaitTestRequest(
          `/admin/emails?attendee=${encodeURIComponent(token)}`,
          { cookie: await testCookie() },
        )
      ).text();
      expect(html).toContain("Email an attendee");
      expect(html).toContain("alice@example.com");
      // The token round-trips through a hidden field so the POST keeps the target.
      expect(html).toContain('name="attendee"');
      expect(html).toContain("Preview to confirm the message before sending.");
    });

    test("404s for an unknown attendee token", async () => {
      const response = await awaitTestRequest("/admin/emails?attendee=gone", {
        cookie: await testCookie(),
      });
      expect(response.status).toBe(404);
    });

    test("404s for an attendee with no email on file", async () => {
      const listing = await createTestListing({
        maxAttendees: 5,
        name: "Solo",
      });
      const { token } = await createTestAttendeeDirect(listing.id, "Nemo", "");
      const response = await awaitTestRequest(
        `/admin/emails?attendee=${encodeURIComponent(token)}`,
        { cookie: await testCookie() },
      );
      expect(response.status).toBe(404);
    });

    test("404s for a listing whose attendees have no email", async () => {
      const listing = await createTestListing({
        maxAttendees: 5,
        name: "Solo",
      });
      await createTestAttendeeDirect(listing.id, "Nemo", "");
      const response = await awaitTestRequest(
        `/admin/emails?listing=${listing.id}`,
        { cookie: await testCookie() },
      );
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
      const html = await (
        await awaitTestRequest("/admin/emails/preview", {
          cookie: await testCookie(),
        })
      ).text();
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
      const html = await (
        await awaitTestRequest("/admin/emails/preview", {
          cookie: await testCookie(),
        })
      ).text();
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

      expectRedirectWithFlash(
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
    });
  });

  describe("attendee page Email link", () => {
    test("owners see a link to email the attendee, carrying their token", async () => {
      const listing = await createTestListing({
        maxAttendees: 5,
        name: "Solo",
      });
      const { attendee, token } = await createTestAttendeeDirect(
        listing.id,
        "Alice",
        "alice@example.com",
      );
      const html = await (
        await awaitTestRequest(`/admin/attendees/${attendee.id}`, {
          cookie: await testCookie(),
        })
      ).text();
      expect(html).toContain(
        `/admin/emails?attendee=${encodeURIComponent(token)}`,
      );
      expect(html).toContain("Send an email to this attendee");
    });

    test("managers do not see the email link", async () => {
      const listing = await createTestListing({
        maxAttendees: 5,
        name: "Solo",
      });
      const { attendee } = await createTestAttendeeDirect(
        listing.id,
        "Alice",
        "alice@example.com",
        1,
        "07700 900333",
      );
      const cookie = await createTestManagerSession();
      const html = await (
        await awaitTestRequest(`/admin/attendees/${attendee.id}`, {
          cookie,
        })
      ).text();
      expect(html).not.toContain("/admin/emails?attendee=");
    });

    test("the link is disabled when the attendee has no email", async () => {
      const listing = await createTestListing({
        maxAttendees: 5,
        name: "Solo",
      });
      const { attendee } = await createTestAttendeeDirect(
        listing.id,
        "Nemo",
        "",
      );
      const html = await (
        await awaitTestRequest(`/admin/attendees/${attendee.id}`, {
          cookie: await testCookie(),
        })
      ).text();
      expect(html).toContain("No email address on file.");
      // Rendered as an inert span, not a clickable link to the email page.
      expect(html).toContain("btn--disabled");
      expect(html).not.toContain("/admin/emails?attendee=");
    });
  });

  describe("listing page Email link", () => {
    test("owners see the link on the listing page", async () => {
      const listing = await seedListingWithAttendees();
      const html = await (
        await awaitTestRequest(`/admin/listing/${listing.id}`, {
          cookie: await testCookie(),
        })
      ).text();
      expect(html).toContain(`/admin/emails?listing=${listing.id}`);
      expect(html).toContain(">Email</a>");
    });

    test("the link is disabled when no attendee has an email", async () => {
      const listing = await createTestListing({
        maxAttendees: 5,
        name: "Solo",
      });
      await createTestAttendeeDirect(listing.id, "Nemo", "");
      const html = await (
        await awaitTestRequest(`/admin/listing/${listing.id}`, {
          cookie: await testCookie(),
        })
      ).text();
      // Inert span instead of a link to the email page.
      expect(html).toContain("btn--disabled");
      expect(html).not.toContain(`/admin/emails?listing=${listing.id}`);
    });

    test("managers do not see the link", async () => {
      const listing = await seedListingWithAttendees();
      const cookie = await createTestManagerSession();
      const html = await (
        await awaitTestRequest(`/admin/listing/${listing.id}`, {
          cookie,
        })
      ).text();
      expect(html).not.toContain("/admin/emails?listing=");
    });
  });

  describe("draft helpers", () => {
    test("a malformed stored draft is treated as absent", async () => {
      await settings.setForTest({
        bulk_email_draft: await encryptWithOwnerKey(
          "{not valid draft json",
          settings.publicKey,
        ),
      });
      const response = await awaitTestRequest("/admin/emails/preview", {
        cookie: await testCookie(),
      });
      expectRedirect(response, "/admin/emails");
    });

    test("a valid stored draft renders the preview", async () => {
      useResend();
      const listing = await seedListingWithAttendees();
      await seedDraft({
        body: "Stored body",
        marketing: false,
        subject: "Stored subject",
        target: { kind: "listing", listingId: listing.id },
      });
      expectHtmlResponse(
        await awaitTestRequest("/admin/emails/preview", {
          cookie: await testCookie(),
        }),
        200,
        "Stored subject",
      );
    });
  });

  describe("email templates", () => {
    const seedTemplate = async (subject: string, body: string) => {
      const { insertEmailTemplate } = await import(
        "#shared/db/email-templates.ts"
      );
      const { encryptWithOwnerKey: enc } = await import(
        "#shared/crypto/keys.ts"
      );
      const encSubject = await enc(subject, settings.publicKey);
      const encBody = await enc(body, settings.publicKey);
      return insertEmailTemplate(encSubject, encBody);
    };

    test("compose page lists saved templates", async () => {
      await seedTemplate("My Newsletter", "Hello everyone");
      const html = await (
        await awaitTestRequest("/admin/emails?audience=active", {
          cookie: await testCookie(),
        })
      ).text();
      expect(html).toContain("Load a template");
      expect(html).toContain("My Newsletter");
    });

    test("?template=N pre-fills subject and body from the template", async () => {
      const id = await seedTemplate("Pre-fill Subject", "Pre-fill body");
      const html = await (
        await awaitTestRequest(`/admin/emails?audience=active&template=${id}`, {
          cookie: await testCookie(),
        })
      ).text();
      expect(html).toContain("Pre-fill Subject");
      expect(html).toContain("Pre-fill body");
    });

    test("?template=N for an unknown id still renders the compose page", async () => {
      expectHtmlResponse(
        await awaitTestRequest("/admin/emails?audience=active&template=9999", {
          cookie: await testCookie(),
        }),
        200,
      );
    });

    test("?template=N keeps the saved draft's marketing flag while overriding subject and body", async () => {
      const id = await seedTemplate("Template Subject", "Template body");
      await seedDraft({
        body: "Draft body",
        marketing: true,
        subject: "Draft subject",
        target: { audience: "active", kind: "audience" },
      });
      const html = await (
        await awaitTestRequest(`/admin/emails?audience=active&template=${id}`, {
          cookie: await testCookie(),
        })
      ).text();
      // The template's content replaces the draft's…
      expect(html).toContain("Template Subject");
      expect(html).toContain("Template body");
      // …but the marketing flag is carried over from the saved draft.
      expect(html).toContain(
        'checked name="marketing" type="checkbox" value="1"',
      );
    });

    test("POST /admin/emails/templates refuses to save when the template limit is reached", async () => {
      // Fill the table to the cap in one statement. The limit check only counts
      // rows, so the (opaque) content here need not be real encrypted blobs.
      const rows = Array.from(
        { length: MAX_EMAIL_TEMPLATES },
        () => "('x', 'y')",
      ).join(", ");
      await getDb().execute(
        `INSERT INTO email_templates (subject, body) VALUES ${rows}`,
      );
      const { response } = await adminFormPost("/admin/emails/templates", {
        audience: "active",
        body: "Body",
        subject: "Subject",
      });
      expectFlash(
        response,
        `You've reached the limit of ${MAX_EMAIL_TEMPLATES} saved templates.`,
        false,
      );
    });

    test("POST /admin/emails/templates saves a new template and redirects", async () => {
      const { response } = await adminFormPost("/admin/emails/templates", {
        audience: "active",
        body: "Template body",
        subject: "Template subject",
      });
      const redirectUrl = expectRedirect(response);
      expect(redirectUrl).toContain("template=");
      expectFlash(response, "Template saved.");
    });

    test("POST /admin/emails/templates rejects an empty subject", async () => {
      const { response } = await adminFormPost("/admin/emails/templates", {
        audience: "active",
        body: "Template body",
        subject: "",
      });
      expectFlash(response, "Subject is required", false);
    });

    test("POST /admin/emails/templates updates an existing template", async () => {
      const id = await seedTemplate("Old subject", "Old body");
      const { response } = await adminFormPost("/admin/emails/templates", {
        audience: "active",
        body: "Updated body",
        subject: "Updated subject",
        template_id: String(id),
        update_existing: "1",
      });
      const redirectUrl = expectRedirect(response);
      expect(redirectUrl).toContain(`template=${id}`);
      expectFlash(response, "Template updated.");
    });

    test("POST /admin/emails/templates update returns 404 for missing template", async () => {
      const { response } = await adminFormPost("/admin/emails/templates", {
        audience: "active",
        body: "Body",
        subject: "Subject",
        template_id: "9999",
        update_existing: "1",
      });
      expectFlash(response, "That template no longer exists.", false);
    });

    test("GET /admin/emails/templates/:id/delete shows the confirmation page with the decrypted subject", async () => {
      const id = await seedTemplate("To delete", "Body");
      const response = await awaitTestRequest(
        `/admin/emails/templates/${id}/delete`,
        { cookie: await testCookie() },
      );
      const html = await expectHtmlResponse(response, 200);
      expect(html).toContain("Delete template");
      // The subject (encrypted at rest) is decrypted to confirm against.
      expect(html).toContain("To delete");
      expect(html).toContain('name="confirm_identifier"');
    });

    test("GET /admin/emails/templates/:id/delete 404s for unknown template", async () => {
      const response = await awaitTestRequest(
        "/admin/emails/templates/9999/delete",
        { cookie: await testCookie() },
      );
      expect(response.status).toBe(404);
    });

    test("POST /admin/emails/templates/:id/delete removes the template when the subject matches", async () => {
      const id = await seedTemplate("To delete", "Body");
      const { response } = await adminFormPost(
        `/admin/emails/templates/${id}/delete`,
        { confirm_identifier: "To delete" },
      );
      expectRedirectWithFlash(
        "/admin/emails?audience=active",
        "Template deleted.",
      )(response);
    });

    test("POST /admin/emails/templates/:id/delete rejects a mismatched subject", async () => {
      const id = await seedTemplate("To delete", "Body");
      const { response } = await adminFormPost(
        `/admin/emails/templates/${id}/delete`,
        { confirm_identifier: "Wrong subject" },
      );
      expectFlash(
        response,
        "Template subject does not match. Please type the exact template subject to confirm deletion.",
        false,
      );
    });

    test("POST /admin/emails/templates/:id/delete 404s for unknown template", async () => {
      const { response } = await adminFormPost(
        "/admin/emails/templates/9999/delete",
        { confirm_identifier: "anything" },
      );
      expect(response.status).toBe(404);
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
      return (
        await awaitTestRequest("/admin/emails/preview", {
          cookie: await testCookie(),
        })
      ).text();
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
      const stats = await getContactRecord(
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

    test("the attendee page shows per-channel stats, counts and markdown notes", async () => {
      useResend();
      const listing = await createTestListing({
        maxAttendees: 5,
        name: "Solo",
      });
      const { attendee } = await createTestAttendeeDirect(
        listing.id,
        "Alice",
        "alice@example.com",
        1,
        "07700 900333",
      );
      const pk = await getTestPrivateKey();
      const emailHash = await hashEmail("alice@example.com");
      const phoneHash = await hashPhone("07700 900333");

      const attendeePage = async (): Promise<string> =>
        (
          await awaitTestRequest(`/admin/attendees/${attendee.id}`, {
            cookie: await testCookie(),
          })
        ).text();

      // Before any activity: the panel shows a labelled section per channel,
      // each linking to its own /admin/history editor.
      const before = await attendeePage();
      expect(before).toContain("Contact History");
      expect(before).toContain("Stats / notes for alice@example.com");
      expect(before).toContain("Stats / notes for 07700 900333");
      expect(before).toContain(
        `/admin/history/${toContactHashParam(emailHash)}`,
      );
      expect(before).toContain(
        `/admin/history/${toContactHashParam(phoneHash)}`,
      );

      // A bulk-email send gives the email contact outreach history...
      await adminFormPost("/admin/emails/preview", {
        body: "Hello",
        listing_id: String(listing.id),
        subject: "Newsletter",
      });
      await adminFormPost("/admin/emails/send", {});

      // ...and we seed split booking counts plus a private markdown note on each
      // contact record (preserving the counts already recorded for the email).
      await recordBooking(emailHash, "public");
      await recordBooking(emailHash, "admin");
      await saveContactRecord(emailHash, {
        ...(await getContactRecord(emailHash, pk)),
        adminNotes: "**Email VIP** customer",
      });
      await saveContactRecord(phoneHash, {
        ...(await getContactRecord(phoneHash, pk)),
        adminNotes: "**Phone VIP** customer",
      });

      const after = await attendeePage();
      // Outreach + per-source booking counts surface for the email contact.
      expect(after).toContain("Total messages:");
      expect(after).toContain("Newsletter");
      expect(after).toContain("Online bookings:");
      expect(after).toContain("Admin bookings:");
      // The private notes render as MARKDOWN (bold), never raw asterisks.
      expect(after).toContain("<strong>Email VIP</strong> customer");
      expect(after).toContain("<strong>Phone VIP</strong> customer");
      expect(after).not.toContain("**Email VIP** customer");
    });
  });
});
