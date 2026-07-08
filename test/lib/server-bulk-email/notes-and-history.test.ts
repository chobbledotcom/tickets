import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { encryptWithOwnerKey } from "#shared/crypto/keys.ts";
import { attendeeStatuses } from "#shared/db/attendee-statuses.ts";
import {
  getContactRecord,
  hashEmail,
  hashPhone,
  saveContactRecord,
  toContactHashParam,
} from "#shared/db/contact-preferences.ts";
import { recordBooking } from "#shared/db/contact-tokens.ts";
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
  buildAttendeeEditForm,
  createTestAttendeeDirect,
} from "#test-utils/db-helpers/attendees.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";
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
      await recordBooking(emailHash, "public", "tok-bulk-pub");
      await recordBooking(emailHash, "admin", "tok-bulk-adm");
      await saveContactRecord(emailHash, {
        ...(await getContactRecord(emailHash, pk)),
        adminNotes: "**Email VIP** customer",
      });
      await saveContactRecord(phoneHash, {
        ...(await getContactRecord(phoneHash, pk)),
        adminNotes: "**Phone VIP** customer",
      });

      const after = await attendeePage();
      // The shared summary lists previous bookings and each channel's messages;
      // the last-subject recap still surfaces the outreach send.
      expect(after).toContain("Previous bookings shown:");
      expect(after).toContain("Total email messages:");
      expect(after).toContain("Total phone messages:");
      expect(after).toContain("Newsletter");
      // The private notes render as MARKDOWN (bold), never raw asterisks.
      expect(after).toContain("<strong>Email VIP</strong> customer");
      expect(after).toContain("<strong>Phone VIP</strong> customer");
      expect(after).not.toContain("**Email VIP** customer");
    });

    test("the Previous bookings table lists other bookings by the same contact", async () => {
      const listing = await createTestListing({
        maxAttendees: 9,
        name: "Repeat",
      });
      // Three bookings under one email: the middle attendee's page should list
      // the other two as previous bookings (a two-row table exercises the
      // newest-first sort), linking through to each.
      const { attendee: first } = await createTestAttendeeDirect(
        listing.id,
        "Repeat One",
        "repeat@example.com",
      );
      const { attendee: second } = await createTestAttendeeDirect(
        listing.id,
        "Repeat Two",
        "repeat@example.com",
      );
      const { attendee: third } = await createTestAttendeeDirect(
        listing.id,
        "Repeat Three",
        "repeat@example.com",
      );
      // Give the first booking a status so its name shows in the table.
      const status = await attendeeStatuses.table.insert({ name: "Confirmed" });
      const { updateAttendeeStatus } = await import("#shared/db/attendees.ts");
      await updateAttendeeStatus(first.id, status.id);

      const html = await (
        await adminGet(`/admin/attendees/${second.id}`)
      ).text();
      // Two previous bookings on file, each date-cell linking to its attendee,
      // the first's status name and the booked listing named in the items
      // column.
      expect(html).toContain("Previous bookings shown:</strong> 2");
      expect(html).toContain(`/admin/attendees/${first.id}`);
      expect(html).toContain(`/admin/attendees/${third.id}`);
      expect(html).toContain("Confirmed");
      expect(html).toContain("Repeat");
      // The current attendee never links to itself in its own table.
      expect(html).not.toContain(`<a href="/admin/attendees/${second.id}">`);
    });

    test("a previous booking edited down to no real lines is not shown", async () => {
      const listing = await createTestListing({
        maxAttendees: 9,
        name: "Emptyable",
      });
      // Two real bookings share an email...
      const { attendee: real } = await createTestAttendeeDirect(
        listing.id,
        "Still Real",
        "empty@example.com",
      );
      const { attendee: emptied } = await createTestAttendeeDirect(
        listing.id,
        "Now Empty",
        "empty@example.com",
      );
      // ...then one is edited down to a no-quantity line (its token stays on the
      // contact, but it no longer represents a booked ticket).
      const { loadExistingLines } = await import("#shared/db/attendees.ts");
      const existing = await loadExistingLines(emptied.id);
      const form = await buildAttendeeEditForm(emptied.id, {
        email: "empty@example.com",
        lines: [
          {
            eventId: listing.id,
            key: existing[0]!.key,
            noQuantity: true,
            quantity: 0,
          },
        ],
        name: "Now Empty",
      });
      await adminFormPost(`/admin/attendees/${emptied.id}`, form);

      // Viewing the still-real booking, the emptied one neither counts nor links.
      const html = await (await adminGet(`/admin/attendees/${real.id}`)).text();
      expect(html).toContain("Previous bookings shown:</strong> 0");
      expect(html).not.toContain(`/admin/attendees/${emptied.id}`);
    });

    test("changing an attendee's email moves its Previous bookings link", async () => {
      const listing = await createTestListing({
        maxAttendees: 9,
        name: "Movable",
      });
      // Two attendees share an email, so each is the other's previous booking.
      const { attendee: anchor } = await createTestAttendeeDirect(
        listing.id,
        "Anchor",
        "shared@example.com",
      );
      const { attendee: mover } = await createTestAttendeeDirect(
        listing.id,
        "Mover",
        "shared@example.com",
      );
      const anchorPage = async (): Promise<string> =>
        (await adminGet(`/admin/attendees/${anchor.id}`)).text();

      // The anchor initially sees the mover as a previous booking.
      expect(await anchorPage()).toContain(`/admin/attendees/${mover.id}`);

      // Move the mover to a different email via the edit form.
      const form = await buildAttendeeEditForm(mover.id, {
        email: "moved-away@example.com",
        name: "Mover",
      });
      await adminFormPost(`/admin/attendees/${mover.id}`, form);

      // The mover no longer shows against the shared email...
      expect(await anchorPage()).not.toContain(`/admin/attendees/${mover.id}`);
      // ...but does show against its new email's contact (via the new attendee).
      const { attendee: newContact } = await createTestAttendeeDirect(
        listing.id,
        "New Contact",
        "moved-away@example.com",
      );
      expect(
        await (await adminGet(`/admin/attendees/${newContact.id}`)).text(),
      ).toContain(`/admin/attendees/${mover.id}`);
    });

    test("adding an email to an existing booking links it to that contact", async () => {
      const listing = await createTestListing({
        maxAttendees: 9,
        name: "Added Contact",
      });
      const { attendee: added } = await createTestAttendeeDirect(
        listing.id,
        "Added Later",
        "",
      );
      const form = await buildAttendeeEditForm(added.id, {
        email: "added-later@example.com",
        name: "Added Later",
      });
      await adminFormPost(`/admin/attendees/${added.id}`, form);

      const { attendee: watcher } = await createTestAttendeeDirect(
        listing.id,
        "Watcher",
        "added-later@example.com",
      );
      const html = await (
        await adminGet(`/admin/attendees/${watcher.id}`)
      ).text();
      expect(html).toContain(`/admin/attendees/${added.id}`);
    });

    test("editing a placeholder into a real booking links its token", async () => {
      const listing = await createTestListing({
        maxAttendees: 9,
        name: "First Real",
      });
      const { attendee: placeholder } = await createTestAttendeeDirect(
        listing.id,
        "Placeholder",
        "first-real@example.com",
        0,
      );
      const { attendee: watcher } = await createTestAttendeeDirect(
        listing.id,
        "Watcher",
        "first-real@example.com",
      );
      const watcherPage = async (): Promise<string> =>
        (await adminGet(`/admin/attendees/${watcher.id}`)).text();
      expect(await watcherPage()).not.toContain(
        `/admin/attendees/${placeholder.id}`,
      );

      const { loadExistingLines } = await import("#shared/db/attendees.ts");
      const existing = await loadExistingLines(placeholder.id);
      const form = await buildAttendeeEditForm(placeholder.id, {
        email: "first-real@example.com",
        lines: [
          {
            eventId: listing.id,
            key: existing[0]!.key,
            quantity: 1,
          },
        ],
        name: "Placeholder",
      });
      await adminFormPost(`/admin/attendees/${placeholder.id}`, form);

      expect(await watcherPage()).toContain(
        `/admin/attendees/${placeholder.id}`,
      );
    });
  });
});
