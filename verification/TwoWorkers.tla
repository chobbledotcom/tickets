-------------------------- MODULE TwoWorkers --------------------------
EXTENDS Integers, TwoWorkersData

\* Two runs contend for one payment row. The row stores at most one claim,
\* built from the owner run's command id, write time and phase. A run that
\* fell behind must not release or overwrite the claim of the run that
\* replaced it. Command identity, claim time and phase stay separate
\* comparison facts, and the production claim and row transition functions
\* supply every decision.
VARIABLES
  \* @type: Str;
  storedOwner,
  \* @type: Str;
  storedCommandId,
  \* @type: Str;
  storedWrittenAt,
  \* @type: Str;
  storedPhase,
  \* @type: Bool;
  storedClaimStale,
  \* @type: Bool;
  worker1Held,
  \* @type: Bool;
  worker2Held

TypeOK ==
  /\ storedOwner \in {"none", "w1", "w2"}
  /\ storedCommandId \in CommandIds \cup {""}
  /\ storedWrittenAt \in WrittenAts \cup {""}
  /\ storedPhase \in Phases \cup {""}
  /\ storedClaimStale \in BOOLEAN
  /\ worker1Held \in BOOLEAN
  /\ worker2Held \in BOOLEAN

\* The stored claim is exactly the owner run's written claim, or nothing.
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

\* A claim on the row means its owner is still working under it. The run that
\* lost the row can still be mid-flight: it is stale, but it holds no claim.
OwnerHolds ==
  /\ (storedOwner = "w1" => worker1Held)
  /\ (storedOwner = "w2" => worker2Held)

\* A settle releases the row only when every claim component matches the fence.
\* The facts change at most one component at a time, so a fence that omits any
\* one of command, time or phase never clears the stored claim.
SettleFenceIsExact ==
  \A fact \in SettleFacts :
    fact.accepted =>
      /\ fact.storedOwner = fact.fenceWorker
      /\ fact.storedCommandId = fact.fenceCommandId
      /\ fact.storedWrittenAt = fact.fenceWrittenAt
      /\ fact.storedPhase = fact.fencePhase

\* A take replaces the stored claim only on an absent or expired claim, never
\* on a live claim another run holds.
TakeAdmitsOnlyAbsentOrExpired ==
  \A fact \in TakeFacts :
    fact.admitted => (fact.existingOwner = "none" \/ fact.existingClaimStale)

Safety ==
  /\ TypeOK
  /\ ClaimFieldsConsistent
  /\ OwnerHolds
  /\ SettleFenceIsExact
  /\ TakeAdmitsOnlyAbsentOrExpired

Init ==
  /\ storedOwner = "none"
  /\ storedCommandId = ""
  /\ storedWrittenAt = ""
  /\ storedPhase = ""
  /\ storedClaimStale = FALSE
  /\ worker1Held = FALSE
  /\ worker2Held = FALSE

\* A run takes the row. The claim decision comes from the production claim
\* function, and the replacement claim is exactly the run's written claim.
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

\* A run settles the row under one fence. Only an exact hold releases the
\* claim; every other fence leaves the row unchanged, so a stale run cannot
\* clear the replacement claim.
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

\* Enough time passes that the stored claim reads as expired. Lease expiry
\* never cancels a provider request that is already in flight.
LeaseExpiry ==
  /\ ~storedClaimStale
  /\ storedClaimStale' = TRUE
  /\ UNCHANGED <<storedOwner, storedCommandId, storedWrittenAt, storedPhase,
                 worker1Held, worker2Held>>

Next ==
  TakeStep \/ SettleStep \/ LeaseExpiry \/
  UNCHANGED <<storedOwner, storedCommandId, storedWrittenAt, storedPhase,
              storedClaimStale, worker1Held, worker2Held>>

InductionStart == Safety
=============================================================================
