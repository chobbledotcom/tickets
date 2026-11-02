module VatLedger {
  import VatLedgerData.* from "./VatLedgerData"

  /// VAT is value added tax. A booking is the sale for an attendee, the person
  /// with a reservation. A listing is an item offered for sale. A tax
  /// assessment is the saved calculation for that sale. It retains the
  /// original listed amounts, price adjustments, tax policy, tax amount,
  /// adjusted lines and final total. The basis excludes fees and payments.
  /// Amounts use integer minor currency units, such as pence, not pounds.
  /// A policy states no tax, tax added to the price, or tax within the price.
  /// Rates use basis points. 100 basis points mean one per cent.
  /// A revision is a version count, not money. It rejects a save from an old
  /// form.
  ///
  /// The bad outcome is a rewritten saved assessment. For example, a later tax
  /// setting alone must leave an earlier sale unchanged. A new VAT setting must
  /// not rewrite a past refunded sale.
  ///
  /// scripts/verify-models/vat.ts runs TAX_EVENTS over TAX_NODES from
  /// src/shared/tax/machine-spec.ts. Those events call reassessTax and
  /// refundTax in src/shared/tax/transitions.ts. Initial assessments come from
  /// assessTax in src/shared/tax/assessment.ts. VatLedgerData supplies the state
  /// names, the initial arithmetic verdicts and every attempted event, with
  /// concrete equality tests before state abstraction.
  ///
  /// An action describes one possible step, not a program that runs its steps
  /// in order. A prime names the value after a step. `nondet` chooses one
  /// supplied fact. `all` requires every listed condition and `any` accepts one.
  ///
  /// This state says whether the sale's saved tax assessment remains active or
  /// has closed as refunded. Neither label measures a provider payment.
  var bookingState: str

  /// This model-only flag keeps any failed initial or transition verdict. It is
  /// model evidence, not application data.
  var allAttemptsSafe: bool

  /// The state name and the retained verdict are both well formed. A name
  /// outside VatStates or a missing verdict is a type fault, not a business
  /// fault.
  pure def typeOK: bool =
    bookingState.in(VatStates) and allAttemptsSafe.in(Set(false, true))

  /// Each field is a true/false producer check, not an amount or a stored
  /// column. Arithmetic checks totals, tax, allocations and identity on the
  /// small bases. The basis stays fixed. Only a setting event changes the
  /// current policy. Accepted saves use the current setting. Refunds retain the
  /// assessment. Revisions change only for accepted refunds or active saves with
  /// a new policy. Refunded sales stay terminal. Stale revisions must refuse
  /// without mutation. Events declare no provider money call. safe also keeps
  /// the combined verdict.
  pure def safeAttempt(attempt: VatAttempt): bool =
    attempt.arithmetic and
    attempt.basisKept and
    attempt.settingCorrect and
    attempt.revisionCorrect and
    attempt.assessmentCorrect and
    attempt.terminal and
    attempt.refusalCorrect and
    attempt.noProviderCall and
    attempt.safe

  /// Safety requires valid state types and no failed verdict anywhere in the
  /// run. The init check asks whether `init` satisfies safety. The step check
  /// asks whether one step from any safe state keeps safety.
  pure def safety: bool = typeOK and allAttemptsSafe

  /// Start with an active sale, but check every generated initial assessment,
  /// even those for refunded representatives. `forall` means every member must
  /// pass.
  action init: bool = all {
    bookingState' = "active",
    allAttemptsSafe' = VatInitial.forall(sample => sample.safe),
  }

  /// The step check starts here. Every state that satisfies safety has a
  /// declared booking state and a true verdict, so this action covers all of
  /// them, not only the states that init reaches.
  action safetyInit: bool = {
    nondet state = VatStates.oneOf()
    all {
      bookingState' = state,
      allAttemptsSafe' = true,
    }
  }

  /// Choose any supplied attempt with this source state. The attempt applies
  /// its target even if it is unsafe and keeps the verdict. A refused event
  /// remains an edge, so a refused mutation can violate safety.
  action vatStep: bool = {
    nondet attempt = VatAttempts.oneOf()
    all {
      attempt.sourceState == bookingState,
      bookingState' = attempt.targetState,
      allAttemptsSafe' = (allAttemptsSafe and safeAttempt(attempt)),
    }
  }

  /// A step permits a production attempt or a pause with both variables
  /// unchanged. No rule forces progress. A pause is also called a stutter step.
  action step: bool = any {
    vatStep,
    all {
      bookingState' = bookingState,
      allAttemptsSafe' = allAttemptsSafe,
    },
  }
}
