import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { reportAnswersForUnbookedListings } from "#db/questions/attendee-answers/unbooked.ts";
import { setupErrorSpy } from "#test-utils/error-spy.ts";

const entryFor = (listingId: number) => ({
  attendee: { id: listingId * 10 },
  listing: { id: listingId },
});

describe("answers filed under a listing nobody booked", () => {
  const errors = setupErrorSpy();

  test("reports a choice-answer key the order did not book", () => {
    reportAnswersForUnbookedListings(
      [entryFor(3), entryFor(7)],
      [{ "12": [400] }, undefined],
    );
    expect(errors.calls).toHaveLength(1);
    expect(errors.lastMessage()).toContain("listing 12");
    expect(errors.lastMessage()).toContain("E_DATA_INVALID");
  });

  test("reports a text-answer key the order did not book", () => {
    reportAnswersForUnbookedListings(
      [entryFor(3)],
      [undefined, { "12": [{ q: 3, s: 400 }] }],
    );
    expect(errors.calls).toHaveLength(1);
    expect(errors.lastMessage()).toContain("listing 12");
  });

  test("reports a key naming an unbooked listing once, not once per map", () => {
    reportAnswersForUnbookedListings(
      [entryFor(3)],
      [{ "12": [400] }, { "12": [{ q: 3, s: 400 }] }],
    );
    expect(errors.calls).toHaveLength(1);
  });

  test("reports each unbooked listing separately", () => {
    reportAnswersForUnbookedListings(
      [entryFor(3)],
      [{ "12": [400], "13": [401] }, undefined],
    );
    expect(errors.calls).toHaveLength(2);
    expect(errors.contains("listing 12")).toBe(true);
    expect(errors.contains("listing 13")).toBe(true);
  });

  test("stays quiet when every key names a booked listing", () => {
    reportAnswersForUnbookedListings(
      [entryFor(3), entryFor(7)],
      [{ "3": [400] }, { "7": [{ q: 1, s: 2 }] }],
    );
    expect(errors.calls).toHaveLength(0);
  });

  test("stays quiet for a booked listing that carries no answers", () => {
    reportAnswersForUnbookedListings(
      [entryFor(3), entryFor(7), entryFor(9)],
      [{ "3": [400] }, undefined],
    );
    expect(errors.calls).toHaveLength(0);
  });

  test("stays quiet when one key matches several booked rows", () => {
    reportAnswersForUnbookedListings(
      [entryFor(3), entryFor(3)],
      [{ "3": [400] }, undefined],
    );
    expect(errors.calls).toHaveLength(0);
  });

  test("stays quiet when the order carried no answer maps", () => {
    reportAnswersForUnbookedListings([entryFor(3)], [undefined, undefined]);
    expect(errors.calls).toHaveLength(0);
  });

  test("reports every key when the order booked nothing", () => {
    reportAnswersForUnbookedListings([], [{ "3": [400] }, undefined]);
    expect(errors.calls).toHaveLength(1);
    expect(errors.lastMessage()).toContain("listing 3");
  });

  test("matches a key against the booked listing id written as a string", () => {
    reportAnswersForUnbookedListings([entryFor(12)], [{ "12": [400] }, undefined]);
    expect(errors.calls).toHaveLength(0);
  });

  test("names the unbooked listing in the logged listing id", () => {
    reportAnswersForUnbookedListings([entryFor(3)], [{ "12": [400] }, undefined]);
    expect(errors.lastMessage()).toContain("listing=12");
  });
});
