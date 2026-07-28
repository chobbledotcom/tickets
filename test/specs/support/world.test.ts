/**
 * The small shared lookups every story leans on. A story that carried on with a
 * missing record would report the wrong thing — "it forwards nowhere" reads the
 * same as "the listing was destroyed" — so each of these fails loudly instead,
 * and that is what is checked here.
 */

// jscpd:ignore-start
import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import {
  stillThere,
  type TicketsWorld,
  theBooking,
  theListing,
} from "#test/specs/support/world.ts";

// jscpd:ignore-end

/** Just enough of a World for these lookups to read. */
const worldWith = (fields: Partial<TicketsWorld>): TicketsWorld =>
  fields as TicketsWorld;

describe("the story's shared lookups", () => {
  test("gives back the listing the story is working on", () => {
    expect(theListing(worldWith({ listingId: 7 }))).toBe(7);
  });

  test("fails loudly when no listing was set up", () => {
    expect(() => theListing(worldWith({}))).toThrow("the listing");
  });

  test("gives back the booking the story is working on", () => {
    expect(theBooking(worldWith({ attendeeId: 12 }))).toBe(12);
  });

  test("fails loudly when no booking was set up", () => {
    expect(() => theBooking(worldWith({}))).toThrow("the booking");
  });

  describe("a record the site still has", () => {
    test("hands the record straight back", () => {
      const found = { id: 3, webhook_url: null };
      expect(stillThere(found, "Pottery")).toBe(found);
    });

    test("names what is gone when the record has vanished", () => {
      expect(() => stillThere(null, "Pottery")).toThrow(
        "The Pottery is gone altogether",
      );
    });

    test("treats nothing at all the same as nothing found", () => {
      expect(() => stillThere(undefined, "Weekend")).toThrow(
        "The Weekend is gone altogether",
      );
    });
  });
});
