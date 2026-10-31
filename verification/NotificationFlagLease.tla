---------------------------- MODULE NotificationFlagLease ----------------------------
EXTENDS Integers, ModelRules, NotificationFlagLeaseData

\* One recovery claims an attendee's pending-notification flags before it
\* sends. The claim captures each outstanding flag's colour and zeroes the
\* flag. A restore returns the sides it names to their captured colours, so
\* the badge keeps saying what is owed. A clear-on-accept removes the owed
\* work. Two racing recoveries contend for the flags, and the claim
\* transaction lets only one capture them.
\* The claim's read and write are one step. SQL races, statement batching
\* and attendee existence are outside scope.
VARIABLES
  \* @type: Int;
  storedEmail,
  \* @type: Int;
  storedWebhooks,
  \* @type: Bool;
  emailLeased,
  \* @type: Bool;
  webhooksLeased,
  \* @type: Int;
  emailCaptured,
  \* @type: Int;
  webhooksCaptured,
  \* @type: Str;
  emailHolder,
  \* @type: Str;
  webhooksHolder,
  \* @type: Bool;
  allFactsSafe

Workers == {"w1", "w2"}

TypeOK ==
  /\ storedEmail \in 0..2
  /\ storedWebhooks \in 0..2
  /\ emailLeased \in BOOLEAN
  /\ webhooksLeased \in BOOLEAN
  /\ emailCaptured \in 0..2
  /\ webhooksCaptured \in 0..2
  /\ emailHolder \in {"none"} \cup Workers
  /\ webhooksHolder \in {"none"} \cup Workers
  /\ allFactsSafe \in BOOLEAN

\* A claim captures a side exactly when the side is outstanding. A claim
\* that zeroes an up flag without capturing it breaks the rule.
\* @type: ($claimFactsFact) => Bool;
ClaimValueCaptured(fact) ==
  /\ fact.claimsEmail <=> fact.beforeEmail > 0
  /\ fact.claimsWebhooks <=> fact.beforeWebhooks > 0

\* A restore writes back exactly the colour the lease captured, for each
\* side it names. A restore that invents a different colour breaks the rule.
\* @type: ($restoreFactsFact) => Bool;
RestoreWritesCaptured(fact) ==
  /\ (fact.returnsEmail /\ emailLeased =>
        fact.emailValue = emailCaptured)
  /\ (fact.returnsWebhooks /\ webhooksLeased =>
        fact.webhooksValue = webhooksCaptured)

\* A leased side keeps a real captured colour. Some restore fact names the
\* side and can return that colour. A side with no lease keeps no captured
\* colour.
LeaseKeepsCaptured ==
  /\ (emailLeased =>
       /\ emailCaptured > 0
       /\ \E fact \in RestoreFacts :
            /\ fact.returnsEmail
            /\ fact.emailValue = emailCaptured)
  /\ (webhooksLeased =>
       /\ webhooksCaptured > 0
       /\ \E fact \in RestoreFacts :
            /\ fact.returnsWebhooks
            /\ fact.webhooksValue = webhooksCaptured)
  /\ (~emailLeased => emailCaptured = 0)
  /\ (~webhooksLeased => webhooksCaptured = 0)

\* A side with a live lease keeps its flag zeroed, so a send that never ran
\* still reads as owed once the restore returns its captured colour.
SendStaysOwed ==
  /\ (emailLeased => storedEmail = 0)
  /\ (webhooksLeased => storedWebhooks = 0)

\* A live lease has one holder, and a holder holds a live lease. Two racing
\* recoveries claim exactly once, and the winner is the side's holder.
LeaseHasOneHolder ==
  /\ (emailLeased <=> emailHolder # "none")
  /\ (webhooksLeased <=> webhooksHolder # "none")

Safety ==
  /\ TypeOK
  /\ LeaseKeepsCaptured
  /\ SendStaysOwed
  /\ LeaseHasOneHolder
  /\ allFactsSafe

\* The representative attendee: an admin-added email line and an online
\* webhooks line, each waiting for its first send.
Init ==
  /\ storedEmail = 2
  /\ storedWebhooks = 1
  /\ emailLeased = FALSE
  /\ webhooksLeased = FALSE
  /\ emailCaptured = 0
  /\ webhooksCaptured = 0
  /\ emailHolder = "none"
  /\ webhooksHolder = "none"
  /\ allFactsSafe = TRUE

\* A recovery claims the attendee's flags. The claim reads the two flags,
\* captures every outstanding colour and zeroes both flags in one
\* transaction. A racing claim that finds nothing outstanding captures
\* nothing and wins nothing.
ClaimStep ==
  \E fact \in ClaimFacts :
    /\ storedEmail = fact.beforeEmail
    /\ storedWebhooks = fact.beforeWebhooks
    /\ storedEmail' = 0
    /\ storedWebhooks' = 0
    /\ emailLeased' = IF fact.claimsEmail THEN TRUE ELSE emailLeased
    /\ emailCaptured' = IF fact.claimsEmail THEN fact.beforeEmail ELSE emailCaptured
    /\ webhooksLeased' = IF fact.claimsWebhooks THEN TRUE ELSE webhooksLeased
    /\ webhooksCaptured' =
         IF fact.claimsWebhooks THEN fact.beforeWebhooks ELSE webhooksCaptured
    /\ emailHolder' = IF fact.claimsEmail THEN fact.worker ELSE emailHolder
    /\ webhooksHolder' =
         IF fact.claimsWebhooks THEN fact.worker ELSE webhooksHolder
    /\ allFactsSafe' = ChecksStillPass(allFactsSafe, ClaimValueCaptured(fact))

\* A restore returns the sides it names to the colours the claim captured.
\* The press restores the sides it withholds and keeps the rest claimed. A
\* settled send restores the sides that did not clear. A side the restore
\* does not name stays leased.
RestoreStep ==
  \E fact \in RestoreFacts :
    /\ ((fact.returnsEmail /\ emailLeased) \/
        (fact.returnsWebhooks /\ webhooksLeased))
    /\ storedEmail' =
         IF fact.returnsEmail /\ emailLeased THEN fact.emailValue
         ELSE storedEmail
    /\ storedWebhooks' =
         IF fact.returnsWebhooks /\ webhooksLeased THEN fact.webhooksValue
         ELSE storedWebhooks
    /\ emailLeased' =
         IF fact.returnsEmail /\ emailLeased THEN FALSE ELSE emailLeased
    /\ webhooksLeased' =
         IF fact.returnsWebhooks /\ webhooksLeased THEN FALSE
         ELSE webhooksLeased
    /\ emailCaptured' =
         IF fact.returnsEmail /\ emailLeased THEN 0 ELSE emailCaptured
    /\ webhooksCaptured' =
         IF fact.returnsWebhooks /\ webhooksLeased THEN 0
         ELSE webhooksCaptured
    /\ emailHolder' =
         IF fact.returnsEmail /\ emailLeased THEN "none" ELSE emailHolder
    /\ webhooksHolder' =
         IF fact.returnsWebhooks /\ webhooksLeased THEN "none"
         ELSE webhooksHolder
    /\ allFactsSafe' = ChecksStillPass(allFactsSafe, RestoreWritesCaptured(fact))

\* A clear-on-accept removes the owed work for one side. A side whose flag
\* is up reads as cleared. A claimed side whose send accepted resolves its
\* lease, so the flag stays down as done, not owed.
ClearStep ==
  \E fact \in ClearFacts :
    /\ (fact.side = "email" => storedEmail > 0 \/ emailLeased)
    /\ (fact.side = "webhooks" => storedWebhooks > 0 \/ webhooksLeased)
    /\ storedEmail' = IF fact.side = "email" THEN 0 ELSE storedEmail
    /\ storedWebhooks' = IF fact.side = "webhooks" THEN 0 ELSE storedWebhooks
    /\ emailLeased' = IF fact.side = "email" THEN FALSE ELSE emailLeased
    /\ webhooksLeased' = IF fact.side = "webhooks" THEN FALSE ELSE webhooksLeased
    /\ emailCaptured' = IF fact.side = "email" THEN 0 ELSE emailCaptured
    /\ webhooksCaptured' = IF fact.side = "webhooks" THEN 0 ELSE webhooksCaptured
    /\ emailHolder' = IF fact.side = "email" THEN "none" ELSE emailHolder
    /\ webhooksHolder' =
         IF fact.side = "webhooks" THEN "none" ELSE webhooksHolder
    /\ allFactsSafe' = allFactsSafe

Next ==
  ClaimStep \/ RestoreStep \/ ClearStep \/
  UNCHANGED <<storedEmail, storedWebhooks, emailLeased, webhooksLeased,
             emailCaptured, webhooksCaptured, emailHolder, webhooksHolder,
             allFactsSafe>>

InductionStart == Safety
=============================================================================
