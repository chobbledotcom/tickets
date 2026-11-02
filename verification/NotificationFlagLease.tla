---------------------------- MODULE NotificationFlagLease ----------------------------
EXTENDS Integers, ModelRules, NotificationFlagLeaseData

\* This module describes one attendee's unpaid work, not unpaid money. An
\* attendee is the customer record that holds a buyer's booked places. A
\* notification is a message the application owes after that customer books.
\* Email means the buyer's confirmation email. Webhooks are registration
\* messages sent to external URLs set for the booked listings. A listing is
\* an item that a customer can book. These two message types are separate sides.
\* A stored flag is a small integer that says a send is still due. This is
\* notification debt. A positive value also remembers the booking's origin,
\* not a message count or a priority. The admin badge displays that origin.
\* A delivery worker is application code that attempts the external send.
\* A recovery is an admin retry of owed work. A claim reserves that work. It
\* sets stored flags to zero and remembers their old values. This temporary
\* responsibility is the lease. Capture means remember the exact old value.
\* Restore puts that value back when a send does not run or fails. Clear
\* resolves the debt after external acceptance, not proof that a buyer read it.
\*
\* MODULE names this specification. EXTENDS imports integer rules, the shared
\* verdict helper in ModelRules, and generated facts in the Data module.
\* A fact is a record of one producer result for a finite example. It is not
\* a live database event. == defines a named expression, not an assignment.
\* A condition describes one state. An action relates current values to
\* next values marked with a prime. The checker explores allowed choices,
\* not a fixed sequence that the application executes.
\* A recovery must keep a notification debt visible after a failed
\* send. For example, an admin email flag has colour 2. A restore of colour 1
\* turns its orange badge red and loses its origin.
\* scripts/verify-models/notification-flag-lease.ts supplies the Data module.
\* claimFacts reconstructs the positive-flag rule. It does not execute a claim.
\* restoreValueFor reads an argument from restorePendingFlagStatement, and
\* clearFacts constructs clearPendingFlagStatement without a database write.
\* Those builders and claimOutstandingNotificationFlags live in
\* src/shared/db/attendees/notification-flags.ts.
\* The finite case has one attendee, two workers, email colour 2 and webhook
\* colour 1. Zero means no stored debt. 1 means online. 2 means admin-added.
\* The model assumes an atomic claim read/write and an accepted external send.
\* It does not prove transaction isolation, attendee existence, SQL guards,
\* restore ownership, provider acceptance, or eventual delivery.
 
\* The stored fields below represent SQL flags. The lease, captured value
\* and holder fields are model memory, not SQL columns. A lease has no clock
\* or automatic expiry. No money or elapsed-time unit appears in this model.
VARIABLES
  \* The email_pending value. Zero is no stored email debt, 1 is online
  \* origin in red, and 2 is admin-added origin in orange.
  \* @type: Int;
  storedEmail,
  \* The webhooks_pending value, with the same zero, red and orange meanings.
  \* @type: Int;
  storedWebhooks,
  \* TRUE means a claim holds unresolved email work despite its zero SQL flag.
  \* @type: Bool;
  emailLeased,
  \* TRUE means a claim holds unresolved webhook work.
  \* @type: Bool;
  webhooksLeased,
  \* The email colour remembered at claim time. Zero means no email lease.
  \* @type: Int;
  emailCaptured,
  \* The webhook colour remembered at claim time. Zero means no webhook lease.
  \* @type: Int;
  webhooksCaptured,
  \* The abstract worker name for the email lease, or "none" without a lease.
  \* @type: Str;
  emailHolder,
  \* The abstract worker name for the webhook lease, or "none" without a lease.
  \* @type: Str;
  webhooksHolder,
  \* TRUE means every fact used so far passed. FALSE remembers any failure.
  \* @type: Bool;
  allFactsSafe


\* w1 and w2 name two distinct recovery callers, not actual worker IDs or
\* stored owners. Two callers expose a repeated claim after the first claim.
Workers == {"w1", "w2"}

\* Membership (\in) bounds flag values and holder names for this abstraction.
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

\* Each positive before-value must have a captured side. <=> means both ways:
\* a zero flag must not create a lease, and a positive flag must not disappear.
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

\* A lease must retain a positive captured colour and some matching restore
\* fact. \E means at least one fact exists. It does not promise a restore runs.
\* No lease means no captured colour.
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

\* A live lease keeps its stored flag zero. Its captured colour retains the
\* debt in model memory until a restore or an accepted send resolves it.
SendStaysOwed ==
  /\ (emailLeased => storedEmail = 0)
  /\ (webhooksLeased => storedWebhooks = 0)

\* A live lease and a non-empty holder name must coincide. One scalar holder
\* cannot represent two owners. SQL race safety is an assumption, not this law.
LeaseHasOneHolder ==
  /\ (emailLeased <=> emailHolder # "none")
  /\ (webhooksLeased <=> webhooksHolder # "none")

\* Safety is the condition that must remain true in every allowed state.
\* The initial check asks whether Init implies Safety. The inductive check
\* asks whether any Safety state and one Next step preserve Safety, even
\* for states not reached from Init. This proves abstract safety for these
\* facts, not all production inputs.
Safety ==
  /\ TypeOK
  /\ LeaseKeepsCaptured
  /\ SendStaysOwed
  /\ LeaseHasOneHolder
  /\ allFactsSafe

\* Init defines the abstract start, not a database read. One representative
\* attendee has an admin-added email debt and an online webhook debt. The
\* different colours expose a restore that returns a fixed wrong colour.
\* Real flags need not have this particular mixture of origins.
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

\* A claim fact must match both stored flags. A prime names the next value.
\* The step zeroes both flags and captures each positive side for that worker.
\* A claim at zero wins nothing and preserves any prior lease. There is no
\* separate refusal event. ChecksStillPass retains a false verdict forever.
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

\* A restore needs at least one named side with a live lease. It writes that
\* side's fact colour and clears its lease, capture and holder. Unnamed sides
\* stay as they were. The rule checks the captured colour, not caller identity.
\* With no named live side this action has no enabled fact.
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

\* A clear needs a positive flag or a live lease on its named side. It zeroes
\* that side and removes its lease memory. The other side stays as it was.
\* This abstracts an accepted send. It does not observe an external service.
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

\* Next defines the permitted state changes, not a delivery schedule.
\* UNCHANGED permits a step with no value change. No rule requires eventual
\* worker progress, so a claim, restore or clear need never occur and debt
\* can persist. Safety does not establish eventual delivery.
Next ==
  ClaimStep \/ RestoreStep \/ ClearStep \/
  UNCHANGED <<storedEmail, storedWebhooks, emailLeased, webhooksLeased,
             emailCaptured, webhooksCaptured, emailHolder, webhooksHolder,
             allFactsSafe>>

=============================================================================
