/**
 * The questions resource's doc entries: the five standard question endpoints
 * and the three answer writes under a question. The paths come from the
 * resource table, so the docs cannot disagree with the server about them.
 */

// jscpd:ignore-start
import {
  ADMIN_API_RESOURCES,
  type AdminApiCreateQuestionBody,
  type AdminApiOptionBody,
  type AdminApiUpdateQuestionBody,
} from "#shared/admin-api-resources.ts";
import type { DeleteBody } from "#shared/rest/crud-parsers.ts";
import {
  childDocBase,
  crudDocs,
  type EndpointDoc,
  json,
  renameOneText,
} from "./endpoint-doc.ts";

// jscpd:ignore-end

/** Example question response: the question and its answers in display
 *  order. */
const ADMIN_API_EXAMPLE_QUESTION = {
  answers: [
    { active: true, id: 21, question_id: 9, sort_order: 0, text: "Small" },
    { active: true, id: 22, question_id: 9, sort_order: 1, text: "Large" },
  ],
  assign_all: false,
  display_type: "radio",
  id: 9,
  text: "What is your T-shirt size?",
};

const ADMIN_API_QUESTION_CREATE_BODY = {
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

const ADMIN_API_QUESTION_ANSWER_CREATE_BODY = {
  text: "Medium",
} satisfies AdminApiOptionBody;

const ADMIN_API_QUESTION_ANSWER_UPDATE_BODY = {
  text: "Extra large",
} satisfies AdminApiOptionBody;

const ADMIN_API_QUESTION_ANSWER_DELETE_BODY = {
  confirm_identifier: "Large",
} satisfies DeleteBody;

/** The answer to an answer add: the question's own fields are untouched, so
 *  the example must not read like the request also renamed the question. */
const ADMIN_API_EXAMPLE_QUESTION_WITH_MEDIUM = {
  ...ADMIN_API_EXAMPLE_QUESTION,
  answers: [
    ...ADMIN_API_EXAMPLE_QUESTION.answers,
    { active: true, id: 23, question_id: 9, sort_order: 2, text: "Medium" },
  ],
};

/** The answer to an answer rename: the question's own fields are untouched. */
const ADMIN_API_EXAMPLE_ANSWER_RENAMED = {
  ...ADMIN_API_EXAMPLE_QUESTION,
  answers: renameOneText(
    ADMIN_API_EXAMPLE_QUESTION.answers,
    "Large",
    "Extra large",
  ),
};

/** The documented path of one answer write route: the parent's id param and
 *  the child segment both come from the resource table. */
const questionAnswerBase = (): string =>
  childDocBase(ADMIN_API_RESOURCES.questions, "answers");

export const QUESTION_ENDPOINTS: EndpointDoc[] = [
  ...crudDocs({
    createBody: ADMIN_API_QUESTION_CREATE_BODY,
    deleteBody: ADMIN_API_QUESTION_DELETE_BODY,
    desc: [
      "List all questions with their answers (owner only)",
      "Get a single question by ID (owner only)",
      "Create a question (owner only)",
      "Update a question (owner only, all fields optional)",
      "Delete a question (owner only, requires the question text as confirmation)",
    ],
    entry: ADMIN_API_RESOURCES.questions,
    example: ADMIN_API_EXAMPLE_QUESTION,
    listResponse: { questions: [ADMIN_API_EXAMPLE_QUESTION] },
    // A brand-new question has no answers yet, whatever the example record
    // shows for the get/list answers.
    newRecordDefaults: { answers: [] },
    singular: "question",
    updateBody: ADMIN_API_QUESTION_UPDATE_BODY,
  }),
  {
    description:
      "Add an answer to a question (owner only). The answer joins the question's answer list, new answer last. A free-text question refuses answers, because it collects a typed value instead.",
    method: "POST",
    path: questionAnswerBase(),
    request: json(ADMIN_API_QUESTION_ANSWER_CREATE_BODY),
    response: json({ question: ADMIN_API_EXAMPLE_QUESTION_WITH_MEDIUM }),
  },
  {
    description:
      "Rename a question answer (owner only). The answer shows in the question's answer list.",
    method: "PUT",
    path: `${questionAnswerBase()}/:answerId`,
    request: json(ADMIN_API_QUESTION_ANSWER_UPDATE_BODY),
    response: json({ question: ADMIN_API_EXAMPLE_ANSWER_RENAMED }),
  },
  {
    description:
      "Delete a question answer (owner only, requires the answer text as confirmation).",
    method: "DELETE",
    path: `${questionAnswerBase()}/:answerId`,
    request: json(ADMIN_API_QUESTION_ANSWER_DELETE_BODY),
    response: json({ status: "ok" }),
  },
];
