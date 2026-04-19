/**
 * Admin question management templates
 */

import { map } from "#fp";
import type { Answer, QuestionWithAnswers } from "#lib/db/questions.ts";
import { ConfirmForm, CsrfForm, Flash } from "#lib/forms.tsx";
import type { AdminSession, EventWithCount } from "#lib/types.ts";
import { AdminNav } from "#templates/admin/nav.tsx";
import { Layout } from "#templates/layout.tsx";

/** List all questions */
export const adminQuestionsPage = (
  questions: QuestionWithAnswers[],
  session: AdminSession,
  error?: string,
): string =>
  String(
    <Layout title="Custom Questions">
      <AdminNav active="/admin/questions" session={session} />

      <h1>Custom Questions</h1>
      <p>
        <a href="/admin/guide#questions">Questions guide</a>
      </p>
      <Flash error={error} />

      <CsrfForm action="/admin/questions" id="new-question">
        <label>
          New Question
          <input
            name="text"
            placeholder="e.g. What is your T-shirt size?"
            required
            type="text"
          />
        </label>
        <button type="submit">Add Question</button>
      </CsrfForm>

      {questions.length === 0 ? (
        <p>
          <em>No custom questions yet.</em>
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
      <AdminNav active="/admin/questions" session={session} />

      <h1>{question.text}</h1>
      <Flash error={error} />

      <CsrfForm action={`/admin/questions/${question.id}/edit`}>
        <label>
          Question Text
          <input name="text" required type="text" value={question.text} />
        </label>
        <button type="submit">Update</button>
      </CsrfForm>

      <h2>Answer Options</h2>
      <CsrfForm
        action={`/admin/questions/${question.id}/answers`}
        id="add-answer"
      >
        <label>
          New Answer
          <input name="text" placeholder="e.g. Medium" required type="text" />
        </label>
        <button type="submit">Add Answer</button>
      </CsrfForm>

      {question.answers.length === 0 ? (
        <p>
          <em>No answers yet. Add at least 2 answer options.</em>
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
                Delete
              </a>
            </li>
          ))}
        </ul>
      )}

      <p>
        <a class="danger" href={`/admin/questions/${question.id}/delete`}>
          Delete Question
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
    <Layout title="Delete Question">
      <AdminNav active="/admin/questions" session={session} />

      <ConfirmForm
        action={`/admin/questions/${question.id}/delete`}
        buttonText="Delete Question"
        label="Question text"
        name={question.text}
      >
        <h1>Delete Question</h1>
        <Flash error={error} />
        <p>
          This will permanently delete the question, all its answers, and all
          attendee responses.
        </p>
        <p>
          To delete this question, type its text "{question.text}" into the box
          below:
        </p>
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
    <Layout title="Delete Answer">
      <AdminNav active="/admin/questions" session={session} />

      <ConfirmForm
        action={`/admin/questions/${question.id}/answers/${answer.id}/delete`}
        buttonText="Delete Answer"
        label="Answer text"
        name={answer.text}
      >
        <h1>Delete Answer</h1>
        <Flash error={error} />
        <p>
          This will permanently delete the answer "{answer.text}" from the
          question "{question.text}" and remove all attendee responses for it.
        </p>
        <p>
          To delete this answer, type its text "{answer.text}" into the box
          below:
        </p>
      </ConfirmForm>
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
      <AdminNav active="/admin/" session={session} />

      <h1>Questions for {event.name}</h1>
      <Flash error={error} />

      {allQuestions.length === 0 ? (
        <p>
          No questions created yet.{" "}
          <a href="/admin/questions">Create questions</a> first.
        </p>
      ) : (
        <CsrfForm action={`/admin/event/${event.id}/questions`}>
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
          <button type="submit">Save</button>
        </CsrfForm>
      )}
      <p>
        <a href="/admin/questions">Manage Questions</a>
      </p>
    </Layout>,
  );
