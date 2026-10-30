----------------------------- MODULE DoorScan -----------------------------
EXTENDS Integers, ModelRules, DoorScanData

\* The door scan admission machine: one booking's rows at one door. The
\* state is the places the door has admitted on the booking's two
\* representative listings. Every admission fact comes from the production
\* decision function, so a cap or a gate that slips there makes the checker
\* reject the derived facts. The model does not prove the database write or
\* the walk's booking order; it proves that no scan ever over-admits a
\* listing and no gate admits a row it must hold.
VARIABLES
  \* @type: Int;
  listing1Admitted,
  \* @type: Int;
  listing2Admitted,
  \* @type: Bool;
  allFactsSafe

TypeOK ==
  /\ listing1Admitted \in Int
  /\ listing2Admitted \in Int
  /\ allFactsSafe \in BOOLEAN

\* One scan's admission on one listing is safe when it never admits more
\* places than the listing still owes, never takes a place back, and never
\* admits a refunded, no-check-in or unverified non-transferable row.
\* @type: ($admitFactsFact) => Bool;
SafeAdmission(fact) ==
  /\ fact.after <= IF fact.listing = "one" THEN QuantityOne ELSE QuantityTwo
  /\ fact.after >= fact.before
  /\ fact.before >= 0
  /\ fact.refunded => fact.after = fact.before
  /\ fact.purchaseOnly => fact.after = fact.before
  /\ (fact.nonTransferable /\ ~fact.idVerified) => fact.after = fact.before

\* The door never admits a listing past what it owes, and every derived
\* admission fact is safe.
Safety ==
  /\ TypeOK
  /\ allFactsSafe
  /\ listing1Admitted <= QuantityOne
  /\ listing2Admitted <= QuantityTwo
  /\ listing1Admitted >= 0
  /\ listing2Admitted >= 0

Init ==
  /\ listing1Admitted = 0
  /\ listing2Admitted = 0
  /\ allFactsSafe = TRUE

\* One scan admits on one listing. The fact names the listing's count
\* before and after the scan; the step applies only when the stored count
\* matches, so the machine walks the booking's listings as the scans land.
AdmitStep ==
  \E fact \in AdmitFacts :
    /\ (fact.listing = "one" => listing1Admitted = fact.before)
    /\ (fact.listing = "two" => listing2Admitted = fact.before)
    /\ listing1Admitted' =
         IF fact.listing = "one" THEN fact.after ELSE listing1Admitted
    /\ listing2Admitted' =
         IF fact.listing = "two" THEN fact.after ELSE listing2Admitted
    /\ allFactsSafe' = ChecksStillPass(allFactsSafe, SafeAdmission(fact))

Next ==
  AdmitStep \/
  UNCHANGED <<listing1Admitted, listing2Admitted, allFactsSafe>>

InductionStart == Safety
=============================================================================
