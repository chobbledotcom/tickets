# Plan: answers in emails, and answers at booking for admins

Status: approved by the owner.

This plan replaces PR #2421. That branch grew from about 550 to about 2,200
source lines. It added three tables, two triggers, three scheduled tasks, and a
new required secret. The owner decided these points before this plan:

1. Emails show the current answers, not the wording at booking.
2. Staged free text is sealed with `DB_ENCRYPTION_KEY`. There is no
   `CHECKOUT_WORK_KEY`.
3. Durable email delivery and the resumable paid tail are out of scope. Issue
   #2423 holds the tail. Issue #2428 holds email retries.
4. The work starts again on a fresh branch from `main`.

## Current-system value

- The buyer confirmation email and the admin notification email show the answers
  the buyer gave.
- The attendee page shows every answer, free text included. Today it shows only
  choice answers.
- The attendee page, the edit form, and the listing attendee table show which
  answers are different from the answers at booking.

Production paths that change:

- `sendRegistrationEmails` (`src/shared/email/registration.ts`) through
  `logAndNotifyRegistration` (`src/shared/webhook/delivery.ts`). The free web
  path, the payment completion, and the admin resend call it.
- `buildTemplateData` and `TemplateEntry` (`src/shared/email-renderer.ts`), the
  default templates, and the template variable reference.
- Checkout creation for Stripe, Square, and SumUp.
- `saveSessionAnswers` (`src/features/api/payment-processing/create.ts`) and
  `handleFreePath` (`src/features/public/ticket-submit/paths.ts`).
- The attendee page (`src/features/admin/attendee-page.ts`), the attendee edit
  form, and the listing attendee table (`src/ui/templates/attendee-table/`).

## Trusted facts

- Question text and choice text are sealed with `DB_ENCRYPTION_KEY`. Every
  request can read them.
- Choice answer ids per attendee are plain in `attendee_answers`.
- Free text is sealed to the owner public key in `strings`. Only a signed-in
  owner or manager session can read it.
- The contact block, `special_instructions` included, goes through provider
  metadata as plaintext. So a buyer's typed text already leaves the site at
  checkout.
- Free text allows up to 10,240 characters. Provider metadata allows 500
  characters for each value (Square allows 255). For this reason checkout sends
  string ids, not text.
- A webhook proves the payment. It does not carry free text.

## Part 1: answers in emails

### What ships

- Every template entry gets `entry.attendee.answers`. This is a list of
  `{ question, text }`, one for each question that the booked listing asks and
  the attendee answered, in the question order of the operator.
- The default admin template names the listing beside each answer. The default
  confirmation template prints each answer.
- The collapsed row of a hidden package lists every answer, without member
  listing names.
- Every answer is escaped in HTML.

### Where each answer comes from

All paths read the current answers with one reader. Choice answers come from
`attendee_answers`. Free text comes from the plaintext that the sender holds:

| Send path            | Free text source                                              |
| -------------------- | ------------------------------------------------------------- |
| Free web booking     | The request that took the booking                             |
| Paid completion      | The staged row for the checkout (below)                       |
| Admin resend         | `strings`, opened with the session key of the owner           |
| Balance or renewal   | None. The email lists choice answers and leaves out free text |
| Staged row not found | None. Same as above, and the site logs a warning              |

The variable reference states the last two rows.

### The staged row

- Table `checkout_answers`: `session_index` (HMAC of the checkout session id,
  primary key), `sealed` (JSON of question id to text, sealed with
  `DB_ENCRYPTION_KEY`), `created` (ISO time).
- The shared checkout builder writes the row after the provider accepts the
  checkout and before the buyer gets the URL. The builder writes nothing when
  the order has no free text.
- The paid completion reads the row after it saves the answers. It deletes the
  row after the notification step.
- The prune sweep deletes rows older than `PRUNE_PAYMENTS_RETENTION_MS`.
- The HMAC key keeps the raw SumUp checkout reference out of the database.

## Part 2: answers at booking

### What ships

- Table `answers_at_booking` records the questions that the booked listings
  asked, and the answer to each, at the moment of the booking.
- The attendee page lists every answer, free text included. A row that differs
  from the booking shows a note under the answer.
- The attendee edit form shows "Changed. At booking: X." under a field that
  differs.
- The listing attendee table marks a changed answer cell with "(changed)".

### The record

| Column            | Content                                                |
| ----------------- | ------------------------------------------------------ |
| `attendee_id`     | The attendee                                           |
| `question_id`     | The question                                           |
| `question_text`   | Copy of `questions.text` ciphertext                    |
| `answer_id`       | The chosen answer, or NULL                             |
| `answer_text`     | Copy of `answers.text` ciphertext, NULL with no choice |
| `free_text`       | Copy of `strings.encrypted_text` ciphertext, or NULL   |
| `free_text_index` | Copy of `strings.text_index`, NULL with no free text   |

- A unique index on `(attendee_id, question_id)`.
- A CHECK makes `answer_id` and `answer_text` both NULL or both set. A second
  CHECK refuses a row with both a choice and free text.
- The write copies ciphertext in one `INSERT ... SELECT`. It needs no key and no
  plaintext, so the webhook can write it.
- The copy does not point at `strings`, so it needs no `used_count` trigger. A
  later prune of an unused string cannot remove it.
- The write uses `ON CONFLICT DO NOTHING`, so a replay changes nothing.
  `INSERT OR IGNORE` is not used, because it also hides a CHECK failure.
- Free text compares by `free_text_index`, the one-way index of the text. So the
  table marker needs no key.

### Which bookings record it

- The free web path and the paid completion record it, in the same transaction
  as the answer save.
- A booking with no answers still records one row for each question asked, with
  no answer. So "left blank at booking" is a fact, not a guess.
- The admin edit form, a merge, a servicing record, and a restore after a failed
  edit do not write it.
- A booking from before this change has no rows. The site shows its answers with
  no notes. The site cannot recover the lost facts, so no migration fills it.

### Which questions count as asked

The record statement decides it in SQL: every `assign_all` question, and every
question assigned to the booked listing. A choice question with no active answer
does not count, because the form did not show it. A question with a saved answer
always counts.

### Valid states for one question on one attendee

A pure function compares the record with the current answers. It returns one
state from this union:

| State              | Condition                                          | What the admin reads                                     |
| ------------------ | -------------------------------------------------- | -------------------------------------------------------- |
| `no-record`        | The attendee has no rows                           | The answer, with no note                                 |
| `same`             | Same answer id, or same free text                  | The answer, with no note                                 |
| `changed`          | A different answer, or a new or blank one          | "Changed. At booking: X." or "At booking: no answer."    |
| `reworded`         | Same answer, but the question or answer was edited | "When they booked, the question said: X."                |
| `question-deleted` | A row exists, but the question does not            | The wording at booking, and "This question was deleted." |

If a `changed` row touches an answer with a price modifier, the page adds:
"Warning: This answer changes the price. The price was not updated." An admin
edit does not change the price, so the note tells the admin to fix it.

## Commands and events

| Starting state          | Command or event            | Required result                                        |
| ----------------------- | --------------------------- | ------------------------------------------------------ |
| Checkout form submitted | Provider accepts checkout   | Staged row written, then the URL goes to the buyer     |
| Staged row              | Payment webhook             | Answers saved and recorded, emails sent, row deleted   |
| Staged row              | No payment for 90 days      | Prune deletes the row                                  |
| Free form submitted     | Booking committed           | Answers saved and recorded, emails sent                |
| Recorded attendee       | Admin edits answers         | `attendee_answers` changes, the record does not        |
| Recorded attendee       | Admin resends the email     | The email shows the current answers                    |
| Recorded attendee       | Operator deletes a question | Current answer goes, record row stays                  |
| Recorded attendee       | Attendee deleted            | Record rows deleted (`dependent-data.ts` rule)         |
| Two attendees           | Merge                       | Target keeps its rows, source rows deleted with source |

## Failure table

| Work completed    | Failure                     | Required result                                       | Retry owner  |
| ----------------- | --------------------------- | ----------------------------------------------------- | ------------ |
| Provider checkout | Staged row write fails      | Checkout error to the buyer. No URL, so no payment    | The buyer    |
| Booking committed | Answer save or record fails | As on `main` today. Issue #2423 holds the fix         | #2423        |
| Answers saved     | Staged row not found        | Email without free text. The site logs a warning      | Admin resend |
| Answers saved     | Email send fails            | As on `main` today. #2428 holds email retries         | Admin resend |
| Email sent        | Staged row delete fails     | Prune deletes it after 90 days                        | Prune        |
| Nothing           | A question does not decrypt | Throw. The key protects all data, so the site is down | None         |

The Square link without an expiry is a known limit. A buyer who pays after 90
days gets an email without free text. The booking and the answers are complete.

## Retry and replay table

- A replayed webhook for a processed session returns before any send, as on
  `main`.
- The record write is `INSERT OR IGNORE` on `(attendee_id, question_id)`.
- The staged row is keyed by the session. Only the one completion that holds the
  session claim reads it.
- The prune is a bounded delete that any run can repeat.

## Concurrency table

| Operation A        | Operation B            | Required result                  | Protection                               |
| ------------------ | ---------------------- | -------------------------------- | ---------------------------------------- |
| Staged row write   | Webhook for that order | Row exists first                 | The buyer gets the URL only after write  |
| Two webhook copies | Same session           | One completion                   | The existing session claim               |
| Prune              | Late completion        | Email without free text, warning | None needed. The failure table covers it |

## Owner choices

None. The four decisions at the top are recorded.

## Security and privacy

- The buyer email carries the answers of the buyer to the buyer. The admin email
  carries them to the business address. This matches the contact fields today.
- The staged row holds free text under `DB_ENCRYPTION_KEY` for at most 90 days.
  Stripe and Square hold the contact block in plaintext for longer.
- `answers_at_booking` keeps free text sealed to the owner key, as `strings`
  does. Only a signed-in session reads it.
- An admin who clears a free-text answer does not remove the booking copy. The
  delete of the attendee removes it.
- The attendee page and the edit form already require an admin session. The new
  notes add no links.

## Pull requests

A stack of two pull requests. The harder slice is at the bottom.

| Layer | Value                                     | Estimated source lines |
| ----- | ----------------------------------------- | ---------------------- |
| 1     | Admins see every answer, and what changed | about 400              |
| 2     | Emails show the answers                   | about 400              |

Layer 1 adds the shared rule for asked questions. Layer 2 uses that rule in the
email reader. This plan rides on layer 1, and a commit removes it before the
stack merges.

Database budget for each paid completion: one staged row read, one staged row
delete, and one statement added to the answer save transaction. The answers load
for an email costs a fixed number of reads for the whole order.

## Tests that prove each row

- `answers_at_booking`: the free path and the paid path record the asked
  questions, blank ones included. A replay changes nothing. An admin edit leaves
  the record alone. A question delete keeps the row. An attendee delete removes
  it.
- The compare function: a table-driven test for each state in the union, and the
  price-modifier warning.
- The attendee page: free text shown, each note shown, and no note for
  `no-record`.
- The edit form and the listing table: the "At booking" hint and the "(changed)"
  mark.
- Template data: answers for each entry, empty list, question order, the
  collapsed package row, and free text from each source in the table.
- The default templates: an answers section, escaped in HTML, and no section
  with no answers.
- The staged row: written for each provider, sealed and keyed by HMAC at rest,
  read and deleted at completion, pruned at 90 days, and a warning when it is
  not found.
- The variable reference contract test.

## Built: layer 1

The code is now the authority for this layer. These files hold it:

| Concern                     | Where                                                                                                      |
| --------------------------- | ---------------------------------------------------------------------------------------------------------- |
| Table and migration         | `answers_at_booking` in `schema/tables-questions.ts`, `2026-09-28_answers_at_booking`                      |
| Record write and reads      | `saveBookedAnswers`, `getBookedAnswers`, `attendeesWithChangedAnswers` in `attendee-answers/at-booking.ts` |
| Booking paths               | `saveSessionAnswers` (paid) and `handleFreePath` (free) call `saveBookedAnswers`                           |
| Compare and notes           | `answerNote`, `answerRows`, `atBookingHints` in `templates/admin/answer-rows.ts`                           |
| Attendee page and edit form | `AttendeeAnswersTable`, `EditQuestions`, `loadQuestionsForExisting`                                        |
| Listing table marker        | `getAnswerDisplay` in `attendee-table/values.ts`                                                           |

Where the build differs from the plan above:

- An answer to a question that the booking did not ask counts as changed. The
  note reads "Changed. At booking: no answer."
- A paid booking with no answers now costs five database calls, not four. The
  fifth call records the questions that the booking asked.
