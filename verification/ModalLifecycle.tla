------------------------- MODULE ModalLifecycle -------------------------
\* A modal is an admin window that leaves the rest of the page usable.
\* A key names one window.
\* The stack orders windows from bottom to top. Minimise hides a window's body
\* and saves its expanded position. Restore must use that saved position, not
\* a later drag position. Example: minimise a at pixel 2, drag it to pixel 0,
\* then restore it. It must return to 2 when the viewport has enough space.
EXTENDS Apalache, Integers, FiniteSets, Sequences, ModalLifecycleData, ModelRules

\* scripts/verify-models/modal-lifecycle.ts calls transitionModals from
\* src/ui/client/admin/modal-state.ts for every event at every discovered state.
\* These are observed reducer outputs, not a second lifecycle implementation.
\* The producer starts empty and applies each selected event to each new state.
\* It stops when no event reaches a new state. Snapshots is an ordered tuple
\* of distinct observed states. Each row stores its zero-based model-only id.
\* Events stores the selected input metadata once, with a separate event id.
\* Targets is a tuple of rows.
\* Cell Targets[source + 1][event + 1] holds the observed target state id.
\* TLA tuple positions start at one. Our model ids start at zero.
\* scripts/verify-models/modal-lifecycle-matrix.ts checks the complete matrix.
\* Every selected source/event pair must have one actual reducer call, including
\* no-ops. Missing, duplicate, noninteger, and invalid links stop extraction.
\* Input metadata is an assumed fixture input, not an observed reducer output.
\* This matrix avoids a deep set expression with 2318 edge records. It changes
\* no selected input or transition. The laws below remain independent rules.
\* Generated snapshotsFact and eventsFact aliases describe the record tables.
\* Targets has the explicit type Seq(Seq(Int)). Operator types remain explicit.
\*
\* Domain: a, b, and c are example window keys, not actual page identifiers.
\* Rank 0 means absent. Positive ranks 1 through 3 run from bottom to top.
\* Points of a and b are 0 or 2 pixels on both axes. Saved point -1 means expanded.
\* An absent window also has point -1. Pixel sizes are 2 by 2. Viewports are
\* 2 by 2 and 4 by 4. Moves of a request -1 and 3 to cross both boundaries.
\* Opens of a choose 0 or 2. Window b opens at 0 and does not drag. It still
\* opens, raises, closes, minimises, and restores. Window c only opens, raises,
\* and closes. It stays expanded at point 0. Resize measures all three windows.
\* The producer rejects any other position or saved point for c before projection.
\* Each point has equal left and top coordinates. This keeps the domain small
\* but permits distinct saved and dragged points, duplicate events, close then
\* reopen, all stack orders, and resize before restore. Three keys let close
\* leave two survivors, so an incorrect reversal of their order is observable.
\* Events can occur in any
\* order. These examples do not prove the laws for all pixel inputs.
\*
\* This gives 122 state rows, 19 input rows, and 2318 observed transition rows.
\* The viewport is an event input,
\* not persistent browser state. Only move, restore, and resize must clamp.
\* Assumed: input keys are unique and measurements are finite. Each live window
\* has a resize measurement. Open receives its initial positioned point.
\* The model checks a synchronous pure reducer, not browser event delivery,
\* pointer capture, drag click suppression, focus, native dialog close timing,
\* CSS dimensions, rendered content, or actual viewport measurements. Core tests check
\* separate axes and oversized windows. Browser tests must check these IO limits.
\* No fairness rule is present. Safety does not establish eventual close/restore.
VARIABLES
  \* The current state's model-only id. Snapshot(windows) supplies all three
  \* windows' observed fields. A key is an application identity, not this id.
  \* @type: Int;
  windows,
  \* Model-only evidence. Once an event breaks a law, later steps cannot hide it.
  \* @type: Bool;
  safe

\* == defines an expression. In an action, := assigns a next value.
\* /\ joins conditions with 'and'.
\* A set lists permitted values. \in means membership. \A checks every member.
\* @type: Set(Str);
Keys == {"a", "b", "c"}
\* @type: Set(Int);
NodeIds == {index - 1 : index \in DOMAIN Snapshots}
\* @type: Set(Int);
EventIds == {e.event : e \in Events}
\* @type: $snapshotsFact;
Empty == [id |-> 0, aRank |-> 0, aPoint |-> -1, aSaved |-> -1,
          bRank |-> 0, bPoint |-> -1, bSaved |-> -1, cRank |-> 0]

\* The ordered state table permits direct lookup, without a set search.
\* DomainOK checks that each row's stored id matches its tuple position.
\* @type: (Int) => $snapshotsFact;
Snapshot(id) == Snapshots[id + 1]
\* @type: ($snapshotsFact, Str) => Int;
Rank(s, key) ==
  IF key = "a" THEN s.aRank ELSE IF key = "b" THEN s.bRank ELSE s.cRank
\* @type: ($snapshotsFact, Str) => Int;
Point(s, key) ==
  IF key = "a" THEN s.aPoint ELSE IF key = "b" THEN s.bPoint
  ELSE IF s.cRank = 0 THEN -1 ELSE 0
\* @type: ($snapshotsFact, Str) => Int;
Saved(s, key) ==
  IF key = "a" THEN s.aSaved ELSE IF key = "b" THEN s.bSaved ELSE -1
\* @type: ($snapshotsFact) => Int;
Count(s) == (IF s.aRank > 0 THEN 1 ELSE 0) +
            (IF s.bRank > 0 THEN 1 ELSE 0) + (IF s.cRank > 0 THEN 1 ELSE 0)


\* A valid stack has unique, consecutive ranks. An absent key owns no position.
\* These structural rules detect duplicate open results and broken removals.
\* @type: ($snapshotsFact) => Bool;
ValidStack(s) ==
  /\ \A key \in Keys :
       /\ Rank(s, key) \in {0, 1, 2, 3}
       /\ (Rank(s, key) = 0 => Point(s, key) = -1 /\ Saved(s, key) = -1)
       /\ (Rank(s, key) > 0 => Point(s, key) \in {0, 2} /\ Saved(s, key) \in {-1, 0, 2})
       /\ Rank(s, key) <= Count(s)
  /\ \A first \in Keys : \A second \in Keys :
       first # second /\ Rank(s, first) > 0 /\ Rank(s, second) > 0 =>
         Rank(s, first) # Rank(s, second)

\* A clamp must return the requested point inside the boundary. Outside it,
\* the nearest legal edge is required. This law does not call the JS clamp.
\* @type: (Int, Int, Int) => Bool;
Clamped(request, result, limit) ==
  /\ result >= 0 /\ result <= limit
  /\ (request < 0 => result = 0)
  /\ (request > limit => result = limit)
  /\ (request >= 0 /\ request <= limit => result = request)

\* A position event must select this key and one of the requested kinds.
\* Open initialises only an absent key. Restore needs a saved expanded point.
\* Move and minimise have no extra position-field guard. These are input
\* classifications, not a second implementation of the production reducer.
\* @type: ($snapshotsFact, $eventsFact, Str, Set(Str)) => Bool;
PositionEvent(before, e, key, kinds) ==
  /\ e.key = key
  /\ e.kind \in kinds
  /\ CASE e.kind = "open" -> Rank(before, key) = 0
       [] e.kind = "restore" -> Saved(before, key) # -1
       [] OTHER -> TRUE

\* Open appends an absent key. For an existing selected key, raise/open and
\* close share the same shift of unselected ranks. Their selected ranks differ:
\* the top rank for raise/open, zero for close. No other event changes order.
\* @type: ($snapshotsFact, $snapshotsFact, $eventsFact, Str) => Bool;
OrderLaw(before, after, e, key) ==
  LET old == Rank(before, key)
      selected == Rank(before, e.key)
      required ==
        IF PositionEvent(before, e, key, {"open"}) THEN Count(before) + 1
        ELSE IF e.kind \in {"open", "raise", "close"} /\ selected > 0
        THEN IF key = e.key
             THEN IF e.kind = "close" THEN 0 ELSE Count(before)
             ELSE old - (IF old > selected THEN 1 ELSE 0)
        ELSE old
  IN Rank(after, key) = required

\* Open and move request the input point. Restore requests the saved point.
\* All other events request the current point. This rule does not clamp it.
\* @type: ($snapshotsFact, $eventsFact, Str) => Int;
RequestedPoint(before, e, key) ==
  IF PositionEvent(before, e, key, {"open", "move"}) THEN e.input
  ELSE IF PositionEvent(before, e, key, {"restore"}) THEN Saved(before, key)
  ELSE Point(before, key)

\* Resize always clamps current points. Move and an active restore clamp their
\* requested points. Open already receives its positioned point.
\* @type: ($snapshotsFact, $eventsFact, Str) => Bool;
NeedsClamp(before, e, key) ==
  e.kind = "resize" \/ PositionEvent(before, e, key, {"move", "restore"})

\* Close, new open, and restore clear the saved point. The first minimise saves
\* the current point. Duplicate minimise, drag, resize, and other keys retain it.
\* @type: ($snapshotsFact, $snapshotsFact, $eventsFact, Str) => Bool;
SavedLaw(before, after, e, key) ==
  Saved(after, key) =
    IF Rank(after, key) = 0 \/ PositionEvent(before, e, key, {"open", "restore"})
    THEN -1
    ELSE IF PositionEvent(before, e, key, {"minimise"}) /\ Saved(before, key) = -1
    THEN Point(before, key)
    ELSE Saved(before, key)

\* An absent key owns no point. A live key must have its requested point,
\* either unchanged or clamped under the independent nearest-edge law.
\* @type: ($snapshotsFact, $snapshotsFact, $eventsFact, Str) => Bool;
PointLaw(before, after, e, key) ==
  IF Rank(after, key) = 0 THEN Point(after, key) = -1
  ELSE IF NeedsClamp(before, e, key)
  THEN Clamped(RequestedPoint(before, e, key), Point(after, key), e.limit)
  ELSE Point(after, key) = RequestedPoint(before, e, key)

\* Each chosen production edge must preserve structure, key identity, saved
\* position, the required clamp, and the order of every unselected window.
\* @type: (Int, Int, $eventsFact) => Bool;
LegalTransition(source, target, input) ==
  LET before == Snapshot(source)
      after == Snapshot(target)
  IN /\ ValidStack(after)
     /\ \A key \in Keys :
          /\ OrderLaw(before, after, input, key)
          /\ SavedLaw(before, after, input, key)
          /\ PointLaw(before, after, input, key)

\* Domain checks run in initial safety, not only in an induction premise.
\* They catch corrupted state rows, empty input, and missing source/target joins.
\* Generator tests also require every selected event at every discovered state.
\* @type: Bool;
DomainOK ==
  /\ Len(Snapshots) > 0 /\ Events # {} /\ Len(Targets) > 0
  /\ Snapshots[1] = Empty
  /\ Len(Snapshots) = Len(Targets)
  /\ Cardinality(Events) = Cardinality(EventIds)
  /\ EventIds = {index - 1 : index \in DOMAIN Targets[1]}
  /\ \A index \in DOMAIN Snapshots :
       /\ Snapshots[index].id = index - 1
       /\ ValidStack(Snapshots[index])
  /\ \A source \in NodeIds :
       /\ Len(Targets[source + 1]) = Cardinality(Events)
       /\ \A event \in EventIds : Targets[source + 1][event + 1] \in NodeIds

\* Every current id selects one domain row. DomainOK requires each row to have
\* a valid stack. Safety checks the domain, current id, and sticky verdict.
\* The unrestricted step starts from ANY state that satisfies Safety, not only
\* a reachable subset. Both obligations cover every finite supplied sequence.
\* @type: Bool;
Safety ==
  /\ windows \in NodeIds
  /\ safe = TRUE
  /\ DomainOK

\* Start with no windows, before the first open. Initial safety checks every
\* domain fact, including rows that this initial id does not select.
\* @type: Bool;
Init == /\ windows := 0 /\ safe := TRUE

\* \E permits any selected input event, not merely the first. The matrix holds
\* that event's actual reducer result at the current source state. A prime
\* denotes the value after a step. := marks each assignment. An unsafe result
\* still changes the state and records failure. No safety guard removes it.
\* No-op cells remain steps.
\* @type: Bool;
Transition ==
  \E input \in Events :
    LET target == Targets[windows + 1][input.event + 1]
    IN /\ windows' := target
       /\ safe' := ChecksStillPass(safe, LegalTransition(windows, target, input))

\* \/ offers alternatives. Any enabled event may occur after any other event.
\* UNCHANGED allows a step with no event and no progress requirement.
\* @type: Bool;
Next == Transition \/ UNCHANGED <<windows, safe>>
=============================================================================
