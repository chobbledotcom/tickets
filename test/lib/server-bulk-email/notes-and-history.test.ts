import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { encryptWithOwnerKey } from "#shared/crypto/keys.ts";
import {
  getContactRecord,
  hashEmail,
  hashPhone,
  recordBooking,
  saveContactRecord,
  toContactHashParam,
} from "#shared/db/contact-preferences.ts";
import { settings } from "#shared/db/settings.ts";
import {
  adminFormPost,
  adminGet,
  describeWithEnv,
  expectHtmlResponse,
  expectRedirect,
  getTestPrivateKey,
  useFetchStub,
} from "#test-utils";
import {
  createTestAttendeeDirect,
  createTestListing,
} from "#test-utils/db-helpers.ts";
import { seedDraft, seedListingWithAttendees, useResend } from "./helpers.ts";

describeWithEnv("server bulk email > notes and history", { db: true }, () => {
  describe("draft helpers", () => {
    test("a malformed stored draft is treated as absent", async () => {
      await settings.setForTest({
        bulk_email_draft: await encryptWithOwnerKey(
          "{not valid draft json",
          settings.publicKey,
        ),
      });
      const response = await adminGet("/admin/emails/preview");
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
        await adminGet("/admin/emails/preview"),
        200,
        "Stored subject",
      );
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
      return (await adminGet("/admin/emails/preview")).text();
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
        (await adminGet(`/admin/attendees/${attendee.id}`)).text();

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
