/**
 * Shared question controls: the input, dropdown, or radio markup for one
 * custom question. The public booking form and the admin attendee edit form
 * render the same three control shapes. They differ only in what they already
 * know — which answers to offer, which one is chosen, whether the browser
 * should demand an answer — so those differences arrive as data and the
 * markup lives here once.
 */

import type { ImageUrls } from "#db/images.ts";
import type {
  Answer,
  QuestionDisplayType,
  QuestionWithAnswers,
} from "#db/question-types.ts";
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

/** The control each single-control question type renders inside its label
 * wrapper; radio questions render their controls in a fieldset instead. */
const singleControls: Record<
  Exclude<QuestionDisplayType, "radio">,
  (
    view: QuestionControlView,
    name: string,
  ) => (labelledBy?: string) => JSX.Element
> = {
  free_text: (view, name) => (labelledBy) => (
    <input
      aria-labelledby={labelledBy}
      maxlength={MAX_TEXTAREA_LENGTH}
      name={name}
      required={view.required}
      type="text"
      value={view.textValue}
    />
  ),
  select: (view, name) => (labelledBy) => (
    <select aria-labelledby={labelledBy} name={name} required={view.required}>
      <option value="">{view.placeholder}</option>
      {view.options.map((a) => (
        <option selected={view.isChosen(a.id)} value={String(a.id)}>
          {a.text}
        </option>
      ))}
    </select>
  ),
};

/** Render one question's control — a text input, a dropdown, or radio
 *  buttons, chosen by the question's display type — filled in from `view`. */
export const questionControl = (
  q: QuestionWithAnswers,
  view: QuestionControlView,
  imageUrls?: ImageUrls,
): JSX.Element => {
  const name = `question_${q.id}`;
  const wrapArgs = { imageUrls, listingIds: view.listingIds, q };
  const single =
    q.display_type === "radio" ? undefined : singleControls[q.display_type];
  if (single) {
    return questionWrapper(wrapArgs, single(view, name));
  }
  return questionFieldset(
    wrapArgs,
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
