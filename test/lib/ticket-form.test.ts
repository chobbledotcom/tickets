import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import {
  buildListingAnswerMap,
  buildListingTextAnswerMap,
  groupListingAnswerSets,
  parseAddOnSelections,
  parseQuantities,
} from "#routes/public/ticket-form.ts";
import type { AddOnOption } from "#shared/db/modifier-resolve.ts";
import type { QuestionWithAnswers } from "#shared/db/questions.ts";
import { FormParams } from "#shared/form-data.ts";
import type { TicketListing } from "#templates/public.tsx";

const question = (
  id: number,
  display_type: QuestionWithAnswers["display_type"],
): QuestionWithAnswers => ({
  answers:
    display_type === "free_text"
      ? []
      : [
          {
            active: true,
            id: id * 10,
            question_id: id,
            sort_order: 0,
            text: "Answer",
          },
        ],
  display_type,
  id,
  text: `Question ${id}`,
});

describe("ticket form answer grouping", () => {
  test("saves free-text-only submissions for the matching listing attendee", () => {
    const selectedListingIds = new Set([101]);
    const textMap = buildListingTextAnswerMap(
      [{ questionId: 1, text: "Front row please" }],
      new Map([[1, [101]]]),
      selectedListingIds,
    );

    const grouped = groupListingAnswerSets(
      [{ attendee: { id: 501 }, listing: { id: 101 } }],
      {},
      textMap,
    );

    expect(grouped.get(501)).toEqual({
      answerIds: [],
      textAnswers: [{ questionId: 1, text: "Front row please" }],
    });
  });

  test("scopes text and choice answers to the listings that ask each question", () => {
    const selectedListingIds = new Set([101, 202]);
    const questionListingMap = new Map([
      [1, [101]],
      [2, [202]],
    ]);
    const choiceMap = buildListingAnswerMap(
      [question(1, "radio"), question(2, "free_text")],
      [10],
      questionListingMap,
      selectedListingIds,
    );
    const textMap = buildListingTextAnswerMap(
      [{ questionId: 2, text: "Vegan" }],
      questionListingMap,
      selectedListingIds,
    );

    const grouped = groupListingAnswerSets(
      [
        { attendee: { id: 501 }, listing: { id: 101 } },
        { attendee: { id: 902 }, listing: { id: 202 } },
      ],
      choiceMap,
      textMap,
    );

    expect(grouped.get(501)).toEqual({ answerIds: [10] });
    expect(grouped.get(902)).toEqual({
      answerIds: [],
      textAnswers: [{ questionId: 2, text: "Vegan" }],
    });
  });

  test("accumulates multiple choice answers on one listing, in question order", () => {
    // Two active radio questions both assigned to listing 101. The parser yields
    // one submitted answer id per active choice question, in question order; both
    // must land in 101's bucket — the second must not overwrite the first (the
    // per-listing bucket is created once, then appended), and the answer index
    // must advance so each question reads its own submitted id.
    const choiceMap = buildListingAnswerMap(
      [question(1, "radio"), question(2, "radio")],
      [11, 22],
      new Map([
        [1, [101]],
        [2, [101]],
      ]),
      new Set([101]),
    );
    expect(choiceMap).toEqual({ "101": [11, 22] });
  });

  test("skips an inactive-only choice question so answer ids stay aligned", () => {
    const inactiveOnly: QuestionWithAnswers = {
      answers: [
        { active: false, id: 10, question_id: 1, sort_order: 0, text: "Gone" },
      ],
      display_type: "radio",
      id: 1,
      text: "Q1",
    };
    // The parser skips the inactive-only question, so answerIds holds only the
    // active question's answer (20). The map must put it on Q2's listing (202),
    // not consume the slot for the skipped Q1 (101).
    const choiceMap = buildListingAnswerMap(
      [inactiveOnly, question(2, "radio")],
      [20],
      new Map([
        [1, [101]],
        [2, [202]],
      ]),
      new Set([101, 202]),
    );

    expect(choiceMap).toEqual({ "202": [20] });
  });

  test("applies an assign-all question (absent from the map) to every selected listing", () => {
    const selectedListingIds = new Set([101, 202]);

    // An empty map means the question is assigned to no listing in particular,
    // so it applies to every selected listing.
    const textMap = buildListingTextAnswerMap(
      [{ questionId: 1, text: "Window seat" }],
      new Map(),
      selectedListingIds,
    );

    expect(textMap).toEqual({
      "101": [{ questionId: 1, text: "Window seat" }],
      "202": [{ questionId: 1, text: "Window seat" }],
    });
  });

  test("deduplicates assign-all text answers by question for one attendee", () => {
    const selectedListingIds = new Set([101, 202]);
    const textMap = buildListingTextAnswerMap(
      [{ questionId: 1, text: "Window seat" }],
      new Map(),
      selectedListingIds,
    );

    const grouped = groupListingAnswerSets(
      [
        { attendee: { id: 501 }, listing: { id: 101 } },
        { attendee: { id: 501 }, listing: { id: 202 } },
      ],
      {},
      textMap,
    );

    expect(grouped.get(501)).toEqual({
      answerIds: [],
      textAnswers: [{ questionId: 1, text: "Window seat" }],
    });
  });

  test("skips an attendee whose listing collected no answers", () => {
    const grouped = groupListingAnswerSets(
      [
        { attendee: { id: 501 }, listing: { id: 101 } },
        { attendee: { id: 902 }, listing: { id: 202 } },
      ],
      { "101": [10] },
      {},
    );

    expect(grouped.get(501)).toEqual({ answerIds: [10] });
    // Listing 202 asked nothing, so its attendee is left out entirely.
    expect(grouped.has(902)).toBe(false);
  });
});

describe("parseAddOnSelections", () => {
  const addOn = (id: number, maxQuantity: number): AddOnOption => ({
    id,
    maxQuantity,
    name: `Add-on ${id}`,
    priceLabel: "+£5",
    requiresPayment: false,
  });
  const form = (record: Record<string, string>): FormParams =>
    new FormParams(new URLSearchParams(record));

  test("reads each selected add-on's quantity, clamped to its ceiling", () => {
    const result = parseAddOnSelections(form({ addon_5: "2", addon_6: "99" }), [
      addOn(5, 10),
      addOn(6, 3),
    ]);
    expect(result).toEqual(
      new Map([
        [5, 2],
        [6, 3],
      ]),
    );
  });

  test("drops zero, missing, and not-offered add-ons", () => {
    // 5 is selected zero, 6 is offered but absent from the form, and addon_7 has
    // a value but isn't an offered add-on — none of them produce a selection.
    const result = parseAddOnSelections(form({ addon_5: "0", addon_7: "4" }), [
      addOn(5, 10),
      addOn(6, 10),
    ]);
    expect(result).toEqual(new Map());
  });
});

describe("parseQuantities", () => {
  // Cast a minimal cart line — parseQuantities only reads these four fields, and
  // we deliberately set maxPurchasable > 0 on the unbookable lines (which
  // buildTicketListing would force to 0) to prove the skip stands on its own.
  const tl = (
    id: number,
    over: { isSoldOut?: boolean; isClosed?: boolean; maxPurchasable?: number },
  ): TicketListing =>
    ({
      isClosed: false,
      isSoldOut: false,
      listing: { id },
      maxPurchasable: 10,
      ...over,
    }) as unknown as TicketListing;

  test("skips sold-out and closed listings even when they report capacity", () => {
    // The guard skips a listing that is sold out OR closed — it must never be
    // relaxed to require both, or an unbookable listing with stale capacity would
    // book.
    const form = new FormParams(
      new URLSearchParams({
        quantity_1: "3",
        quantity_2: "4",
        quantity_3: "2",
      }),
    );
    const result = parseQuantities(form, [
      tl(1, { isClosed: true, maxPurchasable: 5 }),
      tl(2, { isSoldOut: true, maxPurchasable: 5 }),
      tl(3, { maxPurchasable: 5 }),
    ]);
    expect(result).toEqual(new Map([[3, 2]]));
  });
});
