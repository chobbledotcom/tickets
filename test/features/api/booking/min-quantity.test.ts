import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { createAndBook, describePublicApi } from "#test-utils/api/helpers.ts";

describePublicApi(() => {
  describe("POST /api/listings/:slug/book — the listing minimum", () => {
    test("requires the quantity field instead of booking one ticket", async () => {
      // The API no longer defaults an absent quantity to 1: every booking
      // must state how many places it books. `quantity: undefined` drops the
      // key from the helper's merged body.
      const { listing, response, body } = await createAndBook(
        { maxAttendees: 10 },
        { quantity: undefined },
      );
      expect(response.status).toBe(400);
      expect(body.error).toBe("Quantity is required");
      const { getAttendeesRaw } = await import("#db/attendees/queries.ts");
      expect((await getAttendeesRaw(listing.id)).length).toBe(0);
    });

    test("rejects a malformed quantity", async () => {
      const { response, body } = await createAndBook(
        { maxAttendees: 10 },
        { quantity: "abc" },
      );
      expect(response.status).toBe(400);
      expect(body.error).toBe("Quantity must be a whole number of 1 or more");
    });

    test("rejects a quantity below the listing's minimum", async () => {
      const { listing, response, body } = await createAndBook(
        { maxAttendees: 10, maxQuantity: 10, minQuantity: 3 },
        { quantity: 2 },
      );
      expect(response.status).toBe(400);
      expect(body.error).toBe("Quantity must be at least 3.");
      const { getAttendeesRaw } = await import("#db/attendees/queries.ts");
      expect((await getAttendeesRaw(listing.id)).length).toBe(0);
    });

    test("rejects a quantity above the listing's maximum instead of clamping it", async () => {
      // The form's select never offers a quantity above the maximum, so a
      // crafted POST is the only client that can send one. It must read a
      // refusal, not a booking for fewer places than it asked for.
      const { listing, response, body } = await createAndBook(
        { maxAttendees: 10, maxQuantity: 4 },
        { quantity: 5 },
      );
      expect(response.status).toBe(400);
      expect(body.error).toBe("Quantity must be at most 4.");
      const { getAttendeesRaw } = await import("#db/attendees/queries.ts");
      expect((await getAttendeesRaw(listing.id)).length).toBe(0);
    });

    test("books the listing's minimum quantity", async () => {
      const { response } = await createAndBook(
        { maxAttendees: 10, maxQuantity: 10, minQuantity: 3 },
        { quantity: 3 },
      );
      expect(response.status).toBe(200);
    });
  });
});
