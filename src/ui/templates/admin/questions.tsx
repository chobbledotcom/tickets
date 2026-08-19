/**
 * Admin question management templates
 */

import { map } from "#fp";
import { t } from "#i18n";
import { Raw } from "#jsx/jsx-runtime.ts";
import {
  answerTextForm,
  questionTextForm,
} from "#routes/admin/questions/forms.ts";
import { adminPath, adminPattern } from "#shared/admin-surface.ts";
import type { Answer, QuestionWithAnswers } from "#shared/db/question-types.ts";
import type {
  AnswerAggregateField,
  AnswerAggregateRecalculation,
} from "#shared/db/questions/aggregates.ts";
import { isReadOnly } from "#shared/env.ts";
import { renderFields } from "#shared/forms/rendering.tsx";
import type { AdminSession, ListingWithCount } from "#shared/types.ts";
import { errorAdminPage } from "#templates/admin/admin-page.tsx";
import { childEditPage } from "#templates/admin/child-edit-page.tsx";
import { warningDeletePage } from "#templates/admin/confirm-page.tsx";
import {
  driftedRowItems,
  type ExpectedActualItem,
  ExpectedActualNotice,
} from "#templates/admin/expected-actual.tsx";
import {
  adminRecalculatePage,
  type RecalculateRow,
} from "#templates/admin/recalculate.tsx";
import { buildRecalculateRows } from "#templates/admin/recalculate-rows.ts";
import { SubmitButton } from "#templates/components/actions.tsx";
import {
  CheckboxForm,
  CheckboxLabel,
  IdCheckboxLabel,
} from "#templates/components/aggregate-sections.tsx";
import {
  LinkedItemsCheckboxes,
  toLinkedItemOptions,
} from "#templates/components/linked-items.tsx";
import {
  reorderableListPage,
  reorderCountTable,
} from "#templates/components/reorder-list.tsx";
import { SaveForm } from "#templates/components/save-form.tsx";
import { SelectField } from "#templates/components/select-field.tsx";
import { getAnswerAggregateFields } from "#templates/fields/aggregate.ts";
import {
  type ListingPanelProps,
  listingChoicePanel,
} from "./listing-panel-frame.tsx";
import { WritableDangerLink, WritableOnly } from "./writable-only.tsx";

/** Render question text flat for admin display: line breaks are replaced with
 * " / " so the text fits on one line in tables, headings, and confirmation
 * prompts. The raw markdown is shown (not rendered) so operators can see
 * exactly what they typed. HTML escaping is left to the JSX/attribute context
 * that consumes the result. */
export const questionTextFlat = (text: string): string =>
  text.replace(/\r?\n/g, " / ");

/** Listings cell for a question row: a count whose title attribute spells out
 * the assigned listing names (comma + space separated), or "All" when the
 * question is assigned to every listing. */
const questionListings = ({
  question,
  listingNames,
  totalListings,
}: {
  question: QuestionWithAnswers;
  listingNames: string[];
  totalListings: number;
}): { count: number; title: string } => {
  const all = question.assign_all === true;
  const count = all ? totalListings : listingNames.length;
  const title = all ? t("questions.all_listings") : listingNames.join(", ");
  return { count, title };
};

const questionListingsFor =
  (listingNames: Map<number, string[]>, totalListings: number) =>
  (question: QuestionWithAnswers): { count: number; title: string } =>
    questionListings({
      listingNames: listingNames.get(question.id) ?? [],
      question,
      totalListings,
    });

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

/** List all questions in a reorderable table, mirroring the listings table:
 * reorder arrows in the first column, then the question, its answer count, and
 * the listings it applies to. */
export const adminQuestionsPage = (
  questions: QuestionWithAnswers[],
  session: AdminSession,
  error?: string,
  listingNames: Map<number, string[]> = new Map(),
  totalListings = 0,
): string =>
  reorderableListPage({
    addFormHtml: questionTextForm.render(),
    addLabel: t("questions.add_submit"),
    basePath: adminPattern("questions"),
    columns: [
      {
        cell: (question) => (
          <a href={`/admin/questions/${question.id}`}>
            {questionTextFlat(question.text)}
          </a>
        ),
        header: t("questions.question_column"),
        key: "question",
      },
      {
        cell: (question) => question.answers.length,
        class: "quantity",
        header: t("questions.answers_column"),
        key: "answers",
      },
      {
        cell: (question) =>
          questionListingsFor(listingNames, totalListings)(question).count,
        cellAttrs: (question) => ({
          title: questionListingsFor(listingNames, totalListings)(question)
            .title,
        }),
        class: "quantity",
        header: t("questions.listings_column"),
        key: "listings",
      },
    ],
    emptyText: t("questions.no_questions"),
    error,
    guideHref: "/admin/guide#questions",
    guideLabel: "Questions guide",
    items: questions,
    newFormId: "new-question",
    orderLabel: t("questions.order_column"),
    session,
    title: t("questions.title"),
  });

/** Single question detail / edit page */
export const adminQuestionPage = (
  question: QuestionWithAnswers,
  session: AdminSession,
  error?: string,
  answerCounts?: Map<number, number>,
  allListings: ListingWithCount[] = [],
  assignedListingIds: Set<number> = new Set(),
): string =>
  errorAdminPage(
    `Question: ${questionTextFlat(question.text)}`,
    "/admin/questions",
  )(
    session,
    error,
  )(
    <>
      <h1>{questionTextFlat(question.text)}</h1>

      <WritableOnly>
        <SaveForm
          action={`/admin/questions/${question.id}/edit`}
          submitLabel={t("questions.edit.update")}
        >
          <Raw html={questionTextForm.renderField("text", question.text)} />
          {question.display_type === "free_text" ? (
            // Free-text questions can't become choice questions (it would orphan
            // any stored text answers), so lock the type rather than offering it.
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

      {question.display_type === "free_text" ? (
        <p>
          <em>
            Free-text questions collect a typed answer, so they have no answer
            options to manage — and can't change the price, because a price
            modifier attaches to a chosen answer, which a typed answer has none
            of.
          </em>
        </p>
      ) : (
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
            count: (a) => answerCounts?.get(a.id) ?? 0,
            countHeader: t("questions.selected_column"),
            editHref: (a) =>
              adminPath("answerEdit", { answerId: a.id, id: question.id }),
            emptyText: t("questions.edit.no_answers"),
            items: question.answers,
            label: (a) => a.text,
            labelHeader: t("questions.answer_column"),
            moveAction: (a) => (d) =>
              `/admin/questions/${question.id}/answers/${a.id}/move-${d}`,
            orderLabel: t("questions.order_column"),
          })}
        </>
      )}

      <h2>{t("questions.assign_to_listings")}</h2>
      <QuestionListingAssignment
        allListings={allListings}
        assignedListingIds={assignedListingIds}
        question={question}
      />

      <WritableDangerLink
        href={adminPath("questionDelete", { id: question.id })}
      >
        {t("questions.delete.link")}
      </WritableDangerLink>
    </>,
  );

/** A linkable "answer"-trigger modifier for the answer edit page selector. */
export type AnswerModifierOption = { id: number; name: string };

/** Path to an answer's running-total recalculation page. */
const answerRecalculatePath = (questionId: number, answerId: number): string =>
  `/admin/questions/${questionId}/answers/${answerId}/recalculate`;

/** Build the recalculate table rows comparing the stored selection total with
 * the value rebuilt from attendee answers. */
const answerRecalculateRows = (
  snapshot: AnswerAggregateRecalculation,
): RecalculateRow[] =>
  buildRecalculateRows(
    getAnswerAggregateFields(),
    (_name: AnswerAggregateField, value) => String(value),
    snapshot,
  );

/** Drifted answer aggregate columns as expected/actual items (expected = the
 * value rebuilt from attendee answers, actual = the stored running total). */
const answerAggregateMismatchItems = (
  recalc: AnswerAggregateRecalculation,
): ExpectedActualItem[] => driftedRowItems(answerRecalculateRows(recalc));

/** Owner-editable selection total, with the same drift warning and recalculate
 * link the listing edit page uses for its running totals. */
const AnswerRunningTotalsSection = ({
  question,
  answer,
  aggregateRecalculation,
}: {
  question: QuestionWithAnswers;
  answer: Answer;
  aggregateRecalculation: AnswerAggregateRecalculation;
}): JSX.Element => (
  <fieldset>
    <legend>{t("questions.edit_answer.running_totals")}</legend>
    <ExpectedActualNotice
      actionHref={answerRecalculatePath(question.id, answer.id)}
      actionLabel={t("questions.edit_answer.mismatch_action")}
      explanation={t("questions.edit_answer.mismatch_explanation")}
      items={answerAggregateMismatchItems(aggregateRecalculation)}
      title={t("questions.edit_answer.mismatch_title")}
    />
    <p>
      <small>{t("questions.edit_answer.running_totals_note")}</small>
    </p>
    <Raw
      html={renderFields(getAnswerAggregateFields(), {
        times_selected: aggregateRecalculation.times_selected.current,
      })}
    />
    <p>
      <a href={answerRecalculatePath(question.id, answer.id)}>
        {t("questions.edit_answer.recalculate_totals")}
      </a>
    </p>
  </fieldset>
);

/** Answer edit page: a back link to the question, the editable answer text, the
 * editable selection total (with drift warning + recalculate flow), the price
 * modifier this answer triggers, and the delete action. Ordering still lives on
 * the question page. */
export const adminAnswerEditPage = (
  question: QuestionWithAnswers,
  answer: Answer,
  session: AdminSession,
  error: string | undefined,
  aggregateRecalculation: AnswerAggregateRecalculation,
  modifiers: AnswerModifierOption[],
  modifierId: number | null,
): string =>
  childEditPage({
    active: "/admin/questions",
    backHref: `/admin/questions/${question.id}`,
    backLabel: t("questions.edit_answer.back_to_question"),
    context: t("questions.edit_answer.question_context", {
      text: questionTextFlat(question.text),
    }),
    formAction: `/admin/questions/${question.id}/answers/${answer.id}/edit`,
    heading: t("questions.edit_answer.heading"),
    title: t("questions.edit_answer.title"),
  })(
    session,
    error,
    <>
      <Raw html={answerTextForm.render({ text: answer.text })} />
      <label>
        {t("questions.edit_answer.modifier_label")}
        <SelectField
          id="modifier_id"
          name="modifier_id"
          options={[
            { label: t("questions.edit_answer.modifier_none"), value: "" },
            ...modifiers.map((m) => ({ label: m.name, value: String(m.id) })),
          ]}
          value={modifierId === null ? "" : String(modifierId)}
        />
        <small>{t("questions.edit_answer.modifier_hint")}</small>
      </label>
      <label>
        <input
          checked={answer.active || undefined}
          name="active"
          type="checkbox"
          value="on"
        />{" "}
        Active
        <small>
          Deactivate to hide this answer on the booking form. Attendees who
          already chose it keep it, and it still shows on their edit page.
        </small>
      </label>
      <AnswerRunningTotalsSection
        aggregateRecalculation={aggregateRecalculation}
        answer={answer}
        question={question}
      />
      <SubmitButton icon="save">{t("questions.edit_answer.save")}</SubmitButton>
    </>,
    <p>
      <a
        class="danger"
        href={`/admin/questions/${question.id}/answers/${answer.id}/delete`}
      >
        {t("questions.delete_answer.submit")}
      </a>
    </p>,
  );

/** Answer running-total recalculation page — the reset flow linked from the
 * edit page's drift warning, mirroring the listing/modifier recalculate pages. */
export const adminAnswerRecalculatePage = (
  question: QuestionWithAnswers,
  answer: Answer,
  snapshot: AnswerAggregateRecalculation,
  session: AdminSession,
  error?: string,
  success?: string,
): string =>
  adminRecalculatePage({
    action: answerRecalculatePath(question.id, answer.id),
    active: "/admin/questions",
    currentLabel: t("questions.recalculate.current"),
    description: t("questions.recalculate.description"),
    error,
    recalculatedLabel: t("questions.recalculate.from_attendees"),
    rows: answerRecalculateRows(snapshot),
    session,
    submitLabel: t("questions.recalculate.save"),
    success,
    title: t("questions.recalculate.heading", { text: answer.text }),
  });

/** The warning-led delete page on the questions nav. */
const questionsDeletePage = warningDeletePage("/admin/questions");

/** The question and answer delete pages differ only in action URL, confirmed
 *  name, page title, and warning copy — the rest of their wording comes from
 *  the standard `<prefix>.submit/heading/confirm_label/confirm_prompt` locale
 *  keys, derived here in one place. */
const questionDeleteConfirmPage = (
  opts: {
    action: string;
    name: string;
    prefix: string;
    title: string;
    warning: JSX.Element;
    session: AdminSession;
  },
  error?: string,
): string =>
  questionsDeletePage(
    {
      action: opts.action,
      buttonText: t(`${opts.prefix}.submit`),
      heading: t(`${opts.prefix}.heading`),
      label: t(`${opts.prefix}.confirm_label`),
      name: opts.name,
      prompt: {
        args: { text: opts.name },
        key: `${opts.prefix}.confirm_prompt`,
      },
      title: opts.title,
      warning: opts.warning,
    },
    opts.session,
    error,
  );

/** Question delete confirmation page */
export const adminQuestionDeletePage = (
  question: QuestionWithAnswers,
  session: AdminSession,
  error?: string,
): string =>
  questionDeleteConfirmPage(
    {
      action: `/admin/questions/${question.id}/delete`,
      name: questionTextFlat(question.text),
      prefix: "questions.delete",
      session,
      title: t("questions.delete.heading"),
      warning: <p>{t("questions.delete.warning")}</p>,
    },
    error,
  );

/** Answer delete confirmation page */
export const adminAnswerDeletePage = (
  question: QuestionWithAnswers,
  answer: Answer,
  session: AdminSession,
  error?: string,
): string => {
  const warning = (
    <p>
      {t("questions.delete_answer.warning", {
        answerText: answer.text,
        questionText: questionTextFlat(question.text),
      })}
    </p>
  );
  return questionDeleteConfirmPage(
    {
      action: `/admin/questions/${question.id}/answers/${answer.id}/delete`,
      name: answer.text,
      prefix: "questions.delete_answer",
      session,
      title: t("questions.delete_answer.title"),
      warning,
    },
    error,
  );
};

/**
 * The listing "Questions" panel: assign the site's questions to this listing.
 * Rendered as the listing entity page's Questions tab (owner-only). Save
 * feedback arrives as a redirect flash rendered by the page frame.
 */
type ListingQuestionsPanelProps = ListingPanelProps & {
  allQuestions: QuestionWithAnswers[];
  assignedIds: Set<number>;
};

export const ListingQuestionsPanel = (
  props: ListingQuestionsPanelProps,
): JSX.Element => {
  const { allQuestions, assignedIds, listing } = props;
  return listingChoicePanel(
    t("questions.listing.heading", { listing: listing.name }),
    <p>
      <a href="/admin/questions">{t("questions.listing.manage")}</a>
    </p>,
    allQuestions,
    () => (
      <p>
        No questions created yet.{" "}
        <a href="/admin/questions">Create questions</a> first.
      </p>
    ),
    (questions) => (
      <CheckboxForm
        action={`/admin/listing/${listing.id}/questions`}
        submitLabel={t("common.save")}
      >
        {map((q: QuestionWithAnswers) => (
          <IdCheckboxLabel
            checkedIds={assignedIds}
            id={q.id}
            label={` ${questionTextFlat(q.text)}`}
            name="question_ids"
          >
            <small>
              {" "}
              ({q.answers.length} option{q.answers.length !== 1 ? "s" : ""}
              {q.answers.length > 0 && (
                <>: {map((a: Answer) => a.text)(q.answers).join(", ")}</>
              )}
              )
            </small>
          </IdCheckboxLabel>
        ))(questions)}
      </CheckboxForm>
    ),
  );
};
