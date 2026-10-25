-------------------------- MODULE SquareLinkEnd --------------------------
EXTENDS SquareLinkEndData

\* Purpose and limits
\* Follow one Square checkout and its saved cancel handle.
\* A handle is the record that lets the task ask Square to end a payment link.
\* The link can still take payment while that record is absent or wrong.
\* Keep provider evidence separate, so a bad delete cannot prove itself safe.
\*
\* This model takes one step at a time for one checkout identity.
\* It assumes Square's configured page lifetime and the supplied reply evidence.
\* It admits provider replies only while the handle is claimed for an end.
\* Database tests must check that admission rule and the actual write conditions.
\* SQL, clock accuracy, competing workers and arbitrary reply bodies are outside it.
\* The money check reads event declarations, not real balances or transfers.
\* An available retry does not prove that any worker eventually runs it.
\*
\* Read the notation
\* MODULE names this set of rules. EXTENDS imports the names that it uses.
\* The final line of = signs ends the module.
\* A state is one snapshot of every variable below.
\* == defines a rule. = compares values. # means different. ~ means not.
\* These are conditions, not commands that execute in line order.
\* A final ' marks a value in the next snapshot. Other names mean current values.
\* /\ requires all conditions. \/ permits either alternative.
\* => means that the left condition requires the right condition.
\* \in means membership. \cup joins sets. \cap finds their common members.
\* \subseteq means that every member on the left also occurs on the right.
\* \A means every listed case. \E chooses any listed case that fits.
\* {value : item \in Set} collects values from a set.
\* <<...>> is an ordered list. Its first column has index 1.
\* CASE tests alternatives. [] starts another case. OTHER is the fallback case.
\* -> gives a case's result. LET names local values for the expression after IN.
\* UNCHANGED keeps the listed values across a step. BOOLEAN contains TRUE and FALSE.
\* The type notes give checked word and truth-value shapes to Apalache.
\*
\* Data from the code
\* A representative is a sample record for one declared state.
\* The proof trusts that those samples cover the real cases that matter.
\* EXTENDS imports SquareLinkEndData, freshly built by scripts/verify-models/square.ts.
\* The generator runs real moves on cloned representative records.
\* A required move that throws fails generation. Declared refusals remain recorded.
\* It also feeds sample raw responses through the real Square reply classifier.
\* Expected reply evidence comes from those samples, not from the classifier result.
\*
\* LinkStates lists all node words, including the virtual unwritten and gone.
\* HandleStates lists words that the database can store: pending and ending.
\* CheckableStates lists nodes that the declared check events can act on.
\* LinkRepresentatives has columns: declared node, sample tag, actual row state.
\* LinkEvents has columns: event id, declared kind, declared money-movement flag.
\* The kind is create, check or complete. These rules do not read that column.
\* LinkAttempts has columns: source state, event id, actual target, sample tag, accepted.
\* Accepted means the call returned. A refusal records its unchanged source.
\* ReplyFacts has columns: sample label, expected external evidence, observed event id.
\* A sample label identifies evidence. It does not decide whether a reply is safe.
\*
\* AgeStates lists sampled age labels. AgeStart is zero elapsed time.
\* AgeFacts has columns: label, payable by age, actually prunable, required margin elapsed.
\* Payable means age is strictly below SQUARE_NATIVE_LIFETIME_MS.
\* Actually prunable means age is strictly above SQUARE_LINK_RETENTION_MS.
\* The required margin is native lifetime plus WEBHOOK_RETRY_WINDOW_DAYS.
\* Its flag also uses strictly above, but does not copy the retention constant.
\* That separation lets the proof reject an early change to the actual cutoff.
\* Samples sit before, at and after native expiry and both retention cutoffs.
\* At a retention cutoff, the row must stay. Only a later age permits deletion.
\* AgeMoves has columns: source label, target label.
\* Numeric sample times permit every forward or equal-age move, never a backward move.
\* The rules keep only these age flags, not real timestamps.

\* These sets give event names their independent business meanings.
\* LocalEvents covers creation, a lease claim, payment completion and lease expiry.
\* RetryEvents must return a held handle to the pending queue.
\* ConclusiveEvidence means that cancellation, absence or payment ended the link.

LocalEvents ==
  {"checkout_created", "claim_due", "payment_completed", "lease_expired"}
RetryEvents == {"delete_inconclusive", "lease_expired"}
ConclusiveEvidence == {"cancelled", "missing", "paid"}

\* Look up whether age alone still permits payment.
\* A conclusive reply can end payment earlier through the separate endKnown flag.
\* @type: (Str) => Bool;
MayPay(at) ==
  \E fact \in AgeFacts : fact[1] = at /\ fact[2]

\* Look up the actual age-prune decision from the shared production cutoff.
\* @type: (Str) => Bool;
Prunable(at) ==
  \E fact \in AgeFacts : fact[1] = at /\ fact[3]

\* Look up whether the independently required safe age has already passed.
\* This is a truth value, not a duration.
\* @type: (Str) => Bool;
RequiredMargin(at) ==
  \E fact \in AgeFacts : fact[1] = at /\ fact[4]

\* Validate the age table instead of treating missing facts as safe answers.
\* Zero age must be payable and too young for either retention cutoff.
\* Every age label needs exactly one consistent set of flags.
\* Actual prune eligibility must imply the required margin.
\* The required margin must imply that native payability has ended.
\* Forward time cannot restore payability or revoke a passed cutoff.
\* Safety includes these checks, so bad generated constants fail the base case.
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

\* Check the input contract, not only the moves that a trace happens to choose.
\* Stored and virtual state words must stay separate.
\* Each representative must store the node that it claims to represent.
\* Every state needs a representative, and every representative/event pair needs an attempt.
\* Every attempt and reply must name a declared event.
\* All required local events must exist. Every event must be local or have reply evidence.
\* Thus an absent or unsupported event cannot silently shrink the proof.
\* No declared event can claim a money movement.
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

\* Judge the classifier against evidence supplied independently by each raw sample.
\* "none" must stay inconclusive, even when the HTTP request succeeded.
\* A cancelled order id, a missing link, and a paid order have distinct events.
\* OTHER rejects an evidence word that this rule does not understand.
\* ReplyStep records a bad answer as a failure instead of excluding its step.
\* @type: (<<Str, Str, Str>>) => Bool;
ReplyAgrees(reply) ==
  CASE reply[2] = "none" -> reply[3] = "delete_inconclusive"
    [] reply[2] = "cancelled" -> reply[3] = "delete_answered_cancelled"
    [] reply[2] = "missing" -> reply[3] = "delete_answered_missing"
    [] reply[2] = "paid" -> reply[3] = "delete_refused_paid"
    [] OTHER -> FALSE

\* Judge one observed attempt without removing unsafe attempts from the graph.
\* A refusal must keep its state. A gone checkout must remain gone.
\* From ending, a retry event must succeed and return the handle to pending.
\* A retry cannot succeed from any other state.
\* Creation can succeed only from unwritten, not after a previous removal.
\* This rule does not prove that the real database prevents duplicate creation.
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

\* Model memory
VARIABLES
  \* The handle's stored state, or unwritten/gone for its two kinds of absence.
  \* @type: Str;
  row,
  \* A sampled age label. It carries no live clock value.
  \* @type: Str;
  age,
  \* Whether this checkout has ever been created in this model.
  \* @type: Bool;
  created,
  \* Whether independent evidence has established that the link ended.
  \* @type: Bool;
  endKnown,
  \* Whether this handle has ever reached gone. A later move cannot erase that fact.
  \* @type: Bool;
  goneSeen,
  \* Whether every applied move so far passed SafeAttempt.
  \* @type: Bool;
  attemptsSafe,
  \* Whether every provider reply so far agreed with its independent evidence.
  \* @type: Bool;
  repliesSafe,
  \* Whether every applied move kept a still-payable link's handle.
  \* @type: Bool;
  removalsSafe

\* Restrict every remembered value to a known word or a truth value.
TypeOK ==
  /\ row \in LinkStates
  /\ age \in AgeStates
  /\ created \in BOOLEAN
  /\ endKnown \in BOOLEAN
  /\ goneSeen \in BOOLEAN
  /\ attemptsSafe \in BOOLEAN
  /\ repliesSafe \in BOOLEAN
  /\ removalsSafe \in BOOLEAN

\* Safety checks
\* Safety is the full set of conditions that each snapshot must satisfy.
\* The input tables and age meanings must be valid, and no history flag can fail.
\* Creation must agree with the row word. An end cannot precede creation.
\* Time cannot advance before creation, and a past removal requires the current word gone.
\* A created link still payable without end evidence must retain a stored handle.
\* Every retained handle must still belong to the declared check queue.
\* Age pruning must respect the independent margin, not only its actual cutoff.
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

\* Begin before this checkout exists, at zero age and without end evidence.
\* TRUE history flags mean that no bad attempt has occurred.
\* They do not mean that a provider reply or a removal already occurred.
Init ==
  /\ row = "unwritten"
  /\ age = AgeStart
  /\ created = FALSE
  /\ endKnown = FALSE
  /\ goneSeen = FALSE
  /\ attemptsSafe = TRUE
  /\ repliesSafe = TRUE
  /\ removalsSafe = TRUE

\* Apply the recorded target, even if it is wrong.
\* LET names the creation and end facts after this attempt.
\* These facts keep earlier evidence instead of deriving it from row presence.
\* Payment completion establishes an end even if the claimed row refuses deletion.
\* The accepted flag limits creation, but does not cancel independent payment evidence.
\* Each history flag combines its old value with the new result.
\* A later good move cannot turn a FALSE history flag back to TRUE.
\* In particular, later expiry cannot hide an earlier unsafe handle removal.
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

\* Choose a matching local attempt, including refusals.
\* Do not restrict creation to unwritten here. A bad accepted recreation must remain visible.
\* Payment establishes an end only for a checkout that already exists.
\* No reply classifier result occurs in this kind of step.
LocalStep ==
  \E attempt \in LinkAttempts :
    /\ attempt[1] = row
    /\ attempt[2] \in LocalEvents
    /\ ApplyAttempt(attempt, created /\ attempt[2] = "payment_completed")
    /\ UNCHANGED repliesSafe

\* Pair independent provider evidence with the event that the classifier actually returned.
\* The claimed state ending is an admission assumption about callers and SQL.
\* Conclusive evidence updates endKnown even when the local attempt is refused.
\* A wrong classification also makes repliesSafe FALSE and remains observable.
ReplyStep ==
  /\ row = "ending"
  /\ \E reply \in ReplyFacts, attempt \in LinkAttempts :
       /\ attempt[1] = row
       /\ attempt[2] = reply[3]
       /\ ApplyAttempt(attempt, reply[2] \in ConclusiveEvidence)
       /\ repliesSafe' = (repliesSafe /\ ReplyAgrees(reply))

\* Advance a created checkout to any permitted equal or later sampled age.
\* Time changes neither the handle nor its evidence or failure history.
\* This does not assert that the real clock moves correctly.
Age ==
  /\ created
  /\ \E move \in AgeMoves :
       /\ move[1] = age
       /\ age' = move[2]
  /\ UNCHANGED <<row, created, endKnown, goneSeen, attemptsSafe,
                 repliesSafe, removalsSafe>>

\* Delete an actual stored handle when the actual retention rule permits it.
\* Do not guard this action with RequiredMargin. Safety must test that separately.
\* Keep the age and provider evidence after deletion.
\* A premature delete must not erase the facts that reveal it.
\* Prune does not add provider end evidence or repair an earlier failed check.
Prune ==
  /\ row \in HandleStates
  /\ Prunable(age)
  /\ row' = "gone"
  /\ goneSeen' = TRUE
  /\ UNCHANGED <<age, created, endKnown, attemptsSafe, repliesSafe, removalsSafe>>

\* One step takes a local action, handles a reply, advances age, deletes, or pauses.
\* A pause leaves every field unchanged. No fairness rule requires useful work.
Next == LocalStep \/ ReplyStep \/ Age \/ Prune \/
        UNCHANGED <<row, age, created, endKnown, goneSeen, attemptsSafe,
                    repliesSafe, removalsSafe>>

\* Proof checks
\* scripts/verify-models.ts checks Safety at Init with length zero.
\* It then checks one Next step from every state that satisfies Safety.
\* This is not only a one-step trace from the initial state.
\* The second check includes safe states that the initial state cannot reach.
\* A valid start and unrestricted preservation establish Safety for any finite run length.
\* This proves the stated safety rules, not eventual retries or deletion.
InductionStart == Safety
=============================================================================
