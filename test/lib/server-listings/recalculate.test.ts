// jscpd:ignore-start
import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { handleRequest } from "#routes";
import {
  getListingWithCount,
  updateListingAggregateValues,
} from "#shared/db/listings.ts";
import { getAllActivityLog } from "#test-utils/activity-log.ts";
import {
  expectFlashRedirect,
  expectHtmlResponse,
  followRedirectWithFlash,
  testRequiresAuth,
} from "#test-utils/assertions.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { createTestAttendee } from "#test-utils/db-helpers/attendees.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";
import { postListingSale } from "#test-utils/ledger.ts";
import {
  adminFormPost,
  adminGet,
  setupListingAndLogin,
} from "#test-utils/session.ts";

// jscpd:ignore-end

describeWithEnv(
  "server listings > aggregate recalculation",
  { db: true },
  () => {
    describe("listing aggregate recalculation routes", () => {
      testRequiresAuth("/admin/listings/recalculate/1", {
        setup: async () => {
          await createTestListing({
            maxAttendees: 100,
            thankYouUrl: "https://example.com",
          });
        },
      });

      test("shows current and attendee-derived listing totals", async () => {
        const { listing } = await setupListingAndLogin({
          maxAttendees: 100,
          thankYouUrl: "https://example.com",
        });
        await createTestAttendee(
          listing.id,
          listing.slug,
          "Counted User",
          "counted@example.com",
          2,
        );
        await updateListingAggregateValues(listing.id, {
          booked_quantity: 9,
          tickets_count: 5,
        });

        const response = await adminGet(
          `/admin/listings/recalculate/${listing.id}`,
        );
        await expectHtmlResponse(
          response,
          200,
          "Recalculate:",
          "Current",
          "From attendee data",
          'value="booked_quantity"',
          ">9<",
          ">1<",
        );
      });

      test("resets selected listing totals", async () => {
        const { listing } = await setupListingAndLogin({
          maxAttendees: 100,
          thankYouUrl: "https://example.com",
        });
        const attendee = await createTestAttendee(
          listing.id,
          listing.slug,
          "Reset User",
          "reset@example.com",
          2,
        );
        // Income is projected from the ledger, so seed it with a real sale leg on
        // revenue:<listingId> rather than the (count-only) aggregate override.
        await postListingSale({
          attendeeId: attendee.id,
          eventId: "reset-totals",
          gross: 9000,
          listingId: listing.id,
        });
        await updateListingAggregateValues(listing.id, {
          booked_quantity: 9,
          tickets_count: 5,
        });

        const { response } = await adminFormPost(
          `/admin/listings/recalculate/${listing.id}`,
          { recalculate_fields: "booked_quantity" },
        );
        await expectFlashRedirect(
          `/admin/listing/${listing.id}/edit`,
          "Listing totals recalculated",
          true,
        )(response);

        const updated = await getListingWithCount(listing.id);
        expect(updated?.attendee_count).toBe(1);
        // Resetting only booked_quantity leaves the ledger-projected income alone.
        expect(updated?.income).toBe(9000);
        expect(updated?.tickets_count).toBe(5);
      });

      test("records an activity-log entry when totals are recalculated", async () => {
        const { listing } = await setupListingAndLogin({
          maxAttendees: 100,
          thankYouUrl: "https://example.com",
        });

        await adminFormPost(`/admin/listings/recalculate/${listing.id}`, {
          recalculate_fields: "booked_quantity",
        });

        const log = await getAllActivityLog(10);
        const entry = log.find((e) =>
          e.message.includes("totals recalculated"),
        );
        expect(entry?.message).toBe(
          `Listing '${listing.name}' totals recalculated`,
        );
      });

      test("shows recalculation success on the redirected edit page", async () => {
        const { listing } = await setupListingAndLogin({
          maxAttendees: 100,
          thankYouUrl: "https://example.com",
        });

        const { cookie, response } = await adminFormPost(
          `/admin/listings/recalculate/${listing.id}`,
          { recalculate_fields: "booked_quantity" },
        );
        await expectFlashRedirect(
          `/admin/listing/${listing.id}/edit`,
          "Listing totals recalculated",
          true,
        )(response);

        const editResponse = await followRedirectWithFlash(
          response,
          (request) => handleRequest(request),
          cookie,
        );
        await expectHtmlResponse(
          editResponse,
          200,
          "Listing totals recalculated",
        );
      });

      test("rejects listing recalculation with no selected totals", async () => {
        const { listing } = await setupListingAndLogin({
          maxAttendees: 100,
          thankYouUrl: "https://example.com",
        });

        const { response } = await adminFormPost(
          `/admin/listings/recalculate/${listing.id}`,
          {},
        );
        await expectHtmlResponse(
          response,
          400,
          "Choose at least one total to recalculate",
        );
      });
    });
  },
);
