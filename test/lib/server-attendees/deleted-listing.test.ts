import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { loadExistingLines } from "#shared/db/attendees/atomic-update.ts";
import { getAttendeeRaw } from "#shared/db/attendees/queries.ts";
import { getCheckoutStageOrNull } from "#shared/db/checkout-stages.ts";
import { createSystemNote, getNoteRows } from "#shared/db/system-notes.ts";
import {
  expectFlashRedirect,
  expectHtmlResponse,
} from "#test-utils/assertions.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { getAttendeeQuantities } from "#test-utils/db-helpers/attendees.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";
import { adminFormPost, adminGet } from "#test-utils/session.ts";
import {
  resolvedDeletedListingAttendee,
  submitAttendeeEdit,
} from "./helpers.ts";

describeWithEnv(
  "server (admin attendees) > deleted listing",
  { db: true },
  () => {
    test("exports a retained booking with a deleted-listing placeholder", async () => {
      await resolvedDeletedListingAttendee("cs_csv_deleted_listing");

      const response = await adminGet("/admin/attendees/csv");
      expect(response.status).toBe(200);
      const csv = await response.text();
      expect(csv).toContain("Buyer");
      expect(csv).toContain("Deleted listing");
    });

    test("shows an attendee whose only booking belongs to a deleted listing", async () => {
      const { listingId } = await resolvedDeletedListingAttendee(
        "cs_attendees_list_deleted_only",
      );

      const html = await (await adminGet("/admin/attendees")).text();
      expect(html).toContain("Buyer");
      expect(html).toContain("Deleted listing");
      expect(html).not.toContain(`href="/admin/listing/${listingId}"`);
    });

    test("shows deleted and live bookings together without a dead link", async () => {
      const live = await createTestListing({
        maxAttendees: 100,
        name: "Still Here",
      });
      const { listingId } = await resolvedDeletedListingAttendee(
        "cs_attendees_list_deleted_mixed",
        [live],
      );

      const html = await (await adminGet("/admin/attendees")).text();
      expect(html).toContain("Buyer");
      expect(html).toContain("Deleted listing");
      expect(html).toContain(`href="/admin/listing/${live.id}"`);
      expect(html).not.toContain(`href="/admin/listing/${listingId}"`);
    });

    test("offers only valid actions after the home listing was deleted", async () => {
      const { attendeeId } = await resolvedDeletedListingAttendee(
        "cs_detail_deleted_actions",
      );
      const base = `/admin/attendees/${attendeeId}`;

      const overview = await expectHtmlResponse(await adminGet(base), 200);
      expect(overview).toContain(`href="${base}/edit"`);
      expect(overview).toContain(`href="${base}/actions"`);
      const actions = await expectHtmlResponse(
        await adminGet(`${base}/actions`),
        200,
      );
      expect(actions).toContain(`href="${base}/delete"`);
      expect(actions).not.toContain(`href="${base}/resend-notification`);
      expect(actions).not.toContain("/admin/sms?");
    });

    test("renders the deleted booking as a locked edit line", async () => {
      const { attendeeId } = await resolvedDeletedListingAttendee(
        "cs_edit_deleted_render",
      );

      const html = await expectHtmlResponse(
        await adminGet(`/admin/attendees/${attendeeId}/edit`),
        200,
      );
      expect(html).toContain("Deleted listing");
      expect(html).toContain('name="noqty_0" type="hidden"');
      expect(html).not.toContain('name="qty_0"');
    });

    test("keeps the locked row when saving an unrelated edit", async () => {
      const { attendeeId, key, listingId } =
        await resolvedDeletedListingAttendee("cs_edit_deleted_keep");

      const response = await submitAttendeeEdit(attendeeId, {
        lines: [{ eventId: listingId, key, noQuantity: true, quantity: 0 }],
        name: "Renamed Keeper",
      });

      expect(response.status).toBe(302);
      expect(await getAttendeeQuantities(attendeeId)).toEqual([
        { quantity: 0 },
      ]);
    });

    test("refuses changing a locked deleted-listing line", async () => {
      const { attendeeId, key, listingId } =
        await resolvedDeletedListingAttendee("cs_edit_deleted_unlock");

      const response = await submitAttendeeEdit(attendeeId, {
        lines: [{ eventId: listingId, key, quantity: 1 }],
        name: "Hand Crafted",
      });

      expect(response.status).toBe(200);
      expect(await response.text()).toContain("That line is locked");
      expect(await getAttendeeQuantities(attendeeId)).toEqual([
        { quantity: 0 },
      ]);
    });

    test("refuses omitting a locked row while another booking remains", async () => {
      const live = await createTestListing({
        maxAttendees: 100,
        name: "Live companion",
      });
      const { attendeeId } = await resolvedDeletedListingAttendee(
        "cs_edit_deleted_omitted",
        [live],
      );
      const before = await loadExistingLines(attendeeId);
      const liveLine = before.find(
        ({ booking }) => booking.listing_id === live.id,
      )!;

      const response = await submitAttendeeEdit(attendeeId, {
        lines: [
          {
            eventId: live.id,
            key: liveLine.key,
            noQuantity: true,
            quantity: 0,
          },
        ],
        name: "Crafted Omission",
      });

      expect(response.status).toBe(200);
      expect(await response.text()).toContain("That line is locked");
      expect(await loadExistingLines(attendeeId)).toEqual(before);
    });

    test("shows the delete confirmation without a live home listing", async () => {
      const { attendeeId } = await resolvedDeletedListingAttendee(
        "cs_delete_deleted_get",
      );

      await expectHtmlResponse(
        await adminGet(`/admin/attendees/${attendeeId}/delete`),
        200,
        "Delete Attendee",
        "Buyer",
      );
    });

    test("deletes the resolved record and its dependants", async () => {
      const sessionId = "cs_delete_deleted_post";
      const { attendeeId } = await resolvedDeletedListingAttendee(sessionId);
      await createSystemNote(attendeeId, "Delete this note with its attendee.");

      const { response } = await adminFormPost(
        `/admin/attendees/${attendeeId}/delete`,
        { confirm_identifier: "Buyer", release_bookings: "1" },
      );

      await expectFlashRedirect(
        "/admin/attendees",
        "Attendee deleted",
      )(response);
      expect(await getAttendeeRaw(attendeeId)).toBeNull();
      expect(await loadExistingLines(attendeeId)).toEqual([]);
      expect(await getCheckoutStageOrNull(sessionId)).toBeNull();
      expect(await getNoteRows([attendeeId])).toEqual([]);
    });
  },
);
