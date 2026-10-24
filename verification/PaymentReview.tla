--------------------------- MODULE PaymentReview ---------------------------
EXTENDS PaymentReviewData

\* Scope: one review slot, not row settlement, authorization, transaction
\* atomicity, or a promise that an operator review eventually resolves.
\* Nodes retain both the actual acknowledgement state and the actual reason.
\* Attempts contain source, event, target, representative tag, accepted,
\* actual case-id equality, and actual reason equality, in that order.
\* A thrown slot event is a refusal; a successful no-op is still accepted.

VARIABLES
  \* @type: Str;
  review,
  \* @type: Bool;
  attemptsSafe

TypeOK ==
  /\ review \in ReviewStates
  /\ attemptsSafe \in BOOLEAN

\* These are properties of observed outcomes, never enabling guards.
\* Every held-to-held outcome must keep the exact case and reason.
\* An acknowledgement holds the case, advances unseen to seen, and cannot
\* succeed again. Only the held reason's own evidence can retire its case.
\* @type: (<<Str, Str, Str, Str, Bool, Bool, Bool>>) => Bool;
SafeAttempt(a) ==
  \E before \in ReviewNodes, after \in ReviewNodes, event \in ReviewEvents :
    /\ before[1] = a[1]
    /\ after[1] = a[3]
    /\ event[1] = a[2]
    /\ ~event[4]
    /\ IF a[5]
       THEN /\ ((before[2] /\ after[2]) => (a[6] /\ a[7]))
            /\ CASE event[2] = "open" ->
                      /\ ~before[2]
                      /\ after[2]
                      /\ ~after[3]
                      /\ after[4] = event[3]
                 [] event[2] = "acknowledge" ->
                      /\ before[2]
                      /\ ~before[3]
                      /\ after[2]
                      /\ after[3]
                 [] event[2] = "retire" ->
                      /\ before[2]
                      /\ before[4] = event[3]
                      /\ ~after[2]
                 [] OTHER -> FALSE
       ELSE /\ a[1] = a[3]
            /\ a[6]
            /\ a[7]

Safety == TypeOK /\ attemptsSafe

Init ==
  /\ review = "none"
  /\ attemptsSafe = TRUE

\* Refused attempts also execute. A bad observed move remains reachable and
\* falsifies the monitor, rather than being removed by a safety-shaped guard.
ReviewStep ==
  \E attempt \in ReviewAttempts :
    /\ attempt[1] = review
    /\ review' = attempt[3]
    /\ attemptsSafe' = (attemptsSafe /\ SafeAttempt(attempt))

Next == ReviewStep \/ UNCHANGED <<review, attemptsSafe>>

\* The base case and the unrestricted one-step induction establish Safety
\* for every length. No bounded exploration is substituted for induction.
InductionStart == Safety
=============================================================================
