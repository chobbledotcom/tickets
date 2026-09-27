# Plan: attendee answers in registration email templates

Status: implemented on branch `email-answers-in-templates`. The sections below
are the approved contract. Two things the build taught, recorded so the plan
stays true to the shipped code: the answers save BEFORE the free path queues its
notification (the notification reads them the moment it is queued), and the
choice-answer read is pinned to the primary for the same reason
(`choiceAnswerIdsPrimary` in db/questions/attendee-answers/reads.ts). The
`checkout_pending_answers` staging covers every provider through the shared
checkout-session factory (`makeCreateCheckoutSession`), so no SumUp-specific
carry exists.

## Current-system value

The buyer confirmation email and the admin registration email cannot show the
buyer's answers to custom questions. The operator must open the admin listing
page to read them. The buyer gets no confirmation that their answers were saved.

Production paths that change:

- `sendRegistrationEmails` (src/shared/email/registration.ts), reached from
  `logAndNotifyRegistration` (src/shared/webhook/delivery.ts), which every
  booking path calls: the free web path, the payment completion, the
  folded-booking API, and the admin resend.
- `buildTemplateData` and `TemplateEntry` (src/shared/email-renderer.ts).
- The default templates (src/ui/templates/email/defaults.ts).
- The template variable reference shown on the advanced-settings form and in the
  admin guide (src/ui/templates/components/email-template-reference.tsx).

## What ships

1. Every template entry gains `entry.attendee.answers`: an ordered list of
   `{ question: string, text: string }` pairs, one per question assigned to that
   entry's listing that the attendee answered.
2. The default admin template renders each entry's answers.
3. The default confirmation template renders the buyer's answers.
4. Both choice answers and free-text answers appear, on every send path.

## Trusted facts

- Question text and choice-answer text are encrypted with `DB_ENCRYPTION_KEY`
  (symmetric). Every request can read them.
- Choice answer ids per attendee are plaintext in `attendee_answers`.
- Free-text answer strings are sealed to the owner public key. Decryption needs
  a session-derived private key.
- The buyer's contact block already travels through provider metadata as
  plaintext and returns on the webhook. This includes `special_instructions`, an
  arbitrary free-text textarea capped at 250 characters so that it fits provider
  metadata. So no rule of this site keeps buyer-typed text out of the checkout
  round-trip.
- Free-text question answers allow up to 10 240 characters. Provider metadata
  accepts at most 500 characters per value (Square 255, and only 10 entries).
  This size gap is the reason answers were interned to string ids.
- SumUp carries no provider metadata. The repo stages the whole booking metadata
  for SumUp in a sealed local table keyed by the checkout reference
  (src/shared/db/sumup-checkouts.ts). A checkout-scoped local copy is an
  established shape here.

## Valid states after the change

- An entry whose listing asks questions the attendee answered: `answers` lists
  them in the operator's question order. A choice question lists the chosen
  answer's text. A free-text question lists the typed text.
- An entry whose listing asks none, or an attendee who answered none: `answers`
  is an empty list. Template loops render nothing. The default templates render
  no answers section.
- The buyer confirmation's collapsed package row (a hidden package's members
  concealed behind one synthetic row): `answers` is empty. The row must not
  reveal what it conceals.
- The same question answered on more than one listing: each entry carries its
  own row, so the admin email shows which booking each answer belongs to.

## Commands and events

One new write beside checkout creation, and one read plus delete at completion:

- Checkout creation stores the order's free-text answers in a
  `checkout_pending_answers` row, sealed with `DB_ENCRYPTION_KEY`, keyed by the
  HMAC of the provider checkout session id. The raw session id never rests in
  the database: for SumUp it is the checkout reference, and that reference must
  stay absent so the `sumup_checkouts` rows cannot be unwrapped from a dump. The
  row holds the same question-id-to-text pairs the buyer just typed. The strings
  table keeps its owner-sealed copy, unchanged.
- The payment completion saves the booking's answers first, then reads that row
  and deletes it, and hands the texts to the notification path beside the
  entries. A save that fails leaves the staged row in place.
- The free web path hands the texts straight from the request.
- The admin resend decrypts the strings table with the session key, the same way
  the attendees table reads free text today.
- Choice answers load from the database with the existing batch readers
  (`getQuestionsWithListingIds`, `getAttendeeAnswersBatch` with
  `{ texts: false }`).

## Failure table

| Work completed   | Failure                                              | Required result                                                                                                                                   | Retry owner                                   |
| ---------------- | ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------- |
| Nothing          | Question or answer read fails                        | The email send fails loudly, as contact-field sends already do                                                                                    | The existing registration failure reporting   |
| Nothing          | A question's text fails to decrypt                   | Same. No silent omission                                                                                                                          | Same                                          |
| Checkout created | No pending row at completion                         | The email renders choice answers and omits free text. Square links never expire, so a late payment can outlive the row; the miss is logged loudly | No retry                                      |
| Answers loaded   | Custom operator template does not use the new fields | Unchanged rendering. New fields are additive                                                                                                      | None                                          |
| Answers saved    | The take's read-and-delete fails                     | The row stays and the completion fails loudly; a redelivery retries it, and the admin resend can rebuild the email from the strings table         | The provider's redelivery or the admin resend |
| Row taken        | The send fails                                       | That one email lacks free text. The strings table still holds every answer, and the admin resend can rebuild it. No data is lost                  | The admin resend                              |

## Retry and replay table

- A replayed webhook for an already-processed session does not notify again. The
  existing already-processed path returns before any send.
- A send that fails after the row was deleted loses free text in that email
  only. The strings table still holds every answer, the admin interface still
  shows it, and the admin resend can rebuild it. No data is lost.
- Abandoned checkouts never complete. The pruning that already sweeps stale
  reservations also sweeps `checkout_pending_answers` rows older than the
  payments retention cutoff, which covers provider retry windows and Square
  links that never expire.

## Concurrency table

| Operation A                     | Operation B                     | Required result                                     | Protection                                                               |
| ------------------------------- | ------------------------------- | --------------------------------------------------- | ------------------------------------------------------------------------ |
| Staged row written              | Webhook completion reads it     | One read, one delete                                | Session id is unique. The row exists before the checkout URL is returned |
| Webhook replay after completion | Nothing to read                 | No second send                                      | The already-processed guard runs first                                   |
| Stale row pruning               | Completion of the same checkout | The row is young enough that pruning cannot race it | The prune cutoff exceeds any checkout lifetime                           |

## Security and privacy

- The buyer confirmation carries the buyer's own answers to the buyer. Same
  posture as name, email, phone, address, and special instructions today.
- The admin notification carries them to the configured business address. Same
  posture as the contact fields today.
- The staged row is sealed with `DB_ENCRYPTION_KEY`, lives only while a checkout
  is open, and is deleted or pruned after. For Stripe and Square this is
  stronger than the contact block, which rests at the provider in plaintext.
- The strings table keeps free text sealed to the owner key. No at-rest sealing
  changes.

## Balance and renewal payments

A balance or renewal payment asks no new questions, so no row is staged for it.
Its confirmation email renders the attendee's choice answers from the database
(the ids and the answer text are readable without the owner key) and omits free
text. The buyer's original confirmation email carried the full answers. This is
stated in the variable reference.

## Reference surfaces that must stay in step

- `TEMPLATE_VARIABLES` and `LOOP_EXAMPLE` in
  src/ui/templates/components/email-template-reference.tsx, plus the message
  keys they name (src/locales/en/).
- The contract test test/shared/email-renderer/variable-reference.test.ts, which
  pins the reference to the runtime `TemplateData` shape.
- The guide that consumes the reference (src/ui/templates/admin/guide/).

## Tests that prove each row

- template-data.test.ts: answers per entry, empty list, collapse hides member
  answers, question order, choice text resolution, free-text merge.
- whole-email.test.ts: default admin and confirmation templates render an
  answers section, escaped in HTML, nothing rendered when no answers.
- The staged row: written at creation, read and deleted at completion, swept by
  pruning, sealed at rest.
- variable-reference contract test: the new variables appear in both the
  reference and `TemplateData`.

## PR shape

One pull request on branch `email-answers-in-templates`:

- Commit 1: `TemplateEntry` answers, defaults, reference, contract test.
- Commit 2: the staged `checkout_pending_answers` row and its threading.

Issue #2364 (months read as tickets) stays open. It was reviewed and split out
of this pull request by owner decision.
