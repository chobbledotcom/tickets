/**
 * The questions resource's doc entries: the five standard question endpoints
 * and the three answer writes under a question. The paths come from the
 * resource table, so the docs cannot disagree with the server about them.
 */

import {
  ADMIN_API_RESOURCES,
  type AdminApiCreateQuestionBody,
  type AdminApiUpdateQuestionBody,
} from "#shared/admin-api-resources.ts";
import type { DeleteBody } from "#shared/rest/crud-parsers.ts";
import {
  choiceWriteDocs,
  crudDocs,
  type EndpointDoc,
  json,
} from "./endpoint-doc.ts";

/** Example question response: the question and its answers in display order,
 *  each answer with its stored selection total. */
const ADMIN_API_EXAMPLE_QUESTION = {
  answer_level: "booking",
  answers: [
    {
      active: true,
      id: 21,
      question_id: 9,
      sort_order: 0,
      text: "Small",
      times_selected: 4,
    },
    {
      active: true,
      id: 22,
      question_id: 9,
      sort_order: 1,
      text: "Large",
      times_selected: 2,
    },
  ],
  assign_all: false,
  display_type: "radio",
  id: 9,
  text: "What is your T-shirt size?",
};

const ADMIN_API_QUESTION_CREATE_BODY = {
  answer_level: "booking",
  assign_all: false,
  display_type: "radio",
  text: "What is your T-shirt size?",
} satisfies AdminApiCreateQuestionBody;

const ADMIN_API_QUESTION_UPDATE_BODY = {
  text: "Which T-shirt size do you wear?",
} satisfies AdminApiUpdateQuestionBody;

const ADMIN_API_QUESTION_DELETE_BODY = {
  confirm_identifier: "What is your T-shirt size?",
} satisfies DeleteBody;

/** The documented base path of the question routes. */
const QUESTIONS_BASE = `/api/admin/${ADMIN_API_RESOURCES.questions.path}`;

/** Example answer to the bookings read: two bookings that gave a choice
 *  answer to the example question. */
const ADMIN_API_EXAMPLE_QUESTION_BOOKINGS = {
  bookings: [
    {
      answer_id: 21,
      answer_text: "Small",
      attendee_id: 7,
      created: "2026-06-01T09:00:00.000Z",
      free_text: null,
      listing_ids: [4],
      question_id: 9,
    },
    {
      answer_id: 22,
      answer_text: "Large",
      attendee_id: 12,
      created: "2026-05-28T16:30:00.000Z",
      free_text: null,
      listing_ids: [4, 6],
      question_id: 9,
    },
  ],
};

export const QUESTION_ENDPOINTS: EndpointDoc[] = [
  ...crudDocs({
    createBody: ADMIN_API_QUESTION_CREATE_BODY,
    deleteBody: ADMIN_API_QUESTION_DELETE_BODY,
    desc: [
      "List all questions with their answers and each answer's selection total (owner only)",
      "Get a single question by ID, with its answers and their selection totals (owner only)",
      "Create a question (owner only)",
      "Update a question (owner only, all fields optional)",
      "Delete a question (owner only, requires the question text as confirmation)",
    ],
    entry: ADMIN_API_RESOURCES.questions,
    example: ADMIN_API_EXAMPLE_QUESTION,
    // A brand-new question has no answers yet, whatever the example record
    // shows for the get/list answers.
    newRecordDefaults: { answers: [] },
    updateBody: ADMIN_API_QUESTION_UPDATE_BODY,
  }),
  {
    description:
      "List the bookings that answered a question, newest booking first (owner only). A row names the booking, the listings it holds, and the answer it gave.",
    method: "GET",
    path: `${QUESTIONS_BASE}/:questionId/bookings`,
    response: json(ADMIN_API_EXAMPLE_QUESTION_BOOKINGS),
  },
  ...choiceWriteDocs([ADMIN_API_RESOURCES.questions, "answers"], {
    added: {
      active: true,
      id: 23,
      question_id: 9,
      sort_order: 2,
      text: "Medium",
      times_selected: 0,
    },
    desc: [
      "Add an answer to a question (owner only). The answer joins the question's answer list, new answer last. A free-text question refuses answers, because it collects a typed value instead.",
      "Rename a question answer (owner only). The answer shows in the question's answer list.",
      "Delete a question answer (owner only, requires the answer text as confirmation).",
    ],
    record: ADMIN_API_EXAMPLE_QUESTION,
    rename: ["Large", "Extra large"],
  }),
];
