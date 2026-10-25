-------------------------- MODULE SquareLinkEnd --------------------------
EXTENDS SquareLinkEndData

\* One checkout identity. Provider evidence does not depend on row presence.
\* The generator executes real transitions and representative raw replies.
\* Trust the native lifetime and external witness evidence.
\* SQL and clock accuracy stay outside this proof.
\* The model does not prove provider truth or progress.
\* It does not cover concurrent workers or arbitrary reply payloads.

LocalEvents ==
  {"checkout_created", "claim_due", "payment_completed", "lease_expired"}
RetryEvents == {"delete_inconclusive", "lease_expired"}
ConclusiveEvidence == {"cancelled", "missing", "paid"}

\* @type: (Str) => Bool;
MayPay(at) ==
  \E fact \in AgeFacts : fact[1] = at /\ fact[2]

\* @type: (Str) => Bool;
Prunable(at) ==
  \E fact \in AgeFacts : fact[1] = at /\ fact[3]

\* @type: (Str) => Bool;
RequiredMargin(at) ==
  \E fact \in AgeFacts : fact[1] = at /\ fact[4]

\* The generator supplies time classes around each cutoff.
\* Numeric elapsed times define their monotone relation.
AgeData ==
  /\ AgeStart \in AgeStates
  /\ MayPay(AgeStart)
  /\ ~Prunable(AgeStart)
  /\ ~RequiredMargin(AgeStart)
  /\ \A at \in AgeStates : \E fact \in AgeFacts : fact[1] = at
  /\ \A fact \in AgeFacts :
       /\ fact[1] \in AgeStates
       /\ (fact[3] => fact[4])
       /\ (fact[4] => ~fact[2])
  /\ \A left, right \in AgeFacts :
       left[1] = right[1] => left = right
  /\ \A move \in AgeMoves :
       /\ move[1] \in AgeStates
       /\ move[2] \in AgeStates
       /\ (~MayPay(move[1]) => ~MayPay(move[2]))
       /\ (Prunable(move[1]) => Prunable(move[2]))
       /\ (RequiredMargin(move[1]) => RequiredMargin(move[2]))

\* Require every real input case. An unsupported event must not disappear
\* from the proof.
InputFacts ==
  /\ LinkStates = HandleStates \cup {"unwritten", "gone"}
  /\ HandleStates \cap {"unwritten", "gone"} = {}
  /\ LocalEvents \subseteq {event[1] : event \in LinkEvents}
  /\ \A rep \in LinkRepresentatives :
       /\ rep[1] \in LinkStates
       /\ rep[1] = rep[3]
  /\ \A state \in LinkStates :
       \E rep \in LinkRepresentatives : rep[1] = state
  /\ \A attempt \in LinkAttempts :
       /\ \E rep \in LinkRepresentatives :
            /\ rep[1] = attempt[1]
            /\ rep[2] = attempt[4]
       /\ \E event \in LinkEvents : event[1] = attempt[2]
  /\ \A rep \in LinkRepresentatives, event \in LinkEvents :
       \E attempt \in LinkAttempts :
         /\ attempt[1] = rep[1]
         /\ attempt[2] = event[1]
         /\ attempt[4] = rep[2]
  /\ \A reply \in ReplyFacts :
       \E event \in LinkEvents : event[1] = reply[3]
  /\ \A event \in LinkEvents : ~event[3]
  /\ \A event \in LinkEvents :
       event[1] \in LocalEvents \/
         \E reply \in ReplyFacts : reply[3] = event[1]

\* Expected external evidence is separate from the observed classifier event.
\* In particular, a successful response without cancellation evidence is none.
\* @type: (<<Str, Str, Str>>) => Bool;
ReplyAgrees(reply) ==
  CASE reply[2] = "none" -> reply[3] = "delete_inconclusive"
    [] reply[2] = "cancelled" -> reply[3] = "delete_answered_cancelled"
    [] reply[2] = "missing" -> reply[3] = "delete_answered_missing"
    [] reply[2] = "paid" -> reply[3] = "delete_refused_paid"
    [] OTHER -> FALSE

\* A refused attempt must keep its source. Retry work must return to pending.
\* @type: (<<Str, Str, Str, Str, Bool>>) => Bool;
SafeAttempt(attempt) ==
  /\ (~attempt[5] => attempt[1] = attempt[3])
  /\ (attempt[1] = "gone" => attempt[3] = "gone")
  /\ (attempt[2] \in RetryEvents =>
       /\ (attempt[1] = "ending" => attempt[5])
       /\ (attempt[5] =>
            /\ attempt[1] = "ending"
            /\ attempt[3] = "pending"))
  /\ (attempt[5] /\ attempt[2] = "checkout_created" =>
       attempt[1] = "unwritten")

VARIABLES
  \* @type: Str;
  row,
  \* @type: Str;
  age,
  \* @type: Bool;
  created,
  \* @type: Bool;
  endKnown,
  \* @type: Bool;
  goneSeen,
  \* @type: Bool;
  attemptsSafe,
  \* @type: Bool;
  repliesSafe,
  \* @type: Bool;
  removalsSafe

TypeOK ==
  /\ row \in LinkStates
  /\ age \in AgeStates
  /\ created \in BOOLEAN
  /\ endKnown \in BOOLEAN
  /\ goneSeen \in BOOLEAN
  /\ attemptsSafe \in BOOLEAN
  /\ repliesSafe \in BOOLEAN
  /\ removalsSafe \in BOOLEAN

Safety ==
  /\ TypeOK
  /\ InputFacts
  /\ AgeData
  /\ attemptsSafe
  /\ repliesSafe
  /\ removalsSafe
  /\ created = (row # "unwritten")
  /\ (endKnown => created)
  /\ (~created => age = AgeStart)
  /\ goneSeen = (row = "gone")
  /\ (created /\ ~endKnown /\ MayPay(age) => row \in HandleStates)
  /\ (row \in HandleStates => row \in CheckableStates)
  /\ (Prunable(age) => RequiredMargin(age))

Init ==
  /\ row = "unwritten"
  /\ age = AgeStart
  /\ created = FALSE
  /\ endKnown = FALSE
  /\ goneSeen = FALSE
  /\ attemptsSafe = TRUE
  /\ repliesSafe = TRUE
  /\ removalsSafe = TRUE

\* Keep provider evidence when a row disappears. Deletion does not prove an end.
\* A payment ends the link even if its claimed handle refuses local completion.
\* Monitors preserve unsafe results after later replies or time changes.
\* @type: (<<Str, Str, Str, Str, Bool>>, Bool) => Bool;
ApplyAttempt(attempt, conclusive) ==
  LET createdAfter == (created \/
        (attempt[5] /\ attempt[2] = "checkout_created"))
      endedAfter == (endKnown \/ conclusive)
  IN /\ row' = attempt[3]
     /\ created' = createdAfter
     /\ endKnown' = endedAfter
     /\ goneSeen' = (goneSeen \/ attempt[3] = "gone")
     /\ attemptsSafe' = (attemptsSafe /\ SafeAttempt(attempt))
     /\ removalsSafe' =
          (removalsSafe /\
            ((createdAfter /\ ~endedAfter /\ MayPay(age)) =>
              attempt[3] \in HandleStates))
     /\ UNCHANGED age

\* Include refused attempts. A row filter must not hide an accepted recreation.
LocalStep ==
  \E attempt \in LinkAttempts :
    /\ attempt[1] = row
    /\ attempt[2] \in LocalEvents
    /\ ApplyAttempt(attempt, created /\ attempt[2] = "payment_completed")
    /\ UNCHANGED repliesSafe

\* ReplyFacts pairs independent provider evidence with the classified event.
\* Only a claimed link receives a provider reply.
ReplyStep ==
  /\ row = "ending"
  /\ \E reply \in ReplyFacts, attempt \in LinkAttempts :
       /\ attempt[1] = row
       /\ attempt[2] = reply[3]
       /\ ApplyAttempt(attempt, reply[2] \in ConclusiveEvidence)
       /\ repliesSafe' = (repliesSafe /\ ReplyAgrees(reply))

Age ==
  /\ created
  /\ \E move \in AgeMoves :
       /\ move[1] = age
       /\ age' = move[2]
  /\ UNCHANGED <<row, created, endKnown, goneSeen, attemptsSafe,
                 repliesSafe, removalsSafe>>

\* Actual eligibility enables Prune. Safety checks the required margin.
\* Keep pre-delete age and provider evidence. A delete cannot erase its witness.
Prune ==
  /\ row \in HandleStates
  /\ Prunable(age)
  /\ row' = "gone"
  /\ goneSeen' = TRUE
  /\ UNCHANGED <<age, created, endKnown, attemptsSafe, repliesSafe, removalsSafe>>

Next == LocalStep \/ ReplyStep \/ Age \/ Prune \/
        UNCHANGED <<row, age, created, endKnown, goneSeen, attemptsSafe,
                    repliesSafe, removalsSafe>>

\* Check Init and Safety /\ Next => Safety' without a reachability bound.
\* Queue inclusion does not guarantee task execution.
InductionStart == Safety
=============================================================================
