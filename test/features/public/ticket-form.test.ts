import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import type { TicketListing } from "#booking/model.ts";
import type { AddOnOption } from "#db/modifier-resolve.ts";
import type { QuestionWithAnswers } from "#db/question-types.ts";
import { groupListingAnswerSets } from "#db/questions/attendee-answers/save.ts";
import {
  type AnswerInfo,
  listingAnswerMaps,
  listingsWithQuantity,
  parseAddOnSelections,
  parseQuantities,
  parseQuantityValue,
  resolvePageDate,
  ticketFormErrorResponse,
  ticketResponse,
} from "#routes/public/ticket-form.ts";
import { FormParams } from "#shared/form-data.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";
import { ticketContext } from "#test-utils/ticket-ctx.ts";

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

/** An AnswerInfo with everything empty except the given fields. */
const answerInfo = (over: Partial<AnswerInfo>): AnswerInfo => ({
  activeQuestions: [],
  answerIds: [],
  selectedListingIds: new Set(),
  textAnswers: [],
  ...over,
});

/** Text map for a "Window seat" assign-all question (empty question→listing
 * map) applied across selected listings 101 and 202. */
const windowSeatAssignAllTextMap = () =>
  listingAnswerMaps(
    answerInfo({
      selectedListingIds: new Set([101, 202]),
      textAnswers: [{ questionId: 1, text: "Window seat" }],
    }),
    new Map(),
  ).textAnswers;

describe("ticket form answer grouping", () => {
  test("saves free-text-only submissions for the matching listing attendee", () => {
    const selectedListingIds = new Set([101]);
    const textMap = listingAnswerMaps(
      answerInfo({
        selectedListingIds,
        textAnswers: [{ questionId: 1, text: "Front row please" }],
      }),
      new Map([[1, [101]]]),
    ).textAnswers;

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
    const { answerIds: choiceMap, textAnswers: textMap } = listingAnswerMaps(
      answerInfo({
        activeQuestions: [question(1, "radio"), question(2, "free_text")],
        answerIds: [10],
        selectedListingIds,
        textAnswers: [{ questionId: 2, text: "Vegan" }],
      }),
      questionListingMap,
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
    const choiceMap = listingAnswerMaps(
      answerInfo({
        activeQuestions: [question(1, "radio"), question(2, "radio")],
        answerIds: [11, 22],
        selectedListingIds: new Set([101]),
      }),
      new Map([
        [1, [101]],
        [2, [101]],
      ]),
    ).answerIds;
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
    const choiceMap = listingAnswerMaps(
      answerInfo({
        activeQuestions: [inactiveOnly, question(2, "radio")],
        answerIds: [20],
        selectedListingIds: new Set([101, 202]),
      }),
      new Map([
        [1, [101]],
        [2, [202]],
      ]),
    ).answerIds;

    expect(choiceMap).toEqual({ "202": [20] });
  });

  test("applies an assign-all question (absent from the map) to every selected listing", () => {
    // An empty map means the question is assigned to no listing in particular,
    // so it applies to every selected listing.
    const textMap = windowSeatAssignAllTextMap();

    expect(textMap).toEqual({
      "101": [{ questionId: 1, text: "Window seat" }],
      "202": [{ questionId: 1, text: "Window seat" }],
    });
  });

  test("deduplicates assign-all text answers by question for one attendee", () => {
    const textMap = windowSeatAssignAllTextMap();

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

  test("leaves out a listing whose box is absent or carries no number", () => {
    // An absent or cleared box must read as zero tickets, never one.
    const form = new FormParams(new URLSearchParams({ quantity_2: "abc" }));
    expect(parseQuantities(form, [tl(1, {}), tl(2, {})])).toEqual(new Map());
  });
});

describe("parseQuantityValue", () => {
  test("lifts a too-small count to one and clamps a too-large count at the max", () => {
    expect(parseQuantityValue("0", 5)).toBe(1);
    expect(parseQuantityValue("", 5)).toBe(1);
    expect(parseQuantityValue("3", 5)).toBe(3);
    expect(parseQuantityValue("9", 5)).toBe(5);
  });
});

describe("listingsWithQuantity", () => {
  const tl = (id: number): TicketListing =>
    ({
      isClosed: false,
      isSoldOut: false,
      listing: { id },
      maxPurchasable: 10,
    }) as unknown as TicketListing;

  test("keeps only the listings the buyer chose tickets for", () => {
    const chosen = tl(1);
    const declined = tl(2);
    expect(
      listingsWithQuantity(
        [chosen, declined],
        new Map([
          [1, 2],
          [2, 0],
        ]),
      ),
    ).toEqual([{ listing: { id: 1 }, qty: 2 }]);
  });

  test("reads a listing the quantities map omits as zero", () => {
    expect(listingsWithQuantity([tl(1)], new Map())).toEqual([]);
  });
});

describe("resolvePageDate", () => {
  test("a dateless page has no date to choose", () => {
    expect(resolvePageDate([], null)).toEqual({ date: null, ok: true });
  });

  test("keeps a submitted date the page offers", () => {
    expect(resolvePageDate(["2026-05-01", "2026-05-02"], "2026-05-02")).toEqual(
      { date: "2026-05-02", ok: true },
    );
  });

  test("refuses a page with dates when nothing was submitted", () => {
    // One offered date: a length check off by one would treat this as chosen.
    expect(resolvePageDate(["2026-05-01"], null)).toEqual({
      error: "Please select a valid date",
      ok: false,
    });
  });

  test("refuses a submitted date the page does not offer", () => {
    expect(resolvePageDate(["2026-05-01"], "2026-05-09")).toEqual({
      error: "Please select a valid date",
      ok: false,
    });
  });
});

describeWithEnv("ticket responses", { db: true }, () => {
  test("answers with the rendered page at 200 by default", async () => {
    const listing = await createTestListing({ maxAttendees: 5 });
    const ctx = await ticketContext([listing.id]);

    const response = ticketResponse(ctx)();
    expect(response.status).toBe(200);
    expect(await response.text()).toContain(listing.name);
  });

  test("carries the error and status it is given", async () => {
    const listing = await createTestListing({ maxAttendees: 5 });
    const ctx = await ticketContext([listing.id]);

    const response = ticketResponse(ctx)("No room", 400);
    expect(response.status).toBe(400);
    expect(await response.text()).toContain("No room");
  });

  test("redirects a form error back to the page the form lives on", async () => {
    const listing = await createTestListing({ maxAttendees: 5 });
    const ctx = await ticketContext([listing.id]);

    const response = ticketFormErrorResponse(ctx)("Pick one");
    expect(response.headers.get("Location")).toContain(
      `/ticket/${listing.slug}`,
    );
  });
});
