module VatLedger {
  import VatLedgerData.* from "./VatLedgerData"

  /// Production assess, reassess, and refund functions supply every attempted
  /// edge. Settings range independently of the active or refunded booking
  /// state. Equality facts compare concrete assessments, fixed bases, and
  /// revisions before abstraction. Arithmetic scope: represented minor-unit
  /// samples, not arbitrary numbers. This model does not prove SQL atomicity,
  /// provider truth, or legal VAT compliance.
  var bookingState: str
  var allAttemptsSafe: bool

  /// The declared state and the carried verdict are both well formed.
  pure def typeOK: bool =
    bookingState.in(VatStates) and allAttemptsSafe.in(Set(false, true))

  /// Every law that one attempted edge must keep.
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

  pure def safety: bool = typeOK and allAttemptsSafe

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

  action vatStep: bool = {
    nondet attempt = VatAttempts.oneOf()
    all {
      attempt.sourceState == bookingState,
      bookingState' = attempt.targetState,
      allAttemptsSafe' = (allAttemptsSafe and safeAttempt(attempt)),
    }
  }

  action step: bool = any {
    vatStep,
    all {
      bookingState' = bookingState,
      allAttemptsSafe' = allAttemptsSafe,
    },
  }
}
