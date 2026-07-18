/**
 * Table definitions for custom questions and their answers. The
 * `listing_questions` link table is declared in `questions/queries.ts`, beside
 * the membership joins that consume it.
 */

import { decrypt, encrypt } from "#shared/crypto/encryption.ts";
import { defineOrderedCollection } from "#shared/db/ordered-collection.ts";
import type {
  Answer,
  Question,
  QuestionDisplayType,
} from "#shared/db/question-types.ts";
import { col, defineTable } from "#shared/db/table.ts";

/** Shared column defs for tables with an encrypted text column */
const generatedId = col.generated<number>();
const encryptedText = col.encrypted(encrypt, decrypt);
const questionIdAndSortOrder = {
  question_id: col.simple<number>(),
  sort_order: col.simple<number>(),
};

type QuestionInput = {
  assignAll?: boolean;
  displayType: QuestionDisplayType;
  text: string;
};

// `questions` has a `sort_order` column in the schema (the global question
// order the booking form and admin list render), but it is deliberately absent
// from `questionsTable`'s `schema` here: writes to `sort_order` are managed
// through the shared ordered-row helpers and reads
// consume it via raw `ORDER BY question.sort_order` clauses in
// `questions/queries.ts`, never through `questionsTable.fromDb`. Keeping it out
// of the `defineTable` schema stops accidental writes through the generic
// insert/update path that would bypass the swap helpers' ordering invariants.
export const questionsTable = defineTable<Question, QuestionInput>({
  name: "questions",
  primaryKey: "id",
  schema: {
    assign_all: col.boolean(false),
    display_type: col.simple<QuestionDisplayType>(),
    id: generatedId,
    text: encryptedText,
  },
});

type AnswerInput = {
  questionId: number;
  text: string;
  sortOrder: number;
  active?: boolean;
};

export const answersTable = defineTable<Answer, AnswerInput>({
  name: "answers",
  primaryKey: "id",
  schema: {
    active: col.boolean(true),
    id: generatedId,
    ...questionIdAndSortOrder,
    text: encryptedText,
  },
});

export const questionsOrder = defineOrderedCollection({
  key: "id",
  start: 1,
  table: "questions",
});

export const answersOrder = defineOrderedCollection({
  key: "id",
  scope: "question_id",
  table: "answers",
});
