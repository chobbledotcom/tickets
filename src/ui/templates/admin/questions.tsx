/**
 * Admin question management templates
 */

import { map } from "#fp";
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
    <Layout title="Custom Questions">
      <AdminNav active="/admin/questions" session={session} />

      <h1>Custom Questions</h1>
      <p class="actions">
        <GuideLink href="/admin/guide#questions">Questions guide</GuideLink>
      </p>
      <Flash error={error} />

      <CsrfForm action="/admin/questions" id="new-question">
        <Raw html={questionTextForm.render()} />
        <SubmitButton icon="plus">Add Question</SubmitButton>
      </CsrfForm>

      {questions.length === 0 ? (
        <p>
          <em>No custom questions yet.</em>
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
        <SubmitButton icon="save">Update</SubmitButton>
      </CsrfForm>

      <h2>Answer Options</h2>
      <CsrfForm
        action={`/admin/questions/${question.id}/answers`}
        id="add-answer"
      >
        <Raw html={answerTextForm.render()} />
        <SubmitButton icon="plus">Add Answer</SubmitButton>
      </CsrfForm>

      {question.answers.length === 0 ? (
        <p>
          <em>No answers yet. Add at least 2 answer options.</em>
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
                Delete
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

      <h1>Questions for {listing.name}</h1>
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
          <SubmitButton icon="save">Save</SubmitButton>
        </CsrfForm>
      )}
      <p>
        <a href="/admin/questions">Manage Questions</a>
      </p>
    </Layout>,
  );
