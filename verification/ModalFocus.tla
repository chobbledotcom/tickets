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
ScreenIds == RowIds(Snapshots)
\* @type: $snapshotsFact;
Blank == [id |-> 0, aRank |-> 0, aDim |-> 0, bRank |-> 0, bDim |-> 0,
          cRank |-> 0, cDim |-> 0, focus |-> 0, pageDim |-> 0]

\* @type: (Int) => $snapshotsFact;
Snapshot(id) == RowAt(Snapshots, id)
\* @type: ($snapshotsFact, Str) => Int;
Dim(s, key) ==
  IF key = "a" THEN s.aDim ELSE IF key = "b" THEN s.bDim ELSE s.cDim
\* A valid screen has unique consecutive ranks, and a focus of 0 or 1. With no
\* window open, the page holds the focus. An absent window is never dim.
\* @type: ($snapshotsFact) => Bool;
ValidScreen(s) ==
  /\ RanksInRange(s)
  /\ \A key \in Keys :
       /\ Dim(s, key) \in {0, 1}
       /\ (RankOf(s, key) = 0 => Dim(s, key) = 0)
  /\ \A first, second \in Keys :
       (first # second /\ RankOf(s, first) = RankOf(s, second)) =>
         RankOf(s, first) = 0
  /\ s.focus \in {0, 1} /\ s.pageDim \in {0, 1}
  /\ (OpenWindows(s) = 0 => s.focus = 0)

\* The page is dim while a window holds the focus. A window is dim unless it is
\* the top window and a window holds the focus. This law does not call the JS rule.
\* @type: ($snapshotsFact, Str) => Int;
ExpectedDim(s, key) ==
  IF RankOf(s, key) > 0 /\ (s.focus = 0 \/ RankOf(s, key) < OpenWindows(s)) THEN 1 ELSE 0
\* @type: ($snapshotsFact) => Int;
ExpectedPageDim(s) == IF OpenWindows(s) > 0 /\ s.focus = 1 THEN 1 ELSE 0

\* The page and each open window are the bright candidates. A bright candidate
\* is not dim. Exactly one candidate is bright.
\* @type: ($snapshotsFact) => Int;
BrightCount(s) ==
  (1 - s.pageDim)
  + (IF RankOf(s, "a") > 0 THEN 1 - s.aDim ELSE 0)
  + (IF RankOf(s, "b") > 0 THEN 1 - s.bDim ELSE 0)
  + (IF RankOf(s, "c") > 0 THEN 1 - s.cDim ELSE 0)

\* The observed dim must match the focus, and one part must be bright.
\* @type: ($snapshotsFact) => Bool;
DimLaw(s) ==
  /\ s.pageDim = ExpectedPageDim(s)
  /\ \A key \in Keys : Dim(s, key) = ExpectedDim(s, key)
  /\ BrightCount(s) = 1

\* An open or a raise that leaves its key as a live window.
\* @type: ($snapshotsFact, $eventsFact) => Bool;
TakesFocus(after, e) ==
  e.kind \in {"open", "raise"} /\ RankOf(after, e.key) > 0

\* The focus after an event. No window leaves it on the page. A press on the page
\* gives it the page. An open or a raise of a live window gives it the window.
\* Every other event keeps it. A raise of an absent key changes nothing.
\* @type: ($snapshotsFact, $snapshotsFact, $eventsFact) => Bool;
FocusLaw(before, after, e) ==
  after.focus =
    IF OpenWindows(after) = 0 THEN 0
    ELSE IF e.kind = "focus-page" THEN 0
    ELSE IF TakesFocus(after, e) THEN 1
    ELSE before.focus

\* A window that opens or rises must reach the top, where the focus sits.
\* @type: ($snapshotsFact, $eventsFact) => Bool;
TopLaw(after, e) ==
  TakesFocus(after, e) => RankOf(after, e.key) = OpenWindows(after)

\* A press on the page leaves every window at its rank.
\* @type: ($snapshotsFact, $snapshotsFact, $eventsFact) => Bool;
PressLaw(before, after, e) ==
  e.kind = "focus-page" => \A key \in Keys : RankOf(after, key) = RankOf(before, key)

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
  /\ TablesWellFormed(Snapshots, Targets, Events)
  /\ Snapshots[1] = Blank
  /\ \A index \in DOMAIN Snapshots :
       /\ ValidScreen(Snapshots[index])
       /\ DimLaw(Snapshots[index])

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
