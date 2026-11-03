---------------------------- MODULE InvoiceFlow ----------------------------
EXTENDS Integers, ModelRules, InvoiceFlowData

\* An invoice is a bill for one attendee. An operator creates it from a Liquid
\* template, and the rendered body is frozen. An invoice number identifies the
\* invoice and is unique. A status is new, cancelled, or paid. A new invoice is
\* also called open. An attendee owes money when the ledger balance is unpaid.
\* A share link lets the buyer read one invoice without a session.
\*
\* The bad outcomes are two open invoices for one attendee, a closed invoice
\* that returns to open, and a status that contradicts the action that caused
\* it. For example, an operator cancels invoice 1 while invoice 2 is open, then
\* creates invoice 3. That must not leave two open invoices. The first example
\* number is 1 and the second is 2. They are two invoice identities for one
\* attendee, not two attendees or two sites.
\*
\* This module names one model. EXTENDS imports integer rules, the shared
\* verdict helper in ModelRules, and generated facts from the Data module.
\* A fact records one production result for a finite example. It is not a live
\* row or an amount. == defines a named expression, not an assignment. A prime
\* marks the value after a step. The checker explores permitted steps, not a
\* fixed workflow.
\*
\* The claim: every reachable state keeps at most one open invoice for the
\* attendee, and every applied fact agrees with the action that produced it.
\* scripts/verify-models/invoice-flow.ts supplies Attempts. Each fact runs a
\* production statement on a fresh copy of the production schema. A create
\* runs the insert that the create form stores, so the partial unique index on
\* an attendee's open invoice gives the refusal. A cancel runs
\* cancelInvoiceStatement. A settle runs markOpenInvoicesPaidStatement, whose
\* guard compares the ledger balance with the amount being settled. Both live
\* in src/shared/db/invoices.ts. The schema comes from
\* src/shared/db/migrations/schema/tables-invoices.ts.
\* The facts cover an open invoice on either number, a cancelled invoice, a
\* paid invoice, and a closed invoice beside the open one. They do not cover
\* every amount, every number, or a balance that a later charge changes.
\* The model assumes one attendee pays the whole balance and that the settle
\* guard hides the ledger expression behind a constant. Concurrent creates,
\* SQL rollback, provider truth, and eventual delivery stay outside it. The
\* database tests at the unique index and the settle transaction own them.

\* The statuses are stored text. The first invoice number is 1 and the second
\* is 2. Absent means the table holds no row for that number.
VARIABLES
  \* The status stored at invoice number 1. New is open, cancelled and paid
  \* are closed. Absent means no row.
  \* @type: Str;
  firstInvoice,
  \* The status stored at invoice number 2, with the same meanings.
  \* @type: Str;
  secondInvoice,
  \* TRUE means every applied fact passed its verdicts. FALSE remembers one
  \* failed fact so a later good fact cannot hide it. This is model-only
  \* memory, not an application column.
  \* @type: Bool;
  allAttemptsSafe

\* Str permits any text. Safety below restricts each status to a listed value.
TypeOK ==
  /\ firstInvoice \in InvoiceStatuses
  /\ secondInvoice \in InvoiceStatuses
  /\ allAttemptsSafe \in BOOLEAN

\* A status of new is open. A later payment or cancel closes it.
\* @type: (Str) => Bool;
IsOpen(status) == status = "new"

\* The current status at one invoice number.
\* @type: (Int) => Str;
StatusAt(slot) == IF slot = 1 THEN firstInvoice ELSE secondInvoice

\* The current status at the other invoice number.
\* @type: (Int) => Str;
StatusElsewhere(slot) == IF slot = 1 THEN secondInvoice ELSE firstInvoice

\* The count of open invoices on the two numbers. The law allows at most one.
OpenCount ==
  (IF IsOpen(firstInvoice) THEN 1 ELSE 0) +
  (IF IsOpen(secondInvoice) THEN 1 ELSE 0)

\* Each field is a true/false producer check, not a stored column. A refusal
\* must keep the stored status. An accepted action must reach its own target.
\* The other invoice number must keep its status. The action's acceptance must
\* agree with its guard. safe retains the combined verdict.
\* @type: ($attemptsFact) => Bool;
SafeAttempt(attempt) ==
  /\ attempt.acceptedCorrect
  /\ attempt.otherKept
  /\ attempt.statusAfterCorrect
  /\ attempt.safe

\* Safety is the full set of conditions that must remain true. The first check
\* asks whether Init satisfies Safety. The second asks whether one Next step
\* from any abstract safe state preserves Safety. Together they cover any
\* finite sequence of these abstract steps, not every production input.
Safety ==
  /\ TypeOK
  /\ OpenCount <= 1
  /\ allAttemptsSafe

\* Init is a fresh attendee with no invoice row, not a seed read. A real
\* attendee can start with a closed invoice, which the facts supply as steps.
Init ==
  /\ firstInvoice = "absent"
  /\ secondInvoice = "absent"
  /\ allAttemptsSafe = TRUE

\* \E selects any fact whose before status matches the current status at its
\* number. A create fact also needs the other number's real state, so a stale
\* refusal cannot hide a second open invoice. The named number takes the stored
\* status after the attempt, and the other number stays as it was.
\* ChecksStillPass keeps a failed verdict visible after a later good fact.
\* One step applies one fact. It does not model a batch or two requests at once.
AttemptStep ==
  \E attempt \in Attempts :
    /\ StatusAt(attempt.slot) = attempt.statusBefore
    /\ (attempt.kind = "create" =>
          attempt.otherNew = IsOpen(StatusElsewhere(attempt.slot)))
    /\ firstInvoice' =
         IF attempt.slot = 1 THEN attempt.statusAfter ELSE firstInvoice
    /\ secondInvoice' =
         IF attempt.slot = 2 THEN attempt.statusAfter ELSE secondInvoice
    /\ allAttemptsSafe' = ChecksStillPass(allAttemptsSafe, SafeAttempt(attempt))

\* \/ means "or". Next permits a fact or a pause with no change. No rule
\* requires a create, a cancel, a settle, or a delete. This checks safety, not
\* that an invoice eventually closes. A delete removes a row, so the model
\* represents it as absent and gives it no separate step.
Next ==
  AttemptStep \/
  UNCHANGED <<firstInvoice, secondInvoice, allAttemptsSafe>>

=============================================================================
