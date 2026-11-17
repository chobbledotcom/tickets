import { assertStringIncludes } from "@std/assert";
import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { attendeesApi } from "#db/attendees/api.ts";
import { getDb } from "#db/client.ts";
import { sql } from "#db/sql.ts";
import {
  attendeeLineIndex,
  expectHtmlResponse,
  expectIncludesAll,
} from "#test-utils/assertions.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { buildAttendeeEditForm } from "#test-utils/db-helpers/attendees.ts";
import { listingWithAttendee } from "#test-utils/db-helpers/listing-attendee.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";
import { postListingSale } from "#test-utils/ledger.ts";
import { adminFormPost, adminGet } from "#test-utils/session.ts";
import type { Attendee, Listing } from "#types";

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
          "#db/attendees/atomic-update.ts"
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
          "#db/attendees/atomic-update.ts"
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

      /** Book a "ghost" attendee on a 50-place listing and mark its line
       *  no-quantity: the submit must redirect (302). */
      const markGhostBooking = async (
        name: string,
        email: string,
      ): Promise<{ attendee: Attendee; listing: Listing }> => {
        const booking = await listingWithAttendee(50, name, email);
        const response = await markNoQuantity(
          booking.attendee.id,
          booking.listing.id,
          name,
        );
        expect(response.status).toBe(302);
        return booking;
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
        const created = await attendeesApi.createAttendeeAtomic({
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

      const ghostQuantityCases: readonly [
        name: string,
        person: string,
        email: string,
        expected: { price_paid?: number; quantity: number },
      ][] = [
        [
          "marking a line no-quantity keeps it as a quantity-0 row, not deleted",
          "Ghost",
          "ghost@example.com",
          // The line survives (not removed) as a quantity-0, price_paid-0
          // sentinel.
          { price_paid: 0, quantity: 0 },
        ],
        [
          "a no-quantity-only attendee saves instead of being rejected as no lines",
          "OnlyGhost",
          "onlyghost@example.com",
          { quantity: 0 },
        ],
      ];

      for (const [name, person, email, expected] of ghostQuantityCases) {
        test(name, async () => {
          const { attendee, listing } = await markGhostBooking(person, email);
          expect(await readLine(attendee.id, listing.id)).toMatchObject(
            expected,
          );
        });
      }

      test("a stored quantity-0 line renders with the no-quantity box ticked", async () => {
        const { attendee, listing } = await markGhostBooking(
          "Ghost",
          "ghost@example.com",
        );

        const html = await (
          await adminGet(`/admin/attendees/${attendee.id}/edit`)
        ).text();
        // Alphabetical attribute order puts `checked` first when ticked.
        assertStringIncludes(
          html,
          `checked class="no-quantity-toggle" name="noqty${attendeeLineIndex(
            html,
            listing.id,
          )}"`,
        );
      });

      test("the quantity input uses CSP-safe styling", async () => {
        const { attendee } = await listingWithAttendee(
          50,
          "Styled",
          "styled@example.com",
        );

        const html = await (
          await adminGet(`/admin/attendees/${attendee.id}/edit`)
        ).text();
        // Scope the assertions to the quantity input itself: broad
        // assertStringIncludes(html, 'class="line-qty"') would also pass if the class
        // appeared on an unrelated element, and a negative assert would also
        // pass if the inline width style sat on a different tag.
        const qtyInputMatch = html.match(
          /<input\b[^>]*\bclass="line-qty"[^>]*>/,
        );
        expect(qtyInputMatch).not.toBeNull();
        const qtyInput = qtyInputMatch?.[0] ?? "";
        expectIncludesAll(qtyInput, ['class="line-qty"', 'type="number"']);
        expect(qtyInput).not.toMatch(/\bstyle\s*=/);
      });

      test("marking a checked-in line no-quantity clears its check-in", async () => {
        const { attendee, listing } = await listingWithAttendee(
          50,
          "WasIn",
          "wasin@example.com",
        );
        await getDb().execute(
          sql`UPDATE listing_attendees SET checked_in = 1 WHERE attendee_id = ${attendee.id} AND listing_id = ${listing.id}`,
        );

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
        expectIncludesAll(html, [
          `<div autofocus class="error" role="alert" tabindex="-1">Refund this line's payment before marking it no quantity.</div>`,
          // The paid line's "no quantity" box is disabled with an explaining tooltip
          // so it can't be ticked in the first place.
          `class="no-quantity-toggle" disabled name="noqty${attendeeLineIndex(
            html,
            listing.id,
          )}" title="Refund this line's payment before marking it no quantity."`,
        ]);
        expect(await readLine(attendeeId, listing.id)).toMatchObject({
          price_paid: 1500,
          quantity: 2,
        });
      });

      // (No "clears an unpayable balance" test: an outstanding balance now projects
      // from a ledger sale leg, and a line with a sale leg can't be marked
      // no-quantity — hasPaidLine blocks it — so a real line's balance can never be
      // stranded by the no-quantity transition in the first place.)

      test("blocks marking an assigned built-site line no-quantity", async () => {
        const { attendee, listing } = await listingWithAttendee(
          50,
          "Sited",
          "sited@example.com",
        );
        // Assign a site to this booking. Deliberately leave the listing's
        // assign_built_site flag OFF: the block keys off the actual assignment row,
        // not the listing's current flag (which an owner may have turned off).
        await getDb().execute(
          sql`INSERT INTO built_sites (site_data, assignable, assigned_attendee_id, assigned_listing_id, created) VALUES ('{}', 0, ${attendee.id}, ${listing.id}, '2026-01-01T00:00:00Z')`,
        );

        const response = await markNoQuantity(attendee.id, listing.id, "Sited");

        // Re-renders in place with the block message; the line stays a real booking.
        const html = await expectHtmlResponse(response, 200);
        assertStringIncludes(html, "Unassign the built site");
        const row = await getDb().execute(
          sql`SELECT quantity FROM listing_attendees WHERE attendee_id = ${attendee.id} AND listing_id = ${listing.id}`,
        );
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
        assertStringIncludes(html, "Refund this booking's payment");
        // The paid line is untouched (not dropped/replaced by a ghost).
        expect(await readLine(attendeeId, listing.id)).toMatchObject({
          price_paid: 1500,
          quantity: 1,
        });
      });
    });
  },
);
