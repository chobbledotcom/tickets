import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";

describe("attendee route table", () => {
  test("serves every attendee route under its declared path", async () => {
    const routes = (await import("#routes/admin/attendees.ts")).adminHandlers;
    /* jscpd:ignore-start -- a list of strings, not code */
    const expected = [
      "DELETE /admin/attendees/:attendeeId/delete",
      "GET /admin/attendees",
      "GET /admin/attendees/:attendeeId",
      "GET /admin/attendees/:attendeeId/:tab",
      "GET /admin/attendees/:attendeeId/delete",
      "GET /admin/attendees/:attendeeId/payment-review",
      "GET /admin/attendees/:attendeeId/resend-notification",
      "GET /admin/attendees/csv",
      "GET /admin/attendees/new",
      "GET /admin/listing/:listingId/attendee/:attendeeId/checkin",
      "POST /admin/attendees/:attendeeId",
      "POST /admin/attendees/:attendeeId/delete",
      "POST /admin/attendees/:attendeeId/logistics",
      "POST /admin/attendees/:attendeeId/merge",
      "POST /admin/attendees/:attendeeId/payment-review",
      "POST /admin/attendees/:attendeeId/refresh-payment",
      "POST /admin/attendees/:attendeeId/resend-notification",
      "POST /admin/attendees/new",
      "POST /admin/listing/:listingId/attendee",
      "POST /admin/listing/:listingId/attendee/:attendeeId/checkin",
      "POST /admin/listing/:listingId/attendee/:attendeeId/delete-incomplete",
    ];
    /* jscpd:ignore-end */
    expect(Object.keys(routes).toSorted()).toEqual(expected);
  });
});
