/**
 * Table definitions for custom questions, answers, and their listing links.
 */

import { decrypt, encrypt } from "#shared/crypto/encryption.ts";
import type {
  Answer,
  ListingQuestion,
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

type ListingQuestionInput = {
  listingId: number;
  questionId: number;
  sortOrder: number;
};

export const listingQuestionsTable = defineTable<
  ListingQuestion,
  ListingQuestionInput
>({
  name: "listing_questions",
  primaryKey: "id",
  schema: {
    id: col.generated<number>(),
    listing_id: col.simple<number>(),
    ...questionIdAndSortOrder,
  },
});
