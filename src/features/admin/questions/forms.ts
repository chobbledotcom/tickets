/**
 * The two question/answer form definitions, in their own leaf module so the
 * route modules and the page template can all import them without a cycle.
 */

import {
  QUESTION_ANSWER_LEVELS,
  QUESTION_DISPLAY_TYPES,
  type QuestionAnswerLevel,
  questionAnswerLevelError,
  questionDisplayTypeError,
} from "#db/question-types.ts";
import { defineForm, defineTextForm } from "#shared/forms/definition.ts";
import { requireChoiceOptions } from "#shared/forms/field.ts";
import { MAX_TEXTAREA_LENGTH } from "#shared/limits.ts";
import { formattingHint } from "#templates/components/formatting-hint.ts";

/** The words of the add form's Ask choices. The form is built when the module
 * loads, before any language scope exists, so these are not catalog keys. */
const ANSWER_LEVEL_FORM_LABELS: Record<QuestionAnswerLevel, string> = {
  booking: "One per booking",
  listing: "One per listing",
  quantity: "One per ticket",
};

export const questionTextForm = defineForm({
  fields: [
    {
      hintHtml: `Shown to attendees above the answer field. ${formattingHint()}`,
      label: "Question text",
      markdown: true,
      maxlength: MAX_TEXTAREA_LENGTH,
      name: "text",
      placeholder: "e.g. What is your T-shirt size?",
      required: true,
      type: "textarea",
    },
    {
      invalidMessage: questionDisplayTypeError,
      label: "Display as",
      name: "displayType",
      options: requireChoiceOptions(
        "Display as",
        QUESTION_DISPLAY_TYPES.map((value) => ({
          label:
            value === "radio"
              ? "Radio buttons"
              : value === "select"
                ? "Select box"
                : "Free text",
          value,
        })),
      ),
      required: true,
      type: "select",
    },
    {
      hintHtml:
        "Only a free-text question can ask once for each listing. You cannot change this after you add the question.",
      invalidMessage: questionAnswerLevelError,
      label: "Ask",
      name: "answerLevel",
      options: requireChoiceOptions(
        "Ask",
        QUESTION_ANSWER_LEVELS.map((value) => ({
          label: ANSWER_LEVEL_FORM_LABELS[value],
          value,
        })),
      ),
      type: "select",
    },
  ] as const,
});

export const answerTextForm = defineTextForm(
  "Answer text",
  "text",
  "e.g. Medium",
);
