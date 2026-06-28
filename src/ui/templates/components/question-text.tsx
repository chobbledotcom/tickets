/**
 * Shared question-text rendering: decides whether a question's text is simple
 * enough to sit inside a `<label>` (clickable, focuses the control) or complex
 * enough to need a `<div class="prose">` block above the control.
 */

import type { QuestionWithAnswers } from "#shared/db/questions.ts";
import type { Child } from "#shared/jsx/jsx-runtime.ts";
import { Raw } from "#shared/jsx/jsx-runtime.ts";
import { isSimpleMarkdown, renderMarkdown } from "#shared/markdown.ts";

/** The prose-HTML for a complex question text, wrapped in a styling div. */
const questionProse = (text: string): string =>
  `<div class="prose">${renderMarkdown(text)}</div>`;

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
  hasSimpleQuestionText(q) ? q.text : <Raw html={questionProse(q.text)} />;

/**
 * Wrap a single-control question (free-text input or select) with its question
 * text. When the text is simple markdown it sits inside a `<label>` so clicking
 * it focuses the control. When complex it sits in a `<div class="prose">` above
 * the control inside a plain `<div>` wrapper. Both carry .custom-question (plus
 * any data-listing-ids) so the visibility script can show/hide them.
 */
export const questionWrapper = (
  q: QuestionWithAnswers,
  listingIds: string | undefined,
  control: JSX.Element,
): JSX.Element =>
  hasSimpleQuestionText(q) ? (
    <label class="custom-question" data-listing-ids={listingIds}>
      {q.text}
      {control}
    </label>
  ) : (
    <div class="custom-question" data-listing-ids={listingIds}>
      <Raw html={questionProse(q.text)} />
      {control}
    </div>
  );

/**
 * Wrap a multi-control question (radio answers) in a fieldset. Simple question
 * text becomes a `<legend>`; complex markdown is rendered as prose before the
 * answer controls.
 */
export const questionFieldset = (
  q: QuestionWithAnswers,
  listingIds: string | undefined,
  controls: JSX.Element[],
): JSX.Element => (
  <fieldset class="custom-question" data-listing-ids={listingIds}>
    {hasSimpleQuestionText(q) ? (
      <legend>{q.text}</legend>
    ) : (
      questionTextContent(q)
    )}
    {controls}
  </fieldset>
);
