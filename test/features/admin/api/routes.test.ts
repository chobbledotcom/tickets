import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { assertJson } from "#test-utils/assertions.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { createBooking } from "#test-utils/db-helpers/attendees.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";
import { apiRequest } from "#test-utils/session.ts";

describeWithEnv("Admin API - route table", { db: true }, () => {
  test("serves the booking create route", async () => {
    const listing = await createTestListing({
      maxAttendees: 5,
      name: "Route Fair",
    });
    await assertJson(createBooking(listing.id), 201, (body) => {
      expect(body.attendee.listing_id).toBe(listing.id);
    });
  });

  test("names the listing when the roster's listing is missing", async () => {
    await assertJson(
      apiRequest("/api/admin/listings/99999/attendees"),
      404,
      (body) => {
        expect(body.error).toBe("Listing not found");
      },
    );
  });
});
