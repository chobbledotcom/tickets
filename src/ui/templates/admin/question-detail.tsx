/**
 * The question detail page's content panels, rendered inside the entity-page
 * frame at /admin/questions/:id: the edit form, the answers section, and the
 * listings assignment. Splitting them out keeps the question templates file
 * under its length limit.
 */

import type { QuestionWithAnswers } from "#db/question-types.ts";
import { t } from "#i18n";
import { Raw } from "#jsx/jsx-runtime.ts";
import {
  answerTextForm,
  questionTextForm,
} from "#routes/admin/questions/forms.ts";
import { adminPath } from "#shared/admin-surface.ts";
import { isReadOnly } from "#shared/env.ts";
import { CheckboxLabel } from "#templates/components/aggregate-sections.tsx";
import {
  LinkedItemsCheckboxes,
  toLinkedItemOptions,
} from "#templates/components/linked-items.tsx";
import { reorderCountTable } from "#templates/components/reorder-list.tsx";
import { SaveForm } from "#templates/components/save-form.tsx";
import { SelectField } from "#templates/components/select-field.tsx";
import type { ListingWithCount } from "#types";
import { WritableOnly } from "./writable-only.tsx";

/** Where one of a question's answers is edited, deleted, or recalculated. */
export const answerPath = (
  route: "answerDelete" | "answerEdit" | "answerRecalculate",
  questionId: number,
  answerId: number,
): string => adminPath(route, { answerId, id: questionId });

/** Which listings a question applies to: the assign-to-listings form (or, in
 * read-only mode, the plain text of the assigned names). */
const QuestionListingAssignment = ({
  allListings,
  assignedListingIds,
  question,
}: {
  allListings: ListingWithCount[];
  assignedListingIds: Set<number>;
  question: QuestionWithAnswers;
}): JSX.Element => {
  if (allListings.length === 0) {
    return (
      <p>
        <em>No listings yet.</em>
      </p>
    );
  }
  const listingText = question.assign_all
    ? t("questions.all_listings")
    : allListings
        .filter((listing) => assignedListingIds.has(listing.id))
        .map((listing) => listing.name)
        .join(", ");
  if (isReadOnly()) {
    return <p>{listingText}</p>;
  }
  return (
    <SaveForm
      action={`/admin/questions/${question.id}/listings`}
      id="question-listings"
      submitLabel={t("questions.save_listings")}
    >
      <LinkedItemsCheckboxes
        groups={[
          {
            label: t("terms.listings"),
            options: toLinkedItemOptions(allListings, assignedListingIds),
          },
        ]}
        heading={
          question.assign_all
            ? ({ type }) => t("questions.linked_all_listings", { type })
            : undefined
        }
        leading={
          <CheckboxLabel
            checked={question.assign_all || undefined}
            label={t("questions.assign_all_listings")}
            name="assign_all"
          />
        }
        name="listing_ids"
      />
    </SaveForm>
  );
};

/** The question's edit form: the text field and (for a choice question) the
 * display-type selector. The free-text type is locked because converting it
 * orphans any stored text answers. */
export const QuestionEditPanel = ({
  question,
}: {
  question: QuestionWithAnswers;
}): JSX.Element => (
  <>
    <WritableOnly>
      <SaveForm
        action={`/admin/questions/${question.id}/edit`}
        submitLabel={t("questions.edit.update")}
      >
        <Raw html={questionTextForm.renderField("text", question.text)} />
        {question.display_type === "free_text" ? (
          // Free-text questions cannot become choice questions (a conversion
          // orphans any stored text answers), so lock the type.
          <input name="display_type" type="hidden" value="free_text" />
        ) : (
          <label>
            Display as
            <SelectField
              name="display_type"
              options={[
                { label: "Radio buttons", value: "radio" },
                { label: "Select box", value: "select" },
              ]}
              value={question.display_type}
            />
          </label>
        )}
      </SaveForm>
    </WritableOnly>
    {question.display_type === "free_text" && (
      <div class="prose">
        <p>
          <em>{t("questions.edit.free_text_note")}</em>
        </p>
      </div>
    )}
  </>
);

/** A choice question's answers: the add-answer form and the reorderable
 * count table. Renders nothing for a free-text question, which collects a
 * typed value and has no answers. */
export const QuestionAnswersSection = ({
  question,
  answerCounts,
}: {
  question: QuestionWithAnswers;
  answerCounts: Map<number, number>;
}): JSX.Element | null => {
  if (question.display_type === "free_text") return null;
  return (
    <>
      <h2>{t("questions.edit.answers_heading")}</h2>
      <WritableOnly>
        <SaveForm
          action={`/admin/questions/${question.id}/answers`}
          id="add-answer"
          submitIcon="plus"
          submitLabel={t("questions.edit.add_answer")}
        >
          <Raw html={answerTextForm.render()} />
        </SaveForm>
      </WritableOnly>
      {reorderCountTable({
        count: (a) => answerCounts.get(a.id) ?? 0,
        countHeader: t("questions.selected_column"),
        editHref: (a) => answerPath("answerEdit", question.id, a.id),
        emptyText: t("questions.edit.no_answers"),
        items: question.answers,
        label: (a) => a.text,
        labelHeader: t("questions.answer_column"),
        moveAction: (a) => (d) =>
          `/admin/questions/${question.id}/answers/${a.id}/move-${d}`,
        orderLabel: t("questions.order_column"),
      })}
    </>
  );
};

/** The listings a question applies to, as a heading plus the assignment
 * control. */
export const QuestionListingsSection = ({
  question,
  allListings,
  assignedListingIds,
}: {
  question: QuestionWithAnswers;
  allListings: ListingWithCount[];
  assignedListingIds: Set<number>;
}): JSX.Element => (
  <>
    <h2>{t("questions.assign_to_listings")}</h2>
    <QuestionListingAssignment
      allListings={allListings}
      assignedListingIds={assignedListingIds}
      question={question}
    />
  </>
);
