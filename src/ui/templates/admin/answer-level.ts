import type { QuestionAnswerLevel } from "#db/question-types.ts";
import { t } from "#i18n";

const ANSWER_LEVEL_LABELS: Record<QuestionAnswerLevel, () => string> = {
  booking: () => t("questions.answer_level.booking"),
  listing: () => t("questions.answer_level.listing"),
  quantity: () => t("questions.answer_level.quantity"),
};

/** How often a question asks, in the words the admin pages use. */
export const answerLevelLabel = (level: QuestionAnswerLevel) =>
  ANSWER_LEVEL_LABELS[level]();
