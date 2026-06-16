/**
 * Admin question management templates
 */

import { map } from "#fp";
import { t } from "#i18n";
import { Raw } from "#jsx/jsx-runtime.ts";
import { answerTextForm, questionTextForm } from "#routes/admin/questions.ts";
import type { Answer, QuestionWithAnswers } from "#shared/db/questions.ts";
import { ConfirmForm, CsrfForm, Flash } from "#shared/forms.tsx";
import type { AdminSession, ListingWithCount } from "#shared/types.ts";
import { AdminNav } from "#templates/admin/nav.tsx";
import { GuideLink, SubmitButton } from "#templates/components/actions.tsx";
import { Layout } from "#templates/layout.tsx";

/** List all questions */
export const adminQuestionsPage = (
  questions: QuestionWithAnswers[],
  session: AdminSession,
  error?: string,
): string =>
  String(
    <Layout title={t("questions.title")}>
      <AdminNav active="/admin/questions" session={session} />

      <div class="prose">
        <h1>{t("questions.heading")}</h1>
        <p class="actions">
          <GuideLink href="/admin/guide#questions">Questions guide</GuideLink>
        </p>
      </div>
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
        <ul class="question-list">
          {questions.map((q, i) => (
            <li>
              <a href={`/admin/questions/${q.id}`}>{q.text}</a>
              <small>
                {" "}
                ({q.answers.length} answer{q.answers.length !== 1 ? "s" : ""})
              </small>{" "}
              {i > 0 && (
                <CsrfForm
                  action={`/admin/questions/${q.id}/move-up`}
                  class="inline"
                >
                  <button class="link-button small" type="submit">
                    &#9650;
                  </button>
                </CsrfForm>
              )}
              {i > 0 && " "}
              {i < questions.length - 1 && (
                <CsrfForm
                  action={`/admin/questions/${q.id}/move-down`}
                  class="inline"
                >
                  <button class="link-button small" type="submit">
                    &#9660;
                  </button>
                </CsrfForm>
              )}
            </li>
          ))}
        </ul>
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
      <AdminNav active="/admin/questions" session={session} />

      <h1>{question.text}</h1>
      <Flash error={error} />

      <CsrfForm action={`/admin/questions/${question.id}/edit`}>
        <Raw html={questionTextForm.render({ text: question.text })} />
        <SubmitButton icon="save">{t("questions.edit.update")}</SubmitButton>
      </CsrfForm>

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
        <ul class="answer-list">
          {question.answers.map((a, i) => (
            <li>
              {a.text}
              {answerCounts && <small>({answerCounts.get(a.id)})</small>}{" "}
              {i > 0 && (
                <CsrfForm
                  action={`/admin/questions/${question.id}/answers/${a.id}/move-up`}
                  class="inline"
                >
                  <button class="link-button small" type="submit">
                    &#9650;
                  </button>
                </CsrfForm>
              )}
              {i > 0 && " "}
              {i < question.answers.length - 1 && (
                <CsrfForm
                  action={`/admin/questions/${question.id}/answers/${a.id}/move-down`}
                  class="inline"
                >
                  <button class="link-button small" type="submit">
                    &#9660;
                  </button>
                </CsrfForm>
              )}
              {i < question.answers.length - 1 && " "}
              <a
                class="danger small"
                href={`/admin/questions/${question.id}/answers/${a.id}/delete`}
              >
                {t("common.delete")}
              </a>
            </li>
          ))}
        </ul>
      )}

      <h2>Assign to Listings</h2>
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

/** Question delete confirmation page */
export const adminQuestionDeletePage = (
  question: QuestionWithAnswers,
  session: AdminSession,
  error?: string,
): string =>
  String(
    <Layout title={t("questions.delete.heading")}>
      <AdminNav active="/admin/questions" session={session} />

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
      <AdminNav active="/admin/questions" session={session} />

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
