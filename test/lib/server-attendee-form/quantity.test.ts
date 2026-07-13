import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { createAttendeeAtomic } from "#shared/db/attendees/api.ts";
import { getDb } from "#shared/db/client.ts";
import {
  attendeeLineIndex,
  expectHtmlResponse,
} from "#test-utils/assertions.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import {
  buildAttendeeEditForm,
  createTestAttendee,
} from "#test-utils/db-helpers/attendees.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";
import { postListingSale } from "#test-utils/ledger.ts";
import { adminFormPost, adminGet } from "#test-utils/session.ts";

describeWithEnv(
  "server (unified attendee form) — no-quantity",
  { db: true },
  () => {
    describe("no-quantity checkbox round-trip", () => {
      // price_paid is projected from the ledger now, so read the line through
      // loadExistingLines (the same projection the edit form uses) rather than a
      // raw column select.
      const readLine = async (attendeeId: number, listingId: number) => {
        const { loadExistingLines } = await import(
          "#shared/db/attendees/atomic-update.ts"
        );
        const entry = (await loadExistingLines(attendeeId)).find(
          (e) => e.booking.listing_id === listingId,
        );
        return entry?.booking ?? null;
      };

      const markNoQuantity = async (
        attendeeId: number,
        listingId: number,
        name: string,
      ): Promise<Response> => {
        const { loadExistingLines } = await import(
          "#shared/db/attendees/atomic-update.ts"
        );
        const key = (await loadExistingLines(attendeeId)).find(
          (e) => e.booking.listing_id === listingId,
        )!.key;
        const form = await buildAttendeeEditForm(attendeeId, {
          lines: [{ eventId: listingId, key, noQuantity: true, quantity: 1 }],
          name,
        });
        const { response } = await adminFormPost(
          `/admin/attendees/${attendeeId}`,
          form,
        );
        return response;
      };

      /** Book a paid attendee on `listingId` and recognise a £15 sale leg in the
       *  ledger, so hasPaidLine's DB guard sees a gross sale (not a price_paid
       *  column). Returns the new attendee id. */
      const bookPaidAttendee = async (
        listingId: number,
        details: {
          email: string;
          name: string;
          paymentId: string;
          quantity: number;
        },
      ): Promise<number> => {
        const created = await createAttendeeAtomic({
          bookings: [{ listingId, quantity: details.quantity }],
          email: details.email,
          name: details.name,
          paymentId: details.paymentId,
        });
        if (!created.success) throw new Error("setup");
        const attendeeId = created.attendees[0]!.id;
        await postListingSale({ attendeeId, gross: 1500, listingId });
        return attendeeId;
      };

      test("marking a line no-quantity keeps it as a quantity-0 row, not deleted", async () => {
        const listing = await createTestListing({ maxAttendees: 50 });
        const attendee = await createTestAttendee(
          listing.id,
          listing.slug,
          "Ghost",
          "ghost@example.com",
        );

        const response = await markNoQuantity(attendee.id, listing.id, "Ghost");

        expect(response.status).toBe(302);
        // The line survives (not removed) as a quantity-0, price_paid-0 sentinel.
        expect(await readLine(attendee.id, listing.id)).toMatchObject({
          price_paid: 0,
          quantity: 0,
        });
      });

      test("a stored quantity-0 line renders with the no-quantity box ticked", async () => {
        const listing = await createTestListing({ maxAttendees: 50 });
        const attendee = await createTestAttendee(
          listing.id,
          listing.slug,
          "Ghost",
          "ghost@example.com",
        );
        await markNoQuantity(attendee.id, listing.id, "Ghost");

        const html = await (
          await adminGet(`/admin/attendees/${attendee.id}/edit`)
        ).text();
        // Alphabetical attribute order puts `checked` first when ticked.
        expect(html).toContain(
          `checked class="no-quantity-toggle" name="noqty_${attendeeLineIndex(
            html,
            listing.id,
          )}"`,
        );
      });

      test("marking a checked-in line no-quantity clears its check-in", async () => {
        const listing = await createTestListing({ maxAttendees: 50 });
        const attendee = await createTestAttendee(
          listing.id,
          listing.slug,
          "WasIn",
          "wasin@example.com",
        );
        await getDb().execute({
          args: [attendee.id, listing.id],
          sql: "UPDATE listing_attendees SET checked_in = 1 WHERE attendee_id = ? AND listing_id = ?",
        });

        await markNoQuantity(attendee.id, listing.id, "WasIn");

        expect(await readLine(attendee.id, listing.id)).toMatchObject({
          checked_in: 0,
          quantity: 0,
        });
      });

      test("blocks marking a paid line no-quantity (line unchanged)", async () => {
        const listing = await createTestListing({ maxAttendees: 50 });
        // Recognise the payment in the ledger: hasPaidLine (the DB guard) keys on a
        // gross sale leg now, not a price_paid column.
        const attendeeId = await bookPaidAttendee(listing.id, {
          email: "paid@example.com",
          name: "Paid",
          paymentId: "pay_block",
          quantity: 2,
        });

        const response = await markNoQuantity(attendeeId, listing.id, "Paid");

        // Re-renders the form in place (200) with the line untouched.
        const html = await expectHtmlResponse(response, 200);
        // The block is surfaced as a top-of-page error, not buried in the table.
        // The alert is focusable (autofocus + tabindex) so the browser scrolls to
        // it after the failed submit.
        expect(html).toContain(
          `<div autofocus class="error" role="alert" tabindex="-1">Refund this line's payment before marking it no quantity.</div>`,
        );
        // The paid line's "no quantity" box is disabled with an explaining tooltip
        // so it can't be ticked in the first place.
        expect(html).toContain(
          `class="no-quantity-toggle" disabled name="noqty_${attendeeLineIndex(
            html,
            listing.id,
          )}" title="Refund this line's payment before marking it no quantity."`,
        );
        expect(await readLine(attendeeId, listing.id)).toMatchObject({
          price_paid: 1500,
          quantity: 2,
        });
      });

      test("a no-quantity-only attendee saves instead of being rejected as no lines", async () => {
        const listing = await createTestListing({ maxAttendees: 50 });
        const attendee = await createTestAttendee(
          listing.id,
          listing.slug,
          "OnlyGhost",
          "onlyghost@example.com",
        );

        const response = await markNoQuantity(
          attendee.id,
          listing.id,
          "OnlyGhost",
        );

        expect(response.status).toBe(302);
        expect(await readLine(attendee.id, listing.id)).toMatchObject({
          quantity: 0,
        });
      });

      // (No "clears an unpayable balance" test: an outstanding balance now projects
      // from a ledger sale leg, and a line with a sale leg can't be marked
      // no-quantity — hasPaidLine blocks it — so a real line's balance can never be
      // stranded by the no-quantity transition in the first place.)

      test("blocks marking an assigned built-site line no-quantity", async () => {
        const listing = await createTestListing({ maxAttendees: 50 });
        const attendee = await createTestAttendee(
          listing.id,
          listing.slug,
          "Sited",
          "sited@example.com",
        );
        // Assign a site to this booking. Deliberately leave the listing's
        // assign_built_site flag OFF: the block keys off the actual assignment row,
        // not the listing's current flag (which an owner may have turned off).
        await getDb().execute({
          args: [attendee.id, listing.id],
          sql: "INSERT INTO built_sites (site_data, assignable, assigned_attendee_id, assigned_listing_id, created) VALUES ('{}', 0, ?, ?, '2026-01-01T00:00:00Z')",
        });

        const response = await markNoQuantity(attendee.id, listing.id, "Sited");

        // Re-renders in place with the block message; the line stays a real booking.
        const html = await expectHtmlResponse(response, 200);
        expect(html).toContain("Unassign the built site");
        const row = await getDb().execute({
          args: [attendee.id, listing.id],
          sql: "SELECT quantity FROM listing_attendees WHERE attendee_id = ? AND listing_id = ?",
        });
        expect(Number(row.rows[0]!.quantity)).toBe(1);
      });

      test("blocks no-quantity on a paid line even with a stale (missing) line key", async () => {
        const listing = await createTestListing({ maxAttendees: 50 });
        const attendeeId = await bookPaidAttendee(listing.id, {
          email: "stale@example.com",
          name: "Stale",
          paymentId: "pay_stale",
          quantity: 1,
        });
        // Submit with an empty line key so the form's existingBooking is null and
        // the per-line model guard can't fire — the DB-based guard must still block.
        const form = await buildAttendeeEditForm(attendeeId, {
          lines: [
            { eventId: listing.id, key: "", noQuantity: true, quantity: 1 },
          ],
          name: "Stale",
        });
        const { response } = await adminFormPost(
          `/admin/attendees/${attendeeId}`,
          form,
        );

        const html = await expectHtmlResponse(response, 200);
        expect(html).toContain("Refund this booking's payment");
        // The paid line is untouched (not dropped/replaced by a ghost).
        expect(await readLine(attendeeId, listing.id)).toMatchObject({
          price_paid: 1500,
          quantity: 1,
        });
      });
    });
  },
);
