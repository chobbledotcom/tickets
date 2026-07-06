/**
 * Admin question management templates
 */

import { map } from "#fp";
import { t } from "#i18n";
import type { Child } from "#jsx/jsx-runtime.ts";
import { Raw } from "#jsx/jsx-runtime.ts";
import { answerTextForm, questionTextForm } from "#routes/admin/questions.ts";
import type {
  Answer,
  AnswerAggregateField,
  AnswerAggregateRecalculation,
  QuestionWithAnswers,
} from "#shared/db/questions.ts";
import { CsrfForm, Flash, renderFields } from "#shared/forms.tsx";
import type { AdminSession, ListingWithCount } from "#shared/types.ts";
import { errorAdminPage } from "#templates/admin/admin-page.tsx";
import { ConfirmPage } from "#templates/admin/confirm-page.tsx";
import {
  type ExpectedActualItem,
  ExpectedActualNotice,
} from "#templates/admin/expected-actual.tsx";
import {
  adminRecalculatePage,
  type RecalculateRow,
} from "#templates/admin/recalculate.tsx";
import {
  BackButton,
  GuideFooter,
  SubmitButton,
} from "#templates/components/actions.tsx";
import {
  CheckboxForm,
  CheckboxLabel,
} from "#templates/components/aggregate-sections.tsx";
import {
  LinkedItemsCheckboxes,
  toLinkedItemOptions,
} from "#templates/components/linked-items.tsx";
import {
  ReorderArrows,
  type ReorderProps,
} from "#templates/components/reorder.tsx";
import { SelectField } from "#templates/components/select-field.tsx";
import { colClass } from "#templates/components/table-columns.ts";
import { answerAggregateFields } from "#templates/fields.ts";

/** Render question text flat for admin display: line breaks are replaced with
 * " / " so the text fits on one line in tables, headings, and confirmation
 * prompts. The raw markdown is shown (not rendered) so operators can see
 * exactly what they typed. HTML escaping is left to the JSX/attribute context
 * that consumes the result. */
export const questionTextFlat = (text: string): string =>
  text.replace(/\r?\n/g, " / ");

/** Move-up / move-down reorder controls used as the first column of the
 * question and answer tables. `action` builds the move path for a direction. */
const ReorderControls = ({
  action,
  index,
  count,
}: ReorderProps): JSX.Element => (
  <td class={colClass("reorder")}>
    <ReorderArrows action={action} count={count} index={index} />
  </td>
);

/** A reorderable admin table: the scroll wrapper, the shared leading "order"
 *  column header, the caller's remaining column headers, and the row body. The
 *  question and answer tables differ only in their non-order columns, so this
 *  keeps that scaffold (table-scroll → table → thead → order th) in one place. */
const ReorderTable = ({
  columns,
  children,
}: {
  columns: Child;
  children: Child;
}): JSX.Element => (
  <div class="table-scroll">
    <table>
      <thead>
        <tr>
          <th class={colClass("reorder")}>{t("questions.order_column")}</th>
          {columns}
        </tr>
      </thead>
      <tbody>{children}</tbody>
    </table>
  </div>
);

/** Listings cell for a question row: a count whose title attribute spells out
 * the assigned listing names (comma + space separated), or "All" when the
 * question is assigned to every listing. */
const QuestionListingsCell = ({
  question,
  listingNames,
  totalListings,
}: {
  question: QuestionWithAnswers;
  listingNames: string[];
  totalListings: number;
}): JSX.Element => {
  const all = question.assign_all === true;
  const count = all ? totalListings : listingNames.length;
  const title = all ? t("questions.all_listings") : listingNames.join(", ");
  return (
    <td class={colClass("quantity")} title={title}>
      {count}
    </td>
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
  errorAdminPage(t("questions.title"), "/admin/questions")(session, error)(
    <>
      <CsrfForm action="/admin/questions" id="new-question">
        <Raw html={questionTextForm.render()} />
        <SubmitButton icon="plus">{t("questions.add_submit")}</SubmitButton>
      </CsrfForm>

      {questions.length === 0 ? (
        <p>
          <em>{t("questions.no_questions")}</em>
        </p>
      ) : (
        <ReorderTable
          columns={
            <>
              <th>{t("questions.question_column")}</th>
              <th class={colClass("quantity")}>
                {t("questions.answers_column")}
              </th>
              <th class={colClass("quantity")}>
                {t("questions.listings_column")}
              </th>
            </>
          }
        >
          {questions.map((q, i) => (
            <tr>
              <ReorderControls
                action={(d) => `/admin/questions/${q.id}/move-${d}`}
                count={questions.length}
                index={i}
              />
              <td>
                <a href={`/admin/questions/${q.id}`}>
                  {questionTextFlat(q.text)}
                </a>
              </td>
              <td class={colClass("quantity")}>{q.answers.length}</td>
              <QuestionListingsCell
                listingNames={listingNames.get(q.id) ?? []}
                question={q}
                totalListings={totalListings}
              />
            </tr>
          ))}
        </ReorderTable>
      )}

      <GuideFooter href="/admin/guide#questions">Questions guide</GuideFooter>
    </>,
  );

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

      <CsrfForm action={`/admin/questions/${question.id}/edit`}>
        <Raw html={questionTextForm.field("text").render(question.text)} />
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
        <SubmitButton icon="save">{t("questions.edit.update")}</SubmitButton>
      </CsrfForm>

      {question.display_type === "free_text" ? (
        <p>
          <em>
            Free-text questions collect a typed answer, so they have no answer
            options to manage.
          </em>
        </p>
      ) : (
        <>
          <h2>{t("questions.edit.answers_heading")}</h2>
          <CsrfForm
            action={`/admin/questions/${question.id}/answers`}
            id="add-answer"
          >
            <Raw html={answerTextForm.render()} />
            <SubmitButton icon="plus">
              {t("questions.edit.add_answer")}
            </SubmitButton>
          </CsrfForm>

          {question.answers.length === 0 ? (
            <p>
              <em>{t("questions.edit.no_answers")}</em>
            </p>
          ) : (
            <ReorderTable
              columns={
                <>
                  <th>{t("questions.answer_column")}</th>
                  <th class={colClass("quantity")}>
                    {t("questions.selected_column")}
                  </th>
                </>
              }
            >
              {question.answers.map((a, i) => (
                <tr>
                  <ReorderControls
                    action={(d) =>
                      `/admin/questions/${question.id}/answers/${a.id}/move-${d}`
                    }
                    count={question.answers.length}
                    index={i}
                  />
                  <td>
                    <a
                      href={`/admin/questions/${question.id}/answers/${a.id}/edit`}
                    >
                      {a.text}
                    </a>
                  </td>
                  <td class={colClass("quantity")}>
                    {answerCounts?.get(a.id) ?? 0}
                  </td>
                </tr>
              ))}
            </ReorderTable>
          )}
        </>
      )}

      <h2>{t("questions.assign_to_listings")}</h2>
      {allListings.length === 0 ? (
        <p>
          <em>No listings yet.</em>
        </p>
      ) : (
        <CsrfForm
          action={`/admin/questions/${question.id}/listings`}
          id="question-listings"
        >
          <LinkedItemsCheckboxes
            groups={[
              {
                label: t("terms.listings"),
                options: toLinkedItemOptions(allListings, assignedListingIds),
              },
            ]}
            // assign_all applies the question to every listing regardless of the
            // individually-ticked ids (which may be empty), so show "(all)"
            // rather than a misleading count of the stored id set.
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
          <SubmitButton icon="save">
            {t("questions.save_listings")}
          </SubmitButton>
        </CsrfForm>
      )}

      <p>
        <a class="danger" href={`/admin/questions/${question.id}/delete`}>
          {t("questions.delete.link")}
        </a>
      </p>
    </>,
  );

/** A linkable "answer"-trigger modifier for the answer edit page selector. */
export type AnswerModifierOption = { id: number; name: string };

/** Path to an answer's running-total recalculation page. */
const answerRecalculatePath = (questionId: number, answerId: number): string =>
  `/admin/questions/${questionId}/answers/${answerId}/recalculate`;

/** Drifted answer aggregate columns as expected/actual items (expected = the
 * value rebuilt from attendee answers, actual = the stored running total). */
const answerAggregateMismatchItems = (
  recalc: AnswerAggregateRecalculation,
): ExpectedActualItem[] =>
  answerAggregateFields.flatMap((field) => {
    const name = field.name as AnswerAggregateField;
    const values = recalc[name];
    return values.current === values.recalculated
      ? []
      : [
          {
            actual: String(values.current),
            expected: String(values.recalculated),
            label: field.label,
          },
        ];
  });

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
      html={renderFields(answerAggregateFields, {
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
  errorAdminPage(t("questions.edit_answer.title"), "/admin/questions")(
    session,
    error,
  )(
    <>
      <p>
        <BackButton href={`/admin/questions/${question.id}`}>
          {t("questions.edit_answer.back_to_question")}
        </BackButton>
      </p>

      <h1>{t("questions.edit_answer.heading")}</h1>
      <p>
        <small>
          {t("questions.edit_answer.question_context", {
            text: questionTextFlat(question.text),
          })}
        </small>
      </p>

      <CsrfForm
        action={`/admin/questions/${question.id}/answers/${answer.id}/edit`}
      >
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
        <SubmitButton icon="save">
          {t("questions.edit_answer.save")}
        </SubmitButton>
      </CsrfForm>

      <p>
        <a
          class="danger"
          href={`/admin/questions/${question.id}/answers/${answer.id}/delete`}
        >
          {t("questions.delete_answer.submit")}
        </a>
      </p>
    </>,
  );

/** Build the recalculate table rows comparing the stored selection total with
 * the value rebuilt from attendee answers. */
const answerRecalculateRows = (
  snapshot: AnswerAggregateRecalculation,
): RecalculateRow[] =>
  answerAggregateFields.map((field) => {
    const name = field.name as AnswerAggregateField;
    return {
      current: String(snapshot[name].current),
      label: field.label,
      name,
      recalculated: String(snapshot[name].recalculated),
    };
  });

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

/** The question and answer delete-confirmation pages share one confirm shell:
 *  same `/admin/questions` nav and the standard `<prefix>.submit/heading/
 *  confirm_label/confirm_prompt` locale keys, differing only in action URL,
 *  confirmed name, page title, and warning copy. Parameterising the locale
 *  prefix keeps the repeated `t()` block in one place. */
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
  ConfirmPage({
    action: opts.action,
    active: "/admin/questions",
    buttonText: t(`${opts.prefix}.submit`),
    error,
    heading: t(`${opts.prefix}.heading`),
    label: t(`${opts.prefix}.confirm_label`),
    name: opts.name,
    prompt: { args: { text: opts.name }, key: `${opts.prefix}.confirm_prompt` },
    session: opts.session,
    title: opts.title,
    warning: opts.warning,
  });

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

/** Listing questions assignment page */
/**
 * The listing "Questions" panel: assign the site's questions to this listing.
 * Rendered as the listing entity page's Questions tab (owner-only). Carries its
 * own error flash for in-place 400 re-renders.
 */
export const ListingQuestionsPanel = ({
  listing,
  allQuestions,
  assignedIds,
  error,
}: {
  listing: ListingWithCount;
  allQuestions: QuestionWithAnswers[];
  assignedIds: Set<number>;
  error?: string | undefined;
}): JSX.Element => (
  <>
    <h1>{t("questions.listing.heading", { listing: listing.name })}</h1>
    <Flash error={error} />

    {allQuestions.length === 0 ? (
      <p>
        No questions created yet.{" "}
        <a href="/admin/questions">Create questions</a> first.
      </p>
    ) : (
      <CheckboxForm
        action={`/admin/listing/${listing.id}/questions`}
        submitLabel={t("common.save")}
      >
        {map((q: QuestionWithAnswers) => (
          <CheckboxLabel
            checked={assignedIds.has(q.id) || undefined}
            label={` ${questionTextFlat(q.text)}`}
            name="question_ids"
            value={String(q.id)}
          >
            <small>
              {" "}
              ({q.answers.length} option{q.answers.length !== 1 ? "s" : ""}
              {q.answers.length > 0 && (
                <>: {map((a: Answer) => a.text)(q.answers).join(", ")}</>
              )}
              )
            </small>
          </CheckboxLabel>
        ))(allQuestions)}
      </CheckboxForm>
    )}
    <p>
      <a href="/admin/questions">{t("questions.listing.manage")}</a>
    </p>
  </>
);
