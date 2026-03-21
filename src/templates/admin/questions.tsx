/**
 * Admin question management templates
 */

import { map } from "#fp";
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
    <Layout title="Custom Questions">
      <AdminNav session={session} active="/admin/questions" />
      <Breadcrumb href="/admin" label="Dashboard" />

      <h1>Custom Questions</h1>
      <Raw html={renderError(error)} />

      <CsrfForm action="/admin/questions" id="new-question">
        <label>
          New Question
          <input
            type="text"
            name="text"
            required
            placeholder="e.g. What is your T-shirt size?"
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
): string =>
  String(
    <Layout title={`Question: ${question.text}`}>
      <AdminNav session={session} active="/admin/questions" />
      <Breadcrumb href="/admin/questions" label="Questions" />

      <h1>{question.text}</h1>
      <Raw html={renderError(error)} />

      <CsrfForm action={`/admin/questions/${question.id}/edit`}>
        <label>
          Question Text
          <input type="text" name="text" required value={question.text} />
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
          <input type="text" name="text" required placeholder="e.g. Medium" />
        </label>
        <button type="submit">Add Answer</button>
      </CsrfForm>

      {question.answers.length === 0 ? (
        <p>
          <em>No answers yet. Add at least 2 answer options.</em>
        </p>
      ) : (
        <ul class="answer-list">
          {map((a: Answer) => (
            <li>
              {a.text}
              <a
                href={`/admin/questions/${question.id}/answers/${a.id}/delete`}
                class="danger small"
              >
                Delete
              </a>
            </li>
          ))(question.answers)}
        </ul>
      )}

      <p>
        <a href={`/admin/questions/${question.id}/delete`} class="danger">
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
      <AdminNav session={session} active="/admin/questions" />
      <Breadcrumb
        href={`/admin/questions/${question.id}`}
        label={question.text}
      />

      <h1>Delete Question</h1>
      <Raw html={renderError(error)} />

      <article>
        <aside>
          <p>
            This will permanently delete the question, all its answers, and all
            attendee responses.
          </p>
        </aside>
      </article>

      <p>
        To delete this question, type its text "{question.text}" into the box
        below:
      </p>

      <CsrfForm action={`/admin/questions/${question.id}/delete`}>
        <label for="confirm_identifier">Question text</label>
        <input
          type="text"
          id="confirm_identifier"
          name="confirm_identifier"
          placeholder={question.text}
          autocomplete="off"
          required
        />
        <button type="submit" class="danger">
          Delete Question
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
    <Layout title="Delete Answer">
      <AdminNav session={session} active="/admin/questions" />
      <Breadcrumb
        href={`/admin/questions/${question.id}`}
        label={question.text}
      />

      <h1>Delete Answer</h1>
      <Raw html={renderError(error)} />

      <article>
        <aside>
          <p>
            This will permanently delete the answer "{answer.text}" from the
            question "{question.text}" and remove all attendee responses for it.
          </p>
        </aside>
      </article>

      <p>
        To delete this answer, type its text "{answer.text}" into the box below:
      </p>

      <CsrfForm
        action={`/admin/questions/${question.id}/answers/${answer.id}/delete`}
      >
        <label for="confirm_identifier">Answer text</label>
        <input
          type="text"
          id="confirm_identifier"
          name="confirm_identifier"
          placeholder={answer.text}
          autocomplete="off"
          required
        />
        <button type="submit" class="danger">
          Delete Answer
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

      <h1>Questions for {event.name}</h1>
      <Raw html={renderError(error)} />

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
                type="checkbox"
                name="question_ids"
                value={String(q.id)}
                checked={assignedIds.has(q.id) || undefined}
              />
              {` ${q.text}`}
              <small>
                {" "}
                ({q.answers.length} option{q.answers.length !== 1 ? "s" : ""})
              </small>
            </label>
          ))(allQuestions)}
          <button type="submit">Save</button>
        </CsrfForm>
      )}
    </Layout>,
  );
