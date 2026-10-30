---------------------------- MODULE NotificationFlagLease ----------------------------
EXTENDS Integers, ModelRules, NotificationFlagLeaseData

\* One recovery claims an attendee's pending-notification flags before it
\* sends. The claim captures each outstanding flag's colour and zeroes the
\* flag. The restore returns the captured colour, so the badge keeps saying
\* what is owed. A clear-on-accept removes the owed work. Two racing
\* recoveries contend for the flags, and the claim transaction lets only
\* one capture them.
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
  \* @type: Bool;
  worker1Held,
  \* @type: Bool;
  worker2Held,
  \* @type: Bool;
  allFactsSafe

TypeOK ==
  /\ storedEmail \in 0..2
  /\ storedWebhooks \in 0..2
  /\ emailLeased \in BOOLEAN
  /\ webhooksLeased \in BOOLEAN
  /\ emailCaptured \in 0..2
  /\ webhooksCaptured \in 0..2
  /\ worker1Held \in BOOLEAN
  /\ worker2Held \in BOOLEAN
  /\ allFactsSafe \in BOOLEAN

\* A claim captures a side exactly when the side is outstanding. A claim
\* that zeroes an up flag without capturing it breaks the rule.
\* @type: ($claimFactsFact) => Bool;
ClaimValueCaptured(fact) ==
  /\ fact.claimsEmail <=> fact.beforeEmail > 0
  /\ fact.claimsWebhooks <=> fact.beforeWebhooks > 0

\* A restore writes back exactly the colour the lease captured. A restore
\* that invents a different colour breaks the rule.
\* @type: ($restoreFactsFact) => Bool;
RestoreWritesCaptured(fact) ==
  /\ (emailLeased => fact.emailValue = emailCaptured)
  /\ (webhooksLeased => fact.webhooksValue = webhooksCaptured)

\* A leased side keeps a captured colour the restore data can return, and a
\* side with no lease keeps no captured colour.
LeaseKeepsCaptured ==
  /\ (emailLeased =>
       \E fact \in RestoreFacts : fact.emailValue = emailCaptured)
  /\ (webhooksLeased =>
       \E fact \in RestoreFacts : fact.webhooksValue = webhooksCaptured)
  /\ (~emailLeased => emailCaptured = 0)
  /\ (~webhooksLeased => webhooksCaptured = 0)

\* A live lease keeps both flags zeroed, so a send that never ran still
\* reads as owed once the restore returns the captured colours.
SendStaysOwed ==
  (emailLeased \/ webhooksLeased) =>
    /\ storedEmail = 0
    /\ storedWebhooks = 0

\* A recovery holds only a live lease. A held flag with no lease would let
\* a second claim add a holder beside it.
WorkerHoldsLease ==
  /\ (worker1Held => emailLeased \/ webhooksLeased)
  /\ (worker2Held => emailLeased \/ webhooksLeased)

\* Two racing recoveries: only one holds the lease.
OneWinner == ~(worker1Held /\ worker2Held)

Safety ==
  /\ TypeOK
  /\ LeaseKeepsCaptured
  /\ SendStaysOwed
  /\ WorkerHoldsLease
  /\ OneWinner
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
  /\ worker1Held = FALSE
  /\ worker2Held = FALSE
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
    /\ worker1Held' =
         IF fact.worker = "w1" /\ (fact.claimsEmail \/ fact.claimsWebhooks)
         THEN TRUE ELSE worker1Held
    /\ worker2Held' =
         IF fact.worker = "w2" /\ (fact.claimsEmail \/ fact.claimsWebhooks)
         THEN TRUE ELSE worker2Held
    /\ allFactsSafe' = ChecksStillPass(allFactsSafe, ClaimValueCaptured(fact))

\* A restore returns the claimed sides to the colours the claim captured.
\* The release keeps the badge's who-owes-this colour after a refused or
\* failed send. The restore resolves the whole lease at once.
RestoreStep ==
  \E fact \in RestoreFacts :
    /\ emailLeased \/ webhooksLeased
    /\ storedEmail' = IF emailLeased THEN fact.emailValue ELSE storedEmail
    /\ storedWebhooks' =
         IF webhooksLeased THEN fact.webhooksValue ELSE storedWebhooks
    /\ emailLeased' = FALSE
    /\ webhooksLeased' = FALSE
    /\ emailCaptured' = 0
    /\ webhooksCaptured' = 0
    /\ worker1Held' = FALSE
    /\ worker2Held' = FALSE
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
    /\ worker1Held' =
         IF fact.side = "email" THEN
           IF webhooksLeased THEN worker1Held ELSE FALSE
         ELSE
           IF emailLeased THEN worker1Held ELSE FALSE
    /\ worker2Held' =
         IF fact.side = "email" THEN
           IF webhooksLeased THEN worker2Held ELSE FALSE
         ELSE
           IF emailLeased THEN worker2Held ELSE FALSE
    /\ allFactsSafe' = allFactsSafe

Next ==
  ClaimStep \/ RestoreStep \/ ClearStep \/
  UNCHANGED <<storedEmail, storedWebhooks, emailLeased, webhooksLeased,
             emailCaptured, webhooksCaptured, worker1Held, worker2Held,
             allFactsSafe>>

InductionStart == Safety
=============================================================================
