---------------------------- MODULE VatLedger ----------------------------
EXTENDS ModelRules, VatLedgerData

\* /\ requires every listed condition. \E selects at least one supplied
\* example. A prime in an action marks the next value, not the current value.
\* Type annotations describe value shapes for the checker.
\* This module names one model. EXTENDS imports shared rules and generated
\* facts. VAT is value added tax. A booking is the sale for an attendee,
\* the person with a reservation. A listing is an item offered for sale.
\* A tax assessment is the saved calculation for that sale. It retains the
\* original listed amounts, price adjustments, tax policy, tax amount,
\* adjusted lines and final total. The basis excludes fees and payments.
\* Amounts use integer minor currency units, such as pence, not pounds.
\* A policy states no tax, tax added to the price, or tax within the price.
\* Rates use basis points. 100 basis points mean one per cent.
\* A revision is a version count, not money. It rejects a save from an old form.
\* active permits a new calculation on save. refunded closes the assessment
\* but keeps its amounts and policy. It does not itself send a refund.
\* For example, a later tax setting alone leaves an earlier sale unchanged.
\*
\* == defines a named expression. It is not an assignment. TypeOK and
\* Safety test the current state. VatStep relates current and next values
\* through AttemptedEdge. That helper keeps a failed check false thereafter.
\* Init describes allowed starts. Next describes allowed steps, not a script
\* the application must execute. The checker chooses among supplied examples.
\* The initial check asks whether Init satisfies Safety. The inductive check
\* asks whether each step from any abstract safe state preserves Safety.
\* Together these checks cover any finite sequence within this abstraction.
\*
\* Keep a recorded tax assessment stable until an explicit save or refund.
\* For example, a new VAT setting must not rewrite a past refunded sale.
\* scripts/verify-models/vat.ts: vatModel executes TAX_EVENTS over TAX_NODES
\* from src/shared/tax/machine-spec.ts. Those events call reassessTax and
\* refundTax in src/shared/tax/transitions.ts. Initial assessments come from
\* assessTax in src/shared/tax/assessment.ts.
\* VatLedgerData supplies state names, initial arithmetic verdicts and every
\* attempted event, with concrete equality tests before state abstraction.
\* The domain pairs four small minor-unit bases, seven policies and revisions
\* zero and two with active/refunded states. Settings vary independently.
\* Successful Init and one-step induction establish abstract safety for these
\* facts at any finite run length, not all prices or production inputs.
\* SQL atomicity, provider truth, eventual completion and legal VAT compliance
\* remain outside this model. The assessment expectation reuses assessTax.
\* validVatAssessment supplies a separate small-number arithmetic check.
VARIABLES
  \* This state says whether the sale's saved tax assessment remains active
  \* or has closed as refunded. Neither label measures a provider payment.
  \* @type: Str;
  bookingState,
  \* This model-only flag retains any failed initial or transition verdict.
  \* @type: Bool;
  allAttemptsSafe

\* Membership (\in) restricts the state to generated names and the flag to a Boolean.
TypeOK == bookingState \in VatStates /\ allAttemptsSafe \in BOOLEAN

\* Each field is a true/false producer check, not an amount or a stored column.
\* Arithmetic checks totals, tax, allocations and identity on the small bases.
\* The basis stays fixed. Only a setting event changes the current policy.
\* Accepted saves use the current setting. Refunds retain the assessment.
\* Revisions change only for accepted refunds or active saves with a new policy.
\* Refunded sales stay terminal. Stale revisions must refuse without mutation.
\* Events declare no provider money call. safe also retains the combined verdict.
\* @type: ($vatAttemptsFact) => Bool;
SafeAttempt(attempt) ==
  /\ attempt.arithmetic
  /\ attempt.basisKept
  /\ attempt.settingCorrect
  /\ attempt.revisionCorrect
  /\ attempt.assessmentCorrect
  /\ attempt.terminal
  /\ attempt.refusalCorrect
  /\ attempt.noProviderCall
  /\ attempt.safe

Safety == TypeOK /\ allAttemptsSafe
\* Safety requires valid state types and no failed verdict anywhere in the run.

\* Start with an active sale, but check every generated initial assessment,
\* even those for refunded representatives. \A means every member must pass.
Init ==
  /\ bookingState = "active"
  /\ allAttemptsSafe = (\A sample \in VatInitial : sample.safe)

\* Choose any supplied attempt with this source state. \E means at least one.
\* AttemptedEdge applies its target even if unsafe and retains the verdict.
\* A refused event remains an edge, so a refused mutation can violate Safety.
VatStep ==
  \E attempt \in VatAttempts :
    /\ attempt.sourceState = bookingState
    /\ AttemptedEdge(bookingState, attempt.targetState, SafeAttempt(attempt), allAttemptsSafe)

\* Next permits a production attempt or a pause with both variables unchanged.
\* No rule forces progress. A pause is also called a stutter step.
Next == VatStep \/ UNCHANGED <<bookingState, allAttemptsSafe>>

=============================================================================
