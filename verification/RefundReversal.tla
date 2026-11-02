---------------------------- MODULE RefundReversal ----------------------------
EXTENDS FiniteSets, ModelRules, RefundReversalData

\* This module names a mathematical model. EXTENDS imports finite-set rules,
\* shared checks and generated facts. == defines a name, not an assignment.
\* An attendee is the stored owner of a ticket. A listing is a ticket offer.
\* An order is a set of ticket purchases and related charges.
\* A provider handles customer money outside this application. A refund
\* returns that money. A callback is a provider message about the result.
\* Replay here means a second local plan after the first refund plan posts.
\* The ledger is the durable account record of money and amounts owed.
\* An account is a place in that record for one party or purpose. It is not
\* necessarily a bank account. A leg is one transfer entry with a source
\* account, a destination account and an amount in currency minor units.
\* For GBP, 100 minor units means one pound. An event group connects legs
\* for one business event. A sale leg records the attendee's debt to revenue.
\* A provider payment leg records cash from the external WORLD account to
\* the attendee account. These two entries cancel the debt when amounts match.
\* An obligation is the amount owed for one order, with its tax corrections.
\* A refund plan proposes inverse legs. An inverse keeps the amount but
\* swaps source and destination, so the original account effect is undone.
\* A reference identifies a returned provider refund. Its index connects it
\* to sessions, the checkout attempts whose ledger groups it concerns.
\* A leg reference identifies an individual ledger entry instead.
\* Review means that an operator must examine a case rather than accept an
\* automatic reversal. recorded means local refund records exist. unrecorded
\* here is the outcome for a reference with no safe local refund record and
\* no review classification. The producer gives review priority over that
\* fallback when it emits one outcome label.

\* Check selected ledger plans after an attendee's provider refund returns.
\* For example, a repeated callback must not post a second inverse of an
\* order that already has its refund legs in the durable ledger.
\* scripts/verify-models/refund-reversal.ts produces RefundReversalData.
\* planFor calls computeAttendeeRefunds in src/shared/refund-ledger/plan.ts.
\* postThenPlan posts the first plan through postTransferGroups and obtains
\* a new plan. ledgerLegs reads stored transfers through transfersByAccounts.
\* pairedOriginal calls isInverseOf in src/shared/ledger/reverse.ts. An
\* unpaired leg causes extraction failure, not a fabricated safe fact.
\* These are selected fixtures, not all accounts, amounts or refund paths.
\* The law is per group. Production also has a whole_account path that can
\* admit a group outside this law. This model is not a whole-account proof.
\* Induction covers these facts and abstract rounds, not provider truth,
\* concurrent plans, SQL atomicity or crash gaps between durable writes.

\* Fixtures are small example ledgers, not live customer records. Their labels
\* keep unrelated orders distinct after facts from several examples join.
\* safe names a fully paid 5000-unit order. unsafe names a 3000-unit order
\* with only 1000 paid. operator includes a manual adjustment. payment has
\* provider cash without a sale. Tax examples join corrections to their order.
\* These cases separate the rule's reasons to accept or refuse a reversal.
\* The model checks extracted inverse verdicts, not money arithmetic itself.
VARIABLES
  \* Plan stage: first uses the original fixture ledger. replay uses the
  \* ledger after first-plan refund entries, where the fixture requests it.
  \* @type: Str;
  round,
  \* Set of group labels already reversed by the first abstract plan.
  \* This proof memory is not a fresh database query or a money amount.
  \* @type: Set(Str);
  recorded,
  \* Remember whether every group decision so far obeyed the reversal rule.
  \* This model-only flag stays FALSE after a failure.
  \* @type: Bool;
  allPlansSafe,
  \* Remember whether each proposed leg was an exact inverse of a stored leg.
  \* This model-only flag stays FALSE after a failure.
  \* @type: Bool;
  legsSafe

\* SUBSET GroupLabels permits any set of supplied group labels. TypeOK also
\* bounds round and both verdicts for the induction premise.
TypeOK ==
  /\ round \in RoundNames
  /\ recorded \in SUBSET GroupLabels
  /\ allPlansSafe \in BOOLEAN
  /\ legsSafe \in BOOLEAN

\* The per-group rule requires provider cash, no manual or adjustment money,
\* and either cash-only legs or a settled obligation. refundGroupFacts in
\* src/shared/refund-ledger/plan.ts derives these inputs from account groups.
\* Settled means zero net balance on this attendee account for the group,
\* not merely a provider success status. accountRefundGroups joins tax
\* corrections to their booking obligation before these facts are derived.
\* For example, payment 5000 and sale 5000 give zero net attendee balance.
\* Payment 1000 and sale 3000 leave 2000 owed, so the settled test fails.
\* A manual payment records operator-handled money. An adjustment changes
\* the account balance directly. Neither is provider cash for this rule.
\* @type: ($reversalFactsFact) => Bool;
CanReverse(fact) ==
  /\ fact.hasProviderPayment
  /\ ~fact.hasOperatorMoney
  /\ (fact.paymentOnly \/ fact.settled)

\* Refuse a second reversal of any group in the model's recorded set.
\* A new reversal must also satisfy the per-group rule. A refusal needs no
\* eligibility: => imposes the rule only when fact.reverses is TRUE.
\* @type: ($reversalFactsFact) => Bool;
SafeReversal(fact) ==
  /\ ~((fact.group \in recorded) /\ fact.reverses)
  /\ fact.reverses => CanReverse(fact)

\* exactInverse is an extraction verdict: equal amount and swapped accounts.
\* OriginalLegs supplies the first-ledger reference universe. This law checks
\* membership, not a one-to-one count of inverse legs per original reference.
\* @type: ($legFactsFact) => Bool;
SafeLeg(leg) == leg.exactInverse /\ leg.original \in OriginalLegs

\* For each expected (round, reference), require exactly one outcome fact.
\* The producer builds ExpectedReferences separately from returned outcomes.
\* The three labels are recorded, review and unrecorded. This checks their
\* classification shape, not whether the provider actually returned cash.
\* Cardinality counts distinct records. Equal TLA set records collapse.
ReferencePartition ==
  /\ \A fact \in ReferenceFacts : fact.outcome \in ReferenceOutcomes
  /\ \A expected \in ExpectedReferences :
       Cardinality({fact \in ReferenceFacts :
         fact.round = expected.round /\ fact.reference = expected.reference}) = 1

\* Safety checks domains, both accumulated verdicts and static reference
\* coverage. A failed plan or leg remains visible after later valid rounds.
Safety ==
  /\ TypeOK
  /\ allPlansSafe
  /\ legsSafe
  /\ ReferencePartition

\* Init defines the start state before the first plan, with no remembered
\* reversal. The fixture ledger already exists outside the model.
\* Safety is a condition on one state. The proof checks Init against Safety
\* and checks that each Next action from any Safety state preserves Safety.
\* This abstract induction check does not establish concrete database races.
Init ==
  /\ round = "first"
  /\ recorded = {}
  /\ allPlansSafe = TRUE
  /\ legsSafe = TRUE

\* Check every decision and leg fact for round r. \A means every member.
\* Facts of other rounds impose no condition in this step. /\ requires all
\* conditions. Unprimed names denote current values. A prime denotes the
\* next value. ChecksStillPass keeps any failure. The first round remembers
\* every reversed group and advances to replay. Replay keeps that set and
\* round. These are checker actions over facts, not an executable SQL plan.
PlanRound(r) ==
  /\ allPlansSafe' = ChecksStillPass(allPlansSafe,
       \A fact \in ReversalFacts : fact.round = r => SafeReversal(fact))
  /\ legsSafe' = ChecksStillPass(legsSafe,
       \A leg \in LegFacts : leg.round = r => SafeLeg(leg))
  /\ IF r = "first"
     THEN
       /\ recorded' = {reversal.group :
           reversal \in {fact \in ReversalFacts :
             fact.round = r /\ fact.reverses}}
       /\ round' = "replay"
     ELSE
       UNCHANGED <<round, recorded>>

\* Only the first label and empty memory admit FirstPlan. These conditions
\* align the first facts with their ledger before first-plan refund posts.
FirstPlan ==
  /\ round = "first"
  /\ recorded = {}
  /\ PlanRound("first")

\* Only the replay label admits ReplayPlan. Its facts came from the grown
\* ledger where a fixture requested replay. A recorded group must not reverse
\* again. Fixtures without replay facts add no replay obligation.
ReplayPlan ==
  /\ round = "replay"
  /\ PlanRound("replay")

\* Next defines the permitted actions. \/ offers alternatives. UNCHANGED
\* permits no change. Replay can repeat, but no rule requires even the first
\* plan or a final outcome to occur.
Next == FirstPlan \/ ReplayPlan \/
  UNCHANGED <<round, recorded, allPlansSafe, legsSafe>>

=============================================================================
