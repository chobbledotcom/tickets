/** The booking form fields for a question that asks once for each booked
 * listing. The question has one text field for each listing it asks. */

import type { TicketListing } from "#booking/model.ts";
import { type BookingTree, shownListingIds } from "#booking/tree.ts";
import type { QuestionWithAnswers } from "#db/question-types.ts";
import {
  type AnswerLine,
  lineAnswerFieldName,
} from "#db/questions/line-answers.ts";
import { uniqueBy } from "#fp";
import { savedFormValue } from "#shared/forms/saved-data.ts";
import { MAX_TEXTAREA_LENGTH } from "#shared/limits.ts";
import { questionTextContent } from "#templates/components/question-text.tsx";

/** The listings a buyer can see on the page, and the children they can pick
 * under those listings, once each. A hidden package member is never named. */
export const pageAnswerLines = (
  listings: readonly TicketListing[],
  tree: BookingTree,
  childrenByParentId: ReadonlyMap<number, TicketListing[]> | undefined,
): AnswerLine[] => {
  const shownIds = shownListingIds(tree.nodes);
  const shown = listings.filter((info) => shownIds.has(info.listing.id));
  const children = shown.flatMap(
    (info) => childrenByParentId?.get(info.listing.id) ?? [],
  );
  return uniqueBy((line: AnswerLine) => line.id)(
    [...shown, ...children].map((info) => ({
      id: info.listing.id,
      name: info.listing.name,
    })),
  );
};

/** The text field for one question under one listing. */
const lineField = (questionId: number, line: AnswerLine): JSX.Element => {
  const name = lineAnswerFieldName(questionId, line.id);
  return (
    <label class="custom-question" data-listing-ids={String(line.id)}>
      {line.name}
      <input
        maxlength={MAX_TEXTAREA_LENGTH}
        name={name}
        type="text"
        value={savedFormValue(name)}
      />
    </label>
  );
};

/** One question's fields, one for each listing it asks. The listing ids let the
 * visibility script show a field only while its listing is in the order. The
 * script adds `required`, and the server holds the rule. */
export const renderLineQuestion = (
  question: QuestionWithAnswers,
  lines: readonly AnswerLine[],
): JSX.Element => (
  <fieldset
    class="custom-question"
    data-listing-ids={lines.map((line) => line.id).join(" ")}
  >
    <legend>{questionTextContent(question)}</legend>
    {lines.map((line) => lineField(question.id, line))}
  </fieldset>
);
