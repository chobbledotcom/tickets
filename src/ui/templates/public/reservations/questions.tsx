/** Custom question rendering for the booking form. A question control is emitted
 * for each answerable question, with the buyer's submitted value restored on a
 * validation re-render. */

/* jscpd:ignore-start */
import { t } from "#i18n";
import type { QuestionWithAnswers } from "#shared/db/question-types.ts";
import type { QuestionListingMap } from "#shared/db/questions/queries.ts";
import { savedFormValue } from "#shared/forms.tsx";
import {
  questionFieldset,
  questionSelectField,
  questionTextField,
} from "#templates/components/question-text.tsx";
/* jscpd:ignore-end */

/** Render one question control. `required` is the HTML constraint: page listings
 * emit required controls; folded child questions render non-required (the server
 * enforces requiredness only for the selected child). `listingIds`
 * (when present) lets the visibility script show/hide.
 *
 * Question text may contain markdown. When the markdown is simple (plain text in
 * a single paragraph) it is embedded directly inside the `<label>`/`<legend>` so
 * the label-click-focuses-control feature works. When complex it is rendered as
 * a `<div class="prose">` before the control, and the wrapping element becomes a
 * `<div>` (or the legend is dropped) so the long prose isn't trapped inside a
 * label. */
export const renderQuestion = (
  q: QuestionWithAnswers,
  required: boolean,
  listingIds?: string,
): JSX.Element => {
  const answered = savedFormValue(`question_${q.id}`);
  const options = q.answers.filter((a) => a.active);
  if (q.display_type === "free_text") {
    return questionTextField(q, listingIds, answered, required);
  }
  if (q.display_type === "select") {
    return questionSelectField(q, listingIds, {
      isChosen: (id) => answered === String(id),
      options,
      placeholder: t("public.ticket.select_answer_placeholder"),
      required,
    });
  }
  return questionFieldset(
    q,
    listingIds,
    options.map((a) => (
      <label>
        <input
          checked={answered === String(a.id)}
          name={`question_${q.id}`}
          required={required}
          type="radio"
          value={String(a.id)}
        />{" "}
        {a.text}
      </label>
    )),
  );
};

/** A choice question whose answers are all deactivated has nothing selectable, so
 * drop it rather than render a required control a buyer can't satisfy (the parser
 * likewise treats it as not applicable). */
export const answerableQuestion = (q: QuestionWithAnswers): boolean =>
  q.display_type === "free_text" || q.answers.some((a) => a.active);

/** Render the custom question fields. A `questionListingMap` adds data-listing-ids
 * so JS can show/hide questions based on selected listing quantities. */
export const renderQuestions = (
  questions: QuestionWithAnswers[],
  questionListingMap?: QuestionListingMap,
): JSX.Element => (
  <>
    {questions
      .filter(answerableQuestion)
      .map((q) =>
        renderQuestion(q, true, questionListingMap?.get(q.id)?.join(" ")),
      )}
  </>
);
