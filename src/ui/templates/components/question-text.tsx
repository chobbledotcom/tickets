/**
 * Shared question-text rendering: decides whether a question's text is simple
 * enough to sit inside a `<label>` (clickable, focuses the control) or complex
 * enough to need a `<div class="prose">` block above the control.
 */

import type { QuestionWithAnswers } from "#shared/db/questions.ts";
import type { Child } from "#shared/jsx/jsx-runtime.ts";
import { Raw } from "#shared/jsx/jsx-runtime.ts";
import { isSimpleMarkdown, renderMarkdown } from "#shared/markdown.ts";

/**
 * Stable id for a question's rendered prose block. A complex-markdown question
 * renders its text outside a `<label>`, so the control (or radio fieldset)
 * points its `aria-labelledby` at this id to stay named for assistive tech.
 */
const questionProseId = (q: QuestionWithAnswers): string =>
  `question-${q.id}-prose`;

/** The prose-HTML for a complex question text, wrapped in a styling div that
 * carries the id its control references via `aria-labelledby`. */
const questionProse = (q: QuestionWithAnswers): string =>
  `<div class="prose" id="${questionProseId(q)}">${renderMarkdown(q.text)}</div>`;

/**
 * True when the question text is simple enough to label a control inline
 * (plain text in a single paragraph — no bold, links, lists, etc.).
 */
export const hasSimpleQuestionText = (q: QuestionWithAnswers): boolean =>
  isSimpleMarkdown(q.text);

/**
 * The question text rendered as JSX-embeddable content: the raw text (auto-
 * escaped by JSX) when simple, or a prose div (Raw HTML) when complex.
 */
export const questionTextContent = (q: QuestionWithAnswers): Child =>
  hasSimpleQuestionText(q) ? q.text : <Raw html={questionProse(q)} />;

/**
 * Build a single-control question (free-text input or select). The control is a
 * factory so the wrapper can name it correctly in both layouts: when the text
 * is simple markdown the control sits inside a `<label>` (clicking it focuses
 * the control, and the label names it implicitly, so no extra prop is passed);
 * when complex the prose sits in a `<div class="prose">` above the control
 * inside a plain `<div>` wrapper, and the control receives the prose's id as
 * `aria-labelledby` so it stays named for assistive tech. Both carry
 * .custom-question (plus any data-listing-ids) so the visibility script can
 * show/hide them.
 */
export const questionWrapper = (
  q: QuestionWithAnswers,
  listingIds: string | undefined,
  control: (labelledBy?: string) => JSX.Element,
): JSX.Element =>
  hasSimpleQuestionText(q) ? (
    <label class="custom-question" data-listing-ids={listingIds}>
      {q.text}
      {control()}
    </label>
  ) : (
    <div class="custom-question" data-listing-ids={listingIds}>
      <Raw html={questionProse(q)} />
      {control(questionProseId(q))}
    </div>
  );

/**
 * Wrap a multi-control question (radio answers) in a fieldset. Simple question
 * text becomes a `<legend>`; complex markdown is rendered as prose before the
 * answer controls and the fieldset is named by it via `aria-labelledby`, so the
 * radio group stays labelled even without a `<legend>`.
 */
export const questionFieldset = (
  q: QuestionWithAnswers,
  listingIds: string | undefined,
  controls: JSX.Element[],
): JSX.Element =>
  hasSimpleQuestionText(q) ? (
    <fieldset class="custom-question" data-listing-ids={listingIds}>
      <legend>{q.text}</legend>
      {controls}
    </fieldset>
  ) : (
    <fieldset
      aria-labelledby={questionProseId(q)}
      class="custom-question"
      data-listing-ids={listingIds}
    >
      {questionTextContent(q)}
      {controls}
    </fieldset>
  );
