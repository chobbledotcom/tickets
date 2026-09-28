import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import {
  type StoredTicketLine,
  spreadTicketMoves,
  ticketCount,
} from "#booking/ticket-moves.ts";

/** One stored line for person 1 on listing 10 unless the test says otherwise. */
const line = (
  id: number,
  quantity: number,
  checkedIn: number,
  extra: Partial<StoredTicketLine> = {},
): StoredTicketLine => ({
  attendee_id: 1,
  checked_in: checkedIn,
  id,
  listing_id: 10,
  quantity,
  ...extra,
});

const move = (count: number) => ({ attendeeId: 1, count, listingId: 10 });

/** The answer one move expects: its count and its pair's post-write owed. */
const answer = (count: number, owedAfter: number) => ({
  ...move(count),
  owedAfter,
});

describe("booking > ticket moves", () => {
  test("admitting fills the first line before the next", () => {
    expect(
      spreadTicketMoves("admit", [line(1, 2, 1), line(2, 3, 0)], [move(3)]),
    ).toEqual({
      changed: [
        { checked_in: 2, id: 1 },
        { checked_in: 2, id: 2 },
      ],
      moved: [answer(3, 1)],
    });
  });

  test("releasing empties the first line before the next", () => {
    expect(
      spreadTicketMoves("release", [line(1, 2, 1), line(2, 3, 3)], [move(2)]),
    ).toEqual({
      changed: [
        { checked_in: 0, id: 1 },
        { checked_in: 2, id: 2 },
      ],
      moved: [answer(2, 3)],
    });
  });
  test("a move answers only what the lines had room for", () => {
    const admitted = spreadTicketMoves("admit", [line(1, 2, 1)], [move(5)]);
    expect(admitted.moved).toEqual([answer(1, 0)]);
    const released = spreadTicketMoves("release", [line(1, 2, 1)], [move(5)]);
    expect(released.moved).toEqual([answer(1, 2)]);
  });

  test("a full line is not changed", () => {
    expect(spreadTicketMoves("admit", [line(1, 2, 2)], [move(1)])).toEqual({
      changed: [],
      moved: [answer(0, 0)],
    });
  });

  test("two moves on the same lines see each other's tickets", () => {
    const { changed, moved } = spreadTicketMoves(
      "admit",
      [line(1, 2, 0), line(2, 2, 0)],
      [move(2), move(2)],
    );
    expect(moved).toEqual([answer(2, 0), answer(2, 0)]);
    expect(changed).toEqual([
      { checked_in: 2, id: 1 },
      { checked_in: 2, id: 2 },
    ]);
  });

  test("a move touches only its own person and listing", () => {
    const lines = [
      line(1, 2, 0, { attendee_id: 2 }),
      line(2, 2, 0, { listing_id: 11 }),
      line(3, 2, 0),
    ];
    const { changed, moved } = spreadTicketMoves("admit", lines, [move(1)]);
    expect(moved).toEqual([answer(1, 1)]);
    expect(changed).toEqual([{ checked_in: 1, id: 3 }]);
  });

  test("a move with no lines answers zero moved and zero owed", () => {
    expect(spreadTicketMoves("admit", [], [move(2)]).moved).toEqual([
      answer(0, 0),
    ]);
  });

  test("a negative count throws instead of writing it", () => {
    expect(() =>
      spreadTicketMoves("admit", [line(1, 2, 0)], [move(-1)]),
    ).toThrow("Invalid ticket count: -1");
  });

  test("a fractional count throws instead of writing it", () => {
    expect(() =>
      spreadTicketMoves("admit", [line(1, 2, 0)], [move(0.5)]),
    ).toThrow("Invalid ticket count: 0.5");
  });

  test("a zero count stays valid and moves nothing", () => {
    const { changed, moved } = spreadTicketMoves(
      "admit",
      [line(1, 2, 0)],
      [move(0)],
    );
    expect(changed).toEqual([]);
    expect(moved).toEqual([answer(0, 2)]);
  });

  test("counts the tickets a set of moves covers", () => {
    expect(ticketCount([move(2), move(0), move(3)])).toBe(5);
  });
});
