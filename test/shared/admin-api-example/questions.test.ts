import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { QUESTION_ENDPOINTS } from "#shared/admin-api-example/questions.ts";
import { documentedBodies, documentedRoutes } from "./helpers.ts";

const QUESTIONS = "/api/admin/questions";
const ONE_QUESTION = `${QUESTIONS}/:questionId`;
const ANSWERS = `${ONE_QUESTION}/answers`;
const ONE_ANSWER = `${ANSWERS}/:answerId`;

const bodiesOf = documentedBodies(QUESTION_ENDPOINTS);

/** One stored answer of the example question. */
const answer = (
  id: number,
  sortOrder: number,
  text: string,
  timesSelected: number,
) => ({
  active: true,
  id,
  question_id: 9,
  sort_order: sortOrder,
  text,
  times_selected: timesSelected,
});

const SMALL = answer(21, 0, "Small", 4);
const LARGE = answer(22, 1, "Large", 2);

const QUESTION = {
  answers: [SMALL, LARGE],
  assign_all: false,
  display_type: "radio",
  id: 9,
  text: "What is your T-shirt size?",
};

/** One booking that answered the example question. */
const booking = (
  [answerId, answerText]: [number, string],
  attendeeId: number,
  created: string,
  listingIds: number[],
) => ({
  answer_id: answerId,
  answer_text: answerText,
  attendee_id: attendeeId,
  created,
  free_text: null,
  listing_ids: listingIds,
  question_id: 9,
});

describe("documented question endpoints", () => {
  test("every question route and every answer route is documented in order", () => {
    expect(documentedRoutes(QUESTION_ENDPOINTS)).toEqual([
      `GET ${QUESTIONS}`,
      `GET ${ONE_QUESTION}`,
      `POST ${QUESTIONS}`,
      `PUT ${ONE_QUESTION}`,
      `DELETE ${ONE_QUESTION}`,
      `GET ${ONE_QUESTION}/bookings`,
      `POST ${ANSWERS}`,
      `PUT ${ONE_ANSWER}`,
      `DELETE ${ONE_ANSWER}`,
    ]);
  });

  test("every route says what it does, and names the owner as its only caller", () => {
    const vague = QUESTION_ENDPOINTS.filter(
      ({ description }) => !description.includes("(owner only"),
    );

    expect(vague).toEqual([]);
  });

  test("the question reads answer with the example question", () => {
    expect(bodiesOf("GET", QUESTIONS).response).toEqual({
      questions: [QUESTION],
    });
    expect(bodiesOf("GET", ONE_QUESTION).response).toEqual({
      question: QUESTION,
    });
  });

  test("a question create, update, and delete carry the documented bodies", () => {
    const created = {
      assign_all: false,
      display_type: "radio",
      text: "What is your T-shirt size?",
    };
    const renamed = { text: "Which T-shirt size do you wear?" };

    expect(bodiesOf("POST", QUESTIONS)).toEqual({
      request: created,
      response: { question: { ...QUESTION, answers: [] } },
    });
    expect(bodiesOf("PUT", ONE_QUESTION)).toEqual({
      request: renamed,
      response: { question: { ...QUESTION, ...renamed } },
    });
    expect(bodiesOf("DELETE", ONE_QUESTION).request).toEqual({
      confirm_identifier: "What is your T-shirt size?",
    });
  });

  test("the bookings read shows two bookings, newest first", () => {
    expect(bodiesOf("GET", `${ONE_QUESTION}/bookings`).response).toEqual({
      bookings: [
        booking([21, "Small"], 7, "2026-06-01T09:00:00.000Z", [4]),
        booking([22, "Large"], 12, "2026-05-28T16:30:00.000Z", [4, 6]),
      ],
    });
  });

  test("an answer add, rename, and delete carry the documented bodies", () => {
    expect(bodiesOf("POST", ANSWERS)).toEqual({
      request: { text: "Medium" },
      response: {
        question: {
          ...QUESTION,
          answers: [SMALL, LARGE, answer(23, 2, "Medium", 0)],
        },
      },
    });
    expect(bodiesOf("PUT", ONE_ANSWER)).toEqual({
      request: { text: "Extra large" },
      response: {
        question: {
          ...QUESTION,
          answers: [SMALL, { ...LARGE, text: "Extra large" }],
        },
      },
    });
    expect(bodiesOf("DELETE", ONE_ANSWER).request).toEqual({
      confirm_identifier: "Large",
    });
  });
});
