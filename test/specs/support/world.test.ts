/**
 * The small shared lookups every story leans on. A story that carried on with a
 * missing record would report the wrong thing — "it forwards nowhere" reads the
 * same as "the listing was destroyed" — so each of these fails loudly instead,
 * and that is what is checked here.
 */

// jscpd:ignore-start
import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { namedThings } from "#test/specs/support/memory.ts";
import {
  asksIfThereIs,
  keepsAnswerAs,
  keepWhatTheyWereTold,
  stillThere,
  type TicketsWorld,
  theBooking,
  theListing,
  whatTheyWereTold,
  whatWasKeptFor,
} from "#test/specs/support/world.ts";

// jscpd:ignore-end

/** Just enough of a World for these lookups to read. */
const worldWith = (fields: Partial<TicketsWorld>): TicketsWorld =>
  fields as TicketsWorld;

/** A World that can remember things by name, for the lookups that read them
 * back. */
const worldRemembering = (): TicketsWorld =>
  worldWith({ things: namedThings() });

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

  describe("what the story kept for somebody", () => {
    test("hands each person back their own answer, not the other's", () => {
      const world = worldRemembering();
      keepWhatTheyWereTold(world, "the organiser", "Status created");
      keepWhatTheyWereTold(world, "the editor", "You cannot do that");
      expect(whatTheyWereTold(world, "the organiser")).toBe("Status created");
      expect(whatTheyWereTold(world, "the editor")).toBe("You cannot do that");
    });

    test("fails loudly when the story kept nothing for them", () => {
      expect(() =>
        whatTheyWereTold(worldRemembering(), "the organiser"),
      ).toThrow('the told "the organiser"');
    });

    test("reads a different kind of thing under the same name", () => {
      const world = worldRemembering();
      world.things.remember("ticket", "Ada", "abc123");
      expect(whatWasKeptFor("ticket")(world, "Ada")).toBe("abc123");
    });
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

  describe("asking whether the site still offers something", () => {
    /** Asks about one page, against a lookup that always answers the same. */
    const asksGiven = (found: string | null) =>
      asksIfThereIs(() => Promise.resolve(found))(worldWith({}), "Directions");

    test("says yes when the lookup finds it", async () => {
      expect(await asksGiven("/admin/thing/1")).toBe(true);
    });

    test("says no when the lookup finds nothing", async () => {
      expect(await asksGiven(null)).toBe(false);
    });

    test("asks about the thing it was given", async () => {
      const asked: string[] = [];
      const asks = asksIfThereIs((_world, name) => {
        asked.push(name);
        return Promise.resolve(null);
      });
      await asks(worldWith({}), "Parking");
      expect(asked).toEqual(["Parking"]);
    });
  });

  describe("keeping what a journey answered", () => {
    test("keeps the answer under the name the story reads it by", async () => {
      const world = worldRemembering();
      await keepsAnswerAs("price summary", () => Promise.resolve("£9.00"))(
        world,
      );
      expect(world.things.require("told", "price summary")).toBe("£9.00");
    });

    test("hands the journey the world and everything after it", async () => {
      const given: unknown[] = [];
      const world = worldRemembering();
      await keepsAnswerAs("page", (...args: unknown[]) => {
        given.push(...args);
        return Promise.resolve("gone");
      })(world, "Directions", "directions");
      expect(given).toEqual([world, "Directions", "directions"]);
    });
  });
});
