---------------------------- MODULE ModalFocus ----------------------------
\* Admin windows leave the page usable, so two kinds of thing can hold the focus:
\* the page, or the top window. Everything else is dim. Focus 0 is the page and
\* focus 1 is the top window. With no window open, the page holds the focus.
\* A window that opens or rises takes the focus. A press on the page gives it
\* back and moves no window. The last window to close hands it to the page.
\* Every other event keeps the focus where it was.
EXTENDS Apalache, Integers, FiniteSets, Sequences, ModalFocusData, ModelRules

\* scripts/verify-models/modal-focus.ts calls transitionScreen from
\* src/ui/client/admin/modal-focus.ts for every event at every declared screen.
\* These are observed reducer outputs, not a second implementation of the rule.
\* The same producer reads the dim of each part from dimmingFor.
\* Snapshots is an ordered tuple of the declared screens. Each row stores its
\* zero-based model-only id. Events stores the selected input metadata once.
\* Cell Targets[source + 1][event + 1] holds the observed target screen id.
\* scripts/verify-models/modal-lifecycle-matrix.ts checks the complete matrix.
\* The laws below remain independent rules.
\*
\* Domain: a, b, and c are example window keys, not actual page identifiers.
\* A rank is the place of a window in the stack, bottom first. Rank 0 means that
\* the window is absent. Every order of every subset of the three keys occurs.
\* Each non-empty stack occurs twice: once for each holder of the focus.
\* This model does not move a window. The ModalLifecycle model checks the order
\* of the stack and the position of each window. This model checks who holds the
\* focus, which parts are dim, and that a press on the page moves nothing.
\* The model checks a synchronous pure reducer, not browser focus events.
\* No fairness rule is present.
VARIABLES
  \* The current screen's model-only id. Snapshot(screen) supplies its facts.
  \* @type: Int;
  screen,
  \* Model-only evidence. Once an event breaks a law, later steps cannot hide it.
  \* @type: Bool;
  safe

\* @type: Set(Str);
Keys == {"a", "b", "c"}
\* @type: Set(Int);
ScreenIds == {index - 1 : index \in DOMAIN Snapshots}
\* @type: Set(Int);
EventIds == {e.event : e \in Events}
\* @type: $snapshotsFact;
Blank == [id |-> 0, aRank |-> 0, aDim |-> 0, bRank |-> 0, bDim |-> 0,
          cRank |-> 0, cDim |-> 0, focus |-> 0, pageDim |-> 0]

\* @type: (Int) => $snapshotsFact;
Snapshot(id) == Snapshots[id + 1]
\* @type: ($snapshotsFact, Str) => Int;
Rank(s, key) ==
  IF key = "a" THEN s.aRank ELSE IF key = "b" THEN s.bRank ELSE s.cRank
\* @type: ($snapshotsFact, Str) => Int;
Dim(s, key) ==
  IF key = "a" THEN s.aDim ELSE IF key = "b" THEN s.bDim ELSE s.cDim
\* The number of open windows.
\* @type: ($snapshotsFact) => Int;
Total(s) == (IF s.aRank > 0 THEN 1 ELSE 0) +
            (IF s.bRank > 0 THEN 1 ELSE 0) + (IF s.cRank > 0 THEN 1 ELSE 0)

\* A valid screen has unique consecutive ranks, and a focus of 0 or 1. With no
\* window open, the page holds the focus. An absent window is never dim.
\* @type: ($snapshotsFact) => Bool;
ValidScreen(s) ==
  /\ \A key \in Keys :
       /\ Rank(s, key) \in {0, 1, 2, 3}
       /\ Rank(s, key) <= Total(s)
       /\ Dim(s, key) \in {0, 1}
       /\ (Rank(s, key) = 0 => Dim(s, key) = 0)
  /\ \A first, second \in Keys :
       (first # second /\ Rank(s, first) = Rank(s, second)) =>
         Rank(s, first) = 0
  /\ s.focus \in {0, 1} /\ s.pageDim \in {0, 1}
  /\ (Total(s) = 0 => s.focus = 0)

\* The page is dim while a window holds the focus. A window is dim unless it is
\* the top window and a window holds the focus. This law does not call the JS rule.
\* @type: ($snapshotsFact, Str) => Int;
ExpectedDim(s, key) ==
  IF Rank(s, key) > 0 /\ (s.focus = 0 \/ Rank(s, key) < Total(s)) THEN 1 ELSE 0
\* @type: ($snapshotsFact) => Int;
ExpectedPageDim(s) == IF Total(s) > 0 /\ s.focus = 1 THEN 1 ELSE 0

\* The page and each open window are the bright candidates. A bright candidate
\* is not dim. Exactly one candidate is bright.
\* @type: ($snapshotsFact) => Int;
BrightCount(s) ==
  (1 - s.pageDim)
  + (IF Rank(s, "a") > 0 THEN 1 - s.aDim ELSE 0)
  + (IF Rank(s, "b") > 0 THEN 1 - s.bDim ELSE 0)
  + (IF Rank(s, "c") > 0 THEN 1 - s.cDim ELSE 0)

\* The observed dim must match the focus, and one part must be bright.
\* @type: ($snapshotsFact) => Bool;
DimLaw(s) ==
  /\ s.pageDim = ExpectedPageDim(s)
  /\ \A key \in Keys : Dim(s, key) = ExpectedDim(s, key)
  /\ BrightCount(s) = 1

\* The focus after an event. No window leaves it on the page. A press on the page
\* gives it the page. An open or a raise of a live window gives it the window.
\* Every other event keeps it. A raise of an absent key changes nothing.
\* @type: ($snapshotsFact, $snapshotsFact, $eventsFact) => Bool;
FocusLaw(before, after, e) ==
  after.focus =
    IF Total(after) = 0 THEN 0
    ELSE IF e.kind = "focus-page" THEN 0
    ELSE IF e.kind \in {"open", "raise"} /\ Rank(after, e.key) > 0 THEN 1
    ELSE before.focus

\* A window that opens or rises must reach the top, where the focus sits.
\* @type: ($snapshotsFact, $eventsFact) => Bool;
TopLaw(after, e) ==
  (e.kind \in {"open", "raise"} /\ Rank(after, e.key) > 0) =>
    Rank(after, e.key) = Total(after)

\* A press on the page leaves every window at its rank.
\* @type: ($snapshotsFact, $snapshotsFact, $eventsFact) => Bool;
PressLaw(before, after, e) ==
  e.kind = "focus-page" => \A key \in Keys : Rank(after, key) = Rank(before, key)

\* Each chosen production edge must leave a valid screen with the right focus,
\* the right dim, the top window on top, and every window in place after a press.
\* @type: (Int, Int, $eventsFact) => Bool;
LegalMove(origin, result, input) ==
  LET before == Snapshot(origin)
      after == Snapshot(result)
  IN /\ ValidScreen(after)
     /\ DimLaw(after)
     /\ FocusLaw(before, after, input)
     /\ TopLaw(after, input)
     /\ PressLaw(before, after, input)

\* Domain checks run in initial safety, not only in an induction premise.
\* They catch corrupted screen rows, empty input, and missing joins.
\* @type: Bool;
DomainOK ==
  /\ Len(Snapshots) > 0 /\ Len(Targets) = Len(Snapshots)
  /\ Events # {}
  /\ Snapshots[1] = Blank
  /\ Cardinality(EventIds) = Cardinality(Events)
  /\ \A event \in EventIds : event + 1 \in DOMAIN Targets[1]
  /\ \A index \in DOMAIN Snapshots :
       /\ Snapshots[index].id = index - 1
       /\ ValidScreen(Snapshots[index])
       /\ DimLaw(Snapshots[index])
  /\ \A source \in ScreenIds :
       /\ Len(Targets[source + 1]) = Cardinality(Events)
       /\ \A event \in EventIds : Targets[source + 1][event + 1] \in ScreenIds

\* Every current id selects one declared screen. The unrestricted step starts
\* from ANY state that satisfies Safety, not only a reachable subset.
\* @type: Bool;
Safety ==
  /\ screen \in ScreenIds
  /\ safe = TRUE
  /\ DomainOK

\* Start with no window open: the page holds the focus.
\* @type: Bool;
Init == /\ screen := 0 /\ safe := TRUE

\* \E permits any selected event. The matrix holds its actual reducer result at
\* the current screen. An unsafe result still changes the state and records failure.
\* No-op cells remain steps.
\* @type: Bool;
Transition ==
  \E input \in Events :
    LET result == Targets[screen + 1][input.event + 1]
    IN /\ screen' := result
       /\ safe' := ChecksStillPass(safe, LegalMove(screen, result, input))

\* Any enabled event may occur after any other. A step with no event is allowed.
\* @type: Bool;
Next == Transition \/ UNCHANGED <<screen, safe>>
=============================================================================
