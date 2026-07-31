/**
 * The two question/answer form definitions, in their own leaf module so the
 * route modules and the page template can all import them without a cycle.
 */

import {
  QUESTION_DISPLAY_TYPES,
  questionDisplayTypeError,
} from "#shared/db/question-types.ts";
import { defineForm, defineTextForm } from "#shared/forms/definition.ts";
import { requireChoiceOptions } from "#shared/forms/field.ts";
import { MAX_TEXTAREA_LENGTH } from "#shared/limits.ts";
import { formattingHint } from "#templates/components/formatting-hint.ts";

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
      name: "display_type",
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
  ] as const,
});

export const answerTextForm = defineTextForm(
  "Answer text",
  "text",
  "e.g. Medium",
);
