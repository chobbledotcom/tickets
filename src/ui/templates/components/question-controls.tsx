/**
 * Shared question controls: the input, dropdown, or radio markup for one
 * custom question. The public booking form and the admin attendee edit form
 * render the same three control shapes; they differ only in what they already
 * know — which answers to offer, which one is chosen, whether the browser
 * should demand an answer — so those differences arrive as data and the
 * markup lives here once.
 */

import type { Answer, QuestionWithAnswers } from "#db/question-types.ts";
import { MAX_TEXTAREA_LENGTH } from "#shared/limits.ts";
import {
  questionFieldset,
  questionWrapper,
} from "#templates/components/question-text.tsx";

/** Everything one question control needs to draw itself filled in. */
export type QuestionControlView = {
  /** The answers to offer for a choice question. */
  options: Answer[];
  /** The saved free-text answer ("" when none). */
  textValue: string;
  /** True when this answer is currently chosen. */
  isChosen: (answerId: number) => boolean;
  /** The dropdown's empty first choice. */
  placeholder: string;
  /** Browser-enforced "must answer" flag (public booking forms only). */
  required?: boolean;
  /** data-listing-ids hook for the public show/hide script. */
  listingIds?: string | undefined;
};

/** Render one question's control — a text input, a dropdown, or radio
 *  buttons, chosen by the question's display type — filled in from `view`. */
export const questionControl = (
  q: QuestionWithAnswers,
  view: QuestionControlView,
): JSX.Element => {
  const name = `question_${q.id}`;
  if (q.display_type === "free_text") {
    return questionWrapper(q, view.listingIds, (labelledBy) => (
      <input
        aria-labelledby={labelledBy}
        maxlength={MAX_TEXTAREA_LENGTH}
        name={name}
        required={view.required}
        type="text"
        value={view.textValue}
      />
    ));
  }
  if (q.display_type === "select") {
    return questionWrapper(q, view.listingIds, (labelledBy) => (
      <select aria-labelledby={labelledBy} name={name} required={view.required}>
        <option value="">{view.placeholder}</option>
        {view.options.map((a) => (
          <option selected={view.isChosen(a.id)} value={String(a.id)}>
            {a.text}
          </option>
        ))}
      </select>
    ));
  }
  return questionFieldset(
    q,
    view.listingIds,
    view.options.map((a) => (
      <label>
        <input
          checked={view.isChosen(a.id)}
          name={name}
          required={view.required}
          type="radio"
          value={String(a.id)}
        />{" "}
        {a.text}
      </label>
    )),
  );
};
