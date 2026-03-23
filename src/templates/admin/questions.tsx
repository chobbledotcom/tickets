/**
 * Admin question management templates
 */

import { map } from "#fp";
import { t } from "#i18n";
import type { Answer, QuestionWithAnswers } from "#lib/db/questions.ts";
import { CsrfForm, renderError } from "#lib/forms.tsx";
import { Raw } from "#lib/jsx/jsx-runtime.ts";
import type { AdminSession, EventWithCount } from "#lib/types.ts";
import { AdminNav, Breadcrumb } from "#templates/admin/nav.tsx";
import { Layout } from "#templates/layout.tsx";

/** List all questions */
export const adminQuestionsPage = (
  questions: QuestionWithAnswers[],
  session: AdminSession,
  error?: string,
): string =>
  String(
    <Layout title={t("questions.title")}>
      <AdminNav session={session} active="/admin/questions" />
      <Breadcrumb href="/admin" label={t("questions.breadcrumb")} />

      <h1>{t("questions.heading")}</h1>
      <Raw html={renderError(error)} />

      <CsrfForm action="/admin/questions" id="new-question">
        <label>
          {t("questions.new_label")}
          <input
            type="text"
            name="text"
            required
            placeholder={t("questions.new_placeholder")}
          />
        </label>
        <button type="submit">{t("questions.add_submit")}</button>
      </CsrfForm>

      {questions.length === 0 ? (
        <p>
          <em>{t("questions.no_questions")}</em>
        </p>
      ) : (
        <ul class="question-list">
          {map((q: QuestionWithAnswers) => (
            <li>
              <a href={`/admin/questions/${q.id}`}>{q.text}</a>
              <small>
                {" "}
                ({q.answers.length} answer{q.answers.length !== 1 ? "s" : ""})
              </small>
            </li>
          ))(questions)}
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
): string =>
  String(
    <Layout title={`Question: ${question.text}`}>
      <AdminNav session={session} active="/admin/questions" />
      <Breadcrumb
        href="/admin/questions"
        label={t("questions.edit.breadcrumb")}
      />

      <h1>{question.text}</h1>
      <Raw html={renderError(error)} />

      <CsrfForm action={`/admin/questions/${question.id}/edit`}>
        <label>
          {t("questions.edit.text_label")}
          <input type="text" name="text" required value={question.text} />
        </label>
        <button type="submit">{t("questions.edit.update")}</button>
      </CsrfForm>

      <h2>{t("questions.edit.answers_heading")}</h2>
      <CsrfForm
        action={`/admin/questions/${question.id}/answers`}
        id="add-answer"
      >
        <label>
          {t("questions.edit.new_answer_label")}
          <input
            type="text"
            name="text"
            required
            placeholder={t("questions.edit.new_answer_placeholder")}
          />
        </label>
        <button type="submit">{t("questions.edit.add_answer")}</button>
      </CsrfForm>

      {question.answers.length === 0 ? (
        <p>
          <em>{t("questions.edit.no_answers")}</em>
        </p>
      ) : (
        <ul class="answer-list">
          {question.answers.map((a: Answer, i: number) => (
            <li>
              {a.text}
              {answerCounts && <small> ({answerCounts.get(a.id)})</small>}{" "}
              {i > 0 && (
                <CsrfForm
                  action={`/admin/questions/${question.id}/answers/${a.id}/move-up`}
                  class="inline"
                >
                  <button type="submit" class="link-button small">
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
                  <button type="submit" class="link-button small">
                    &#9660;
                  </button>
                </CsrfForm>
              )}
              {i < question.answers.length - 1 && " "}
              <a
                href={`/admin/questions/${question.id}/answers/${a.id}/delete`}
                class="danger small"
              >
                {t("questions.edit.delete_answer")}
              </a>
            </li>
          ))}
        </ul>
      )}

      <p>
        <a href={`/admin/questions/${question.id}/delete`} class="danger">
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
      <AdminNav session={session} active="/admin/questions" />
      <Breadcrumb
        href={`/admin/questions/${question.id}`}
        label={question.text}
      />

      <h1>{t("questions.delete.heading")}</h1>
      <Raw html={renderError(error)} />

      <article>
        <aside>
          <p>{t("questions.delete.warning")}</p>
        </aside>
      </article>

      <p>{t("questions.delete.confirm_prompt", { text: question.text })}</p>

      <CsrfForm action={`/admin/questions/${question.id}/delete`}>
        <label for="confirm_identifier">
          {t("questions.delete.confirm_label")}
        </label>
        <input
          type="text"
          id="confirm_identifier"
          name="confirm_identifier"
          placeholder={question.text}
          autocomplete="off"
          required
        />
        <button type="submit" class="danger">
          {t("questions.delete.submit")}
        </button>
      </CsrfForm>
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
      <AdminNav session={session} active="/admin/questions" />
      <Breadcrumb
        href={`/admin/questions/${question.id}`}
        label={question.text}
      />

      <h1>{t("questions.delete_answer.heading")}</h1>
      <Raw html={renderError(error)} />

      <article>
        <aside>
          <p>
            {t("questions.delete_answer.warning", {
              answerText: answer.text,
              questionText: question.text,
            })}
          </p>
        </aside>
      </article>

      <p>
        {t("questions.delete_answer.confirm_prompt", { text: answer.text })}
      </p>

      <CsrfForm
        action={`/admin/questions/${question.id}/answers/${answer.id}/delete`}
      >
        <label for="confirm_identifier">
          {t("questions.delete_answer.confirm_label")}
        </label>
        <input
          type="text"
          id="confirm_identifier"
          name="confirm_identifier"
          placeholder={answer.text}
          autocomplete="off"
          required
        />
        <button type="submit" class="danger">
          {t("questions.delete_answer.submit")}
        </button>
      </CsrfForm>
    </Layout>,
  );

/** Event questions assignment page */
export const adminEventQuestionsPage = (
  event: EventWithCount,
  allQuestions: QuestionWithAnswers[],
  assignedIds: Set<number>,
  session: AdminSession,
  error?: string,
): string =>
  String(
    <Layout title={`Questions: ${event.name}`}>
      <AdminNav session={session} active="/admin/" />
      <Breadcrumb href={`/admin/event/${event.id}`} label={event.name} />

      <h1>{t("questions.event.heading", { event: event.name })}</h1>
      <Raw html={renderError(error)} />

      {allQuestions.length === 0 ? (
        <p>{t("questions.event.no_questions")}</p>
      ) : (
        <CsrfForm action={`/admin/event/${event.id}/questions`}>
          {map((q: QuestionWithAnswers) => (
            <label>
              <input
                type="checkbox"
                name="question_ids"
                value={String(q.id)}
                checked={assignedIds.has(q.id) || undefined}
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
          <button type="submit">{t("questions.event.save")}</button>
        </CsrfForm>
      )}
      <p>
        <a href="/admin/questions">{t("questions.event.manage")}</a>
      </p>
    </Layout>,
  );
