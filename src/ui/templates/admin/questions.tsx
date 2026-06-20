/**
 * Admin question management templates
 */

import { map } from "#fp";
import { t } from "#i18n";
import { Raw } from "#jsx/jsx-runtime.ts";
import { answerTextForm, questionTextForm } from "#routes/admin/questions.ts";
import type {
  Answer,
  AnswerAggregateField,
  AnswerAggregateRecalculation,
  QuestionWithAnswers,
} from "#shared/db/questions.ts";
import { ConfirmForm, CsrfForm, Flash, renderFields } from "#shared/forms.tsx";
import type { AdminSession, ListingWithCount } from "#shared/types.ts";
import {
  type ExpectedActualItem,
  ExpectedActualNotice,
} from "#templates/admin/expected-actual.tsx";
import { AdminNav, SettingsSubNav } from "#templates/admin/nav.tsx";
import {
  adminRecalculatePage,
  type RecalculateRow,
} from "#templates/admin/recalculate.tsx";
import {
  BackButton,
  GuideLink,
  SubmitButton,
} from "#templates/components/actions.tsx";
import { answerAggregateFields } from "#templates/fields.ts";
import { Layout } from "#templates/layout.tsx";

/** Move-up / move-down reorder controls used as the first column of the
 * question and answer tables. `action` builds the move path for a direction. */
const ReorderControls = ({
  action,
  index,
  count,
}: {
  action: (direction: "up" | "down") => string;
  index: number;
  count: number;
}): JSX.Element => (
  <>
    {index > 0 && (
      <CsrfForm action={action("up")} class="inline">
        <button class="link-button small" type="submit">
          &#9650;
        </button>
      </CsrfForm>
    )}{" "}
    {index < count - 1 && (
      <CsrfForm action={action("down")} class="inline">
        <button class="link-button small" type="submit">
          &#9660;
        </button>
      </CsrfForm>
    )}
  </>
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
  return <td title={title}>{count}</td>;
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
  String(
    <Layout title={t("questions.title")}>
      <AdminNav active="/admin/settings" session={session} />
      <SettingsSubNav />

      <p class="actions">
        <GuideLink href="/admin/guide#questions">Questions guide</GuideLink>
      </p>
      <Flash error={error} />

      <CsrfForm action="/admin/questions" id="new-question">
        <Raw html={questionTextForm.render()} />
        <SubmitButton icon="plus">{t("questions.add_submit")}</SubmitButton>
      </CsrfForm>

      {questions.length === 0 ? (
        <p>
          <em>{t("questions.no_questions")}</em>
        </p>
      ) : (
        <div class="table-scroll">
          <table>
            <thead>
              <tr>
                <th>{t("questions.order_column")}</th>
                <th>{t("questions.question_column")}</th>
                <th>{t("questions.answers_column")}</th>
                <th>{t("questions.listings_column")}</th>
              </tr>
            </thead>
            <tbody>
              {questions.map((q, i) => (
                <tr>
                  <td>
                    <ReorderControls
                      action={(d) => `/admin/questions/${q.id}/move-${d}`}
                      count={questions.length}
                      index={i}
                    />
                  </td>
                  <td>
                    <a href={`/admin/questions/${q.id}`}>{q.text}</a>
                  </td>
                  <td>{q.answers.length}</td>
                  <QuestionListingsCell
                    listingNames={listingNames.get(q.id) ?? []}
                    question={q}
                    totalListings={totalListings}
                  />
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Layout>,
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
  String(
    <Layout title={`Question: ${question.text}`}>
      <AdminNav active="/admin/settings" session={session} />
      <SettingsSubNav />

      <h1>{question.text}</h1>
      <Flash error={error} />

      <CsrfForm action={`/admin/questions/${question.id}/edit`}>
        <Raw html={questionTextForm.field("text").render(question.text)} />
        {question.display_type === "free_text" ? (
          // Free-text questions can't become choice questions (it would orphan
          // any stored text answers), so lock the type rather than offering it.
          <input name="display_type" type="hidden" value="free_text" />
        ) : (
          <label>
            Display as
            <select name="display_type">
              <option
                selected={question.display_type === "radio"}
                value="radio"
              >
                Radio buttons
              </option>
              <option
                selected={question.display_type === "select"}
                value="select"
              >
                Select box
              </option>
            </select>
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
            <div class="table-scroll">
              <table>
                <thead>
                  <tr>
                    <th>{t("questions.order_column")}</th>
                    <th>{t("questions.answer_column")}</th>
                    <th>{t("questions.selected_column")}</th>
                  </tr>
                </thead>
                <tbody>
                  {question.answers.map((a, i) => (
                    <tr>
                      <td>
                        <ReorderControls
                          action={(d) =>
                            `/admin/questions/${question.id}/answers/${a.id}/move-${d}`
                          }
                          count={question.answers.length}
                          index={i}
                        />
                      </td>
                      <td>
                        <a
                          href={`/admin/questions/${question.id}/answers/${a.id}/edit`}
                        >
                          {a.text}
                        </a>
                      </td>
                      <td>{answerCounts?.get(a.id) ?? 0}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
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
          <fieldset class="checkboxes">
            <label>
              <input
                checked={question.assign_all || undefined}
                name="assign_all"
                type="checkbox"
              />
              {" Assign to all listings"}
            </label>
            {map((e: ListingWithCount) => (
              <label>
                <input
                  checked={assignedListingIds.has(e.id) || undefined}
                  name="listing_ids"
                  type="checkbox"
                  value={String(e.id)}
                />
                {` ${e.name}`}
              </label>
            ))(allListings)}
          </fieldset>
          <SubmitButton icon="save">Save Listings</SubmitButton>
        </CsrfForm>
      )}

      <p>
        <a class="danger" href={`/admin/questions/${question.id}/delete`}>
          {t("questions.delete.link")}
        </a>
      </p>
    </Layout>,
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
  String(
    <Layout title={t("questions.edit_answer.title")}>
      <AdminNav active="/admin/settings" session={session} />
      <SettingsSubNav />

      <p>
        <BackButton href={`/admin/questions/${question.id}`}>
          {t("questions.edit_answer.back_to_question")}
        </BackButton>
      </p>

      <h1>{t("questions.edit_answer.heading")}</h1>
      <p>
        <small>
          {t("questions.edit_answer.question_context", { text: question.text })}
        </small>
      </p>
      <Flash error={error} />

      <CsrfForm
        action={`/admin/questions/${question.id}/answers/${answer.id}/edit`}
      >
        <Raw html={answerTextForm.render({ text: answer.text })} />
        <label>
          {t("questions.edit_answer.modifier_label")}
          <select id="modifier_id" name="modifier_id">
            <option selected={modifierId === null} value="">
              {t("questions.edit_answer.modifier_none")}
            </option>
            {modifiers.map((m) => (
              <option selected={m.id === modifierId} value={String(m.id)}>
                {m.name}
              </option>
            ))}
          </select>
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
    </Layout>,
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
    active: "/admin/settings",
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

/** Question delete confirmation page */
export const adminQuestionDeletePage = (
  question: QuestionWithAnswers,
  session: AdminSession,
  error?: string,
): string =>
  String(
    <Layout title={t("questions.delete.heading")}>
      <AdminNav active="/admin/settings" session={session} />
      <SettingsSubNav />

      <ConfirmForm
        action={`/admin/questions/${question.id}/delete`}
        buttonText={t("questions.delete.submit")}
        label={t("questions.delete.confirm_label")}
        name={question.text}
      >
        <h1>{t("questions.delete.heading")}</h1>
        <Flash error={error} />
        <p>{t("questions.delete.warning")}</p>
        <p>{t("questions.delete.confirm_prompt", { text: question.text })}</p>
      </ConfirmForm>
    </Layout>,
  );

/** Answer delete confirmation page */
export const adminAnswerDeletePage = (
  question: QuestionWithAnswers,
  answer: Answer,
  session: AdminSession,
  error?: string,
): string =>
  String(
    <Layout title={t("questions.delete_answer.title")}>
      <AdminNav active="/admin/settings" session={session} />
      <SettingsSubNav />

      <ConfirmForm
        action={`/admin/questions/${question.id}/answers/${answer.id}/delete`}
        buttonText={t("questions.delete_answer.submit")}
        label={t("questions.delete_answer.confirm_label")}
        name={answer.text}
      >
        <h1>{t("questions.delete_answer.heading")}</h1>
        <Flash error={error} />
        <p>
          {t("questions.delete_answer.warning", {
            answerText: answer.text,
            questionText: question.text,
          })}
        </p>
        <p>
          {t("questions.delete_answer.confirm_prompt", { text: answer.text })}
        </p>
      </ConfirmForm>
    </Layout>,
  );

/** Listing questions assignment page */
export const adminListingQuestionsPage = (
  listing: ListingWithCount,
  allQuestions: QuestionWithAnswers[],
  assignedIds: Set<number>,
  session: AdminSession,
  error?: string,
): string =>
  String(
    <Layout title={`Questions: ${listing.name}`}>
      <AdminNav active="/admin/" session={session} />

      <h1>{t("questions.listing.heading", { listing: listing.name })}</h1>
      <Flash error={error} />

      {allQuestions.length === 0 ? (
        <p>
          No questions created yet.{" "}
          <a href="/admin/questions">Create questions</a> first.
        </p>
      ) : (
        <CsrfForm action={`/admin/listing/${listing.id}/questions`}>
          <fieldset class="checkboxes">
            {map((q: QuestionWithAnswers) => (
              <label>
                <input
                  checked={assignedIds.has(q.id) || undefined}
                  name="question_ids"
                  type="checkbox"
                  value={String(q.id)}
                />
                {` ${q.text}`}
                <small>
                  {" "}
                  ({q.answers.length} option{q.answers.length !== 1 ? "s" : ""}
                  {q.answers.length > 0 && (
                    <>: {map((a: Answer) => a.text)(q.answers).join(", ")}</>
                  )}
                  )
                </small>
              </label>
            ))(allQuestions)}
          </fieldset>
          <SubmitButton icon="save">{t("common.save")}</SubmitButton>
        </CsrfForm>
      )}
      <p>
        <a href="/admin/questions">{t("questions.listing.manage")}</a>
      </p>
    </Layout>,
  );
