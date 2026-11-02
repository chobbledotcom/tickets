-------------------------- MODULE TwoWorkers --------------------------
\* This module describes the possible states of one refund claim.
\* EXTENDS imports integer arithmetic and generated example decisions.
EXTENDS Integers, TwoWorkersData

\* A payment provider is the outside service that charges or refunds money.
\* A refund run is one attempt by this application to return a payment.
\* A worker is the code that performs that attempt, not a member of staff.
\* A payment row is a stored record that the run must claim before its work.
\* The claim records which refund command currently has permission to proceed.
\* A command id identifies that refund attempt. A phase names its current task.
\* Here "checking" is the phase whose row transition the producer exercises.
\*
\* A lease is the time for which the application treats the claim as live.
\* An expired lease permits another run to take over the same attendee work.
\* w1 and w2 name two example runs. They are not actual worker or customer ids.
\* Both request attendee id 7, so each can resume the other's expired work.
\* Different command ids and write times let the checker tell their claims apart.
\*
\* Example: w1 pauses after a provider request. Its lease expires and w2 takes over.
\* When w1 returns, it must not clear or overwrite w2's claim.
\* Expiry changes permission. It does not stop w1's code or outside request.
\* The model does not represent the returned money or the provider request itself.
\*
\* scripts/verify-models/two-workers.ts generates TwoWorkersData.
\* TakeFacts uses decideClaim and holdsTheRow in src/shared/payment/claim.ts.
\* SettleFacts uses settledRowState and claimHeldBy in
\* src/shared/payment/row-transitions.ts. Each test fence changes at most
\* one claim field. A fence is the claim identity that a run must still hold.
\* WorkerFenceFacts describes the claim that each run writes.
\*
\* The domain has two runs for the same attendee set and selected timestamps.
\* storedOwner and the worker flags are model records, not database columns.
\* The steps explore event order, not real SQL races or provider requests.
\* The model assumes the selected cutoffs mean live or expired as stated.
\* Safety does not establish that a run finishes or that a refund occurs once.
VARIABLES
  \* The run whose claim the row represents, or "none" for no claim.
  \* @type: Str;
  storedOwner,
  \* The stored refund command identity. Empty when the row has no claim.
  \* @type: Str;
  storedCommandId,
  \* The claim's write timestamp, treated as an identity string here.
  \* @type: Str;
  storedWrittenAt,
  \* The stored claim phase. The producer writes "checking" for both runs.
  \* @type: Str;
  storedPhase,
  \* Whether the abstract lease has expired. No clock runs in this model.
  \* @type: Bool;
  storedClaimStale,
  \* w1 acquired a claim and has not released it through an accepted settle.
  \* This flag can remain true after w2 replaces w1's expired claim.
  \* @type: Bool;
  worker1Held,
  \* The same record for w2. Both flags can be true with only one stored owner.
  \* @type: Bool;
  worker2Held

\* These are the allowed value shapes, not the complete business rules.
\* Name == expression defines a condition, not an assignment or database write.
\* \in means "is a member of". BOOLEAN contains TRUE and FALSE.
TypeOK ==
  /\ storedOwner \in {"none"} \cup Workers
  /\ storedCommandId \in CommandIds \cup {""}
  /\ storedWrittenAt \in WrittenAts \cup {""}
  /\ storedPhase \in Phases \cup {""}
  /\ storedClaimStale \in BOOLEAN
  /\ worker1Held \in BOOLEAN
  /\ worker2Held \in BOOLEAN

\* No owner requires empty claim fields. An owner requires that run's claim.
\* \A checks every worker. \E requires at least one matching claim record.
\* => means "if the left condition holds, the right condition must hold".
ClaimFieldsConsistent ==
  /\ (storedOwner = "none" =>
        /\ storedCommandId = ""
        /\ storedWrittenAt = ""
        /\ storedPhase = "")
  /\ \A worker \in Workers :
       (storedOwner = worker =>
          \E fence \in WorkerFenceFacts :
            /\ fence.worker = worker
            /\ storedCommandId = fence.commandId
            /\ storedWrittenAt = fence.writtenAt
            /\ storedPhase = fence.phase)

\* The stored owner must have acquired a claim that it has not released.
\* The converse is not required: a replaced run can still have its flag set.
\* These flags do not establish which provider requests remain in flight.
OwnerHolds ==
  /\ (storedOwner = "w1" => worker1Held)
  /\ (storedOwner = "w2" => worker2Held)

\* Every accepted settle fact must match all fields of the stored claim.
\* A settle means that a run records its result and releases its claim.
\* This rule checks fact decisions, even before the model chooses a step.
SettleFenceIsExact ==
  \A fact \in SettleFacts :
    fact.accepted =>
      /\ fact.storedOwner = fact.fenceWorker
      /\ fact.storedCommandId = fact.fenceCommandId
      /\ fact.storedWrittenAt = fact.fenceWrittenAt
      /\ fact.storedPhase = fact.fencePhase

\* Every accepted take must see no claim or an expired claim.
\* A live claim must refuse another take, even from the same run.
TakeAdmitsOnlyAbsentOrExpired ==
  \A fact \in TakeFacts :
    fact.admitted => (fact.existingOwner = "none" \/ fact.existingClaimStale)

\* Safety names the conditions that must all remain true.
\* The checker first checks Init. It then takes one Next step from any state
\* that satisfies Safety. Together these checks cover every finite sequence
\* of the supplied abstract steps. They do not execute the actual refund path.
\* /\ joins conditions with "and".
Safety ==
  /\ TypeOK
  /\ ClaimFieldsConsistent
  /\ OwnerHolds
  /\ SettleFenceIsExact
  /\ TakeAdmitsOnlyAbsentOrExpired

\* Start before either run obtains a claim, not before payment creation.
Init ==
  /\ storedOwner = "none"
  /\ storedCommandId = ""
  /\ storedWrittenAt = ""
  /\ storedPhase = ""
  /\ storedClaimStale = FALSE
  /\ worker1Held = FALSE
  /\ worker2Held = FALSE

\* One run tries to take the row through a matching production decision.
\* \E lets the checker choose any fact that matches the current conditions.
\* An accepted take replaces the claim and sets that run's acquired flag.
\* A refusal leaves all values unchanged.
\* A prime means the value after this step: storedOwner' is the next owner.
TakeStep ==
  \E fact \in TakeFacts :
    /\ fact.existingOwner = storedOwner
    /\ fact.existingClaimStale = storedClaimStale
    /\ storedOwner' = IF fact.admitted THEN fact.worker ELSE storedOwner
    /\ storedCommandId' = IF fact.admitted THEN fact.newCommandId ELSE storedCommandId
    /\ storedWrittenAt' = IF fact.admitted THEN fact.newWrittenAt ELSE storedWrittenAt
    /\ storedPhase' = IF fact.admitted THEN fact.newPhase ELSE storedPhase
    /\ storedClaimStale' = IF fact.admitted THEN FALSE ELSE storedClaimStale
    /\ worker1Held' =
         IF fact.admitted /\ fact.worker = "w1" THEN TRUE ELSE worker1Held
    /\ worker2Held' =
         IF fact.admitted /\ fact.worker = "w2" THEN TRUE ELSE worker2Held

\* One run tries to release the claim under its command, time, and phase.
\* The stored fields select the relevant facts. Only an accepted fact clears
\* the claim and the requesting run's flag. A refusal changes no value.
\* An old run's acquired flag alone does not authorise a release.
SettleStep ==
  \E fact \in SettleFacts :
    /\ fact.storedCommandId = storedCommandId
    /\ fact.storedWrittenAt = storedWrittenAt
    /\ fact.storedPhase = storedPhase
    /\ storedOwner' = IF fact.accepted THEN "none" ELSE storedOwner
    /\ storedCommandId' = IF fact.accepted THEN "" ELSE storedCommandId
    /\ storedWrittenAt' = IF fact.accepted THEN "" ELSE storedWrittenAt
    /\ storedPhase' = IF fact.accepted THEN "" ELSE storedPhase
    /\ storedClaimStale' = storedClaimStale
    /\ worker1Held' =
         IF fact.accepted /\ fact.fenceWorker = "w1" THEN FALSE ELSE worker1Held
    /\ worker2Held' =
         IF fact.accepted /\ fact.fenceWorker = "w2" THEN FALSE ELSE worker2Held

\* The current lease becomes expired without a real clock or elapsed duration.
\* ~ means "not". UNCHANGED keeps each value in the <<...>> tuple the same.
\* Expiry does not clear ownership or cancel a provider request in flight.
LeaseExpiry ==
  /\ ~storedClaimStale
  /\ storedClaimStale' = TRUE
  /\ UNCHANGED <<storedOwner, storedCommandId, storedWrittenAt, storedPhase,
                 worker1Held, worker2Held>>

\* \/ offers alternative steps, rather than a fixed sequence of instructions.
\* The checker considers any step whose conditions permit it.
\* The final alternative permits no change. No rule requires a run to proceed.
Next ==
  TakeStep \/ SettleStep \/ LeaseExpiry \/
  UNCHANGED <<storedOwner, storedCommandId, storedWrittenAt, storedPhase,
              storedClaimStale, worker1Held, worker2Held>>

=============================================================================
