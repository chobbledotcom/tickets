# Keep the admin window stack in order through close and restore

[Read the model](../../verification/ModalLifecycle.tla).

This page follows an admin window stack from no window to close and restore. Every observed event keeps a valid stack, a saved expanded position, and a point inside the limit.

## The bad outcome it rules out

A restore forgets the expanded position, a close reverses the survivors, or a point leaves the viewport.

## The cast

| Word | Meaning |
| --- | --- |
| **modal** | An admin window that leaves the rest of the page usable. |
| **key** | One window identity. The examples use a, b, and c. |
| **stack** | The bottom-first order of open windows. Rank 1 is the bottom. The top rank is the front. |
| **rank** | The position of one window in the stack. Zero means the window is absent. |
| **point** | An equal left and top pixel value. The examples use 0 and 2, and one move request of 3. |
| **saved point** | The expanded position that a minimise stores. The value -1 means the window has no saved point. |
| **viewport** | The measured page area. The examples use 2 by 2 and 4 by 4 pixels. |
| **limit** | The largest legal left and top value. It is viewport width minus window width. The examples use 0 and 2. |
| **event** | One input to the pure reducer, such as open, raise, close, minimise, restore, move, or resize. |
| **state** | One observed reducer output. The model gives each distinct output a model-only id. |

## The walkthrough

### Step 1: Start with no window

The model starts before the first open. Empty is the row with id 0 and every rank at zero. Keys names a, b, and c. NodeIds holds every discovered state id, and EventIds holds every selected event id. DomainOK checks that row 1 is Empty, that every row id matches its tuple position, and that every state has one target for each event.

| Value | This step |
| --- | --- |
| `windows` | 0 |
| `safe` | TRUE |
| `aRank` | 0 |
| `aPoint` | -1 |
| `aSaved` | -1 |
| `state rows` | 71 |
| `input rows` | 12 |
| `observed transitions` | 852 |

**Model rule: [`Init`](../../verification/ModalLifecycle.tla#L221)**

```tla
Init == /\ windows = 0 /\ safe = TRUE
```

**Model rule: [`Empty`](../../verification/ModalLifecycle.tla#L73)**

```tla
Empty == [id |-> 0, aRank |-> 0, aPoint |-> -1, aSaved |-> -1,
          bRank |-> 0, bPoint |-> -1, bSaved |-> -1, cRank |-> 0]
```

**Model rule: [`Keys`](../../verification/ModalLifecycle.tla#L67)**

```tla
Keys == {"a", "b", "c"}
```

**Model rule: [`NodeIds`](../../verification/ModalLifecycle.tla#L69)**

```tla
NodeIds == {index - 1 : index \in DOMAIN Snapshots}
```

**Model rule: [`EventIds`](../../verification/ModalLifecycle.tla#L71)**

```tla
EventIds == {e.event : e \in Events}
```

**Model rule: [`DomainOK`](../../verification/ModalLifecycle.tla#L195)**

```tla
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
```

**Production code: [`scripts/verify-models/modal-lifecycle.ts#modalLifecycleFacts`](../../scripts/verify-models/modal-lifecycle.ts#L144)**

```ts
export const modalLifecycleFacts = (
  transition: ModalTransition = transitionModals,
) => { ... }
```

Source fingerprint: `sha256:1a7e014b8de0f8d2`

**Production code: [`src/ui/client/admin/modal-state.ts#transitionModals`](../../src/ui/client/admin/modal-state.ts#L82)**

```ts
export const transitionModals = (
  states: readonly ModalState[],
  event: ModalEvent,
): readonly ModalState[] => { ... }
```

Source fingerprint: `sha256:e827d02bd13c79da`

### Step 2: Open a at pixel 2

Open on an absent key appends the window at the top. The point is the positioned point that the caller supplies. The application sends the open event through openAdminModal. The pixel 2 is an assumed input for the finite domain, not a measured browser value. The saved point stays -1 because the window is expanded. Rank reads the new stack position, and ValidStack requires unique consecutive ranks.

| Value | This step |
| --- | --- |
| `aRank` | 1 |
| `aPoint` | 2 |
| `aSaved` | -1 |
| `bRank` | 0 |
| `cRank` | 0 |

**Model rule: [`Transition`](../../verification/ModalLifecycle.tla#L228)**

```tla
Transition ==
  \E input \in Events :
    LET target == Targets[windows + 1][input.event + 1]
    IN /\ windows' = target
       /\ safe' = ChecksStillPass(safe, LegalTransition(windows, target, input))
```

**Model rule: [`PositionEvent`](../../verification/ModalLifecycle.tla#L122)**

```tla
PositionEvent(before, e, key, kinds) ==
  /\ e.key = key
  /\ e.kind \in kinds
  /\ CASE e.kind = "open" -> Rank(before, key) = 0
       [] e.kind = "restore" -> Saved(before, key) # -1
       [] OTHER -> TRUE
```

**Model rule: [`OrderLaw`](../../verification/ModalLifecycle.tla#L133)**

```tla
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
```

**Model rule: [`SavedLaw`](../../verification/ModalLifecycle.tla#L162)**

```tla
SavedLaw(before, after, e, key) ==
  Saved(after, key) =
    IF Rank(after, key) = 0 \/ PositionEvent(before, e, key, {"open", "restore"})
    THEN -1
    ELSE IF PositionEvent(before, e, key, {"minimise"}) /\ Saved(before, key) = -1
    THEN Point(before, key)
    ELSE Saved(before, key)
```

**Model rule: [`PointLaw`](../../verification/ModalLifecycle.tla#L173)**

```tla
PointLaw(before, after, e, key) ==
  IF Rank(after, key) = 0 THEN Point(after, key) = -1
  ELSE IF NeedsClamp(before, e, key)
  THEN Clamped(RequestedPoint(before, e, key), Point(after, key), e.limit)
  ELSE Point(after, key) = RequestedPoint(before, e, key)
```

**Model rule: [`ValidStack`](../../verification/ModalLifecycle.tla#L98)**

```tla
ValidStack(s) ==
  /\ \A key \in Keys :
       /\ Rank(s, key) \in {0, 1, 2, 3}
       /\ (Rank(s, key) = 0 => Point(s, key) = -1 /\ Saved(s, key) = -1)
       /\ (Rank(s, key) > 0 => Point(s, key) \in {0, 2} /\ Saved(s, key) \in {-1, 0, 2})
       /\ Rank(s, key) <= Count(s)
  /\ \A first \in Keys : \A second \in Keys :
       first # second /\ Rank(s, first) > 0 /\ Rank(s, second) > 0 =>
         Rank(s, first) # Rank(s, second)
```

**Model rule: [`Rank`](../../verification/ModalLifecycle.tla#L81)**

```tla
Rank(s, key) ==
  IF key = "a" THEN s.aRank ELSE IF key = "b" THEN s.bRank ELSE s.cRank
```

**Production code: [`src/ui/client/admin/modal.ts#openAdminModal`](../../src/ui/client/admin/modal.ts#L370)**

```ts
export const openAdminModal = (
  settings: unknown,
  content: HTMLElement,
  { canClose = ALWAYS_CLOSABLE, onClose = NOTHING_TO_DO }: ModalHooks = {},
): HTMLElement => { ... }
```

Source fingerprint: `sha256:a68cc06fe40c6c87`

**Production code: [`src/ui/client/admin/modal-state.ts#transitionModals`](../../src/ui/client/admin/modal-state.ts#L82)**

```ts
export const transitionModals = (
  states: readonly ModalState[],
  event: ModalEvent,
): readonly ModalState[] => { ... }
```

Source fingerprint: `sha256:e827d02bd13c79da`

### Step 3: Close a and keep b below c

Open b and open c append each window above the last. A close removes its key and shifts the later windows down by one. The survivors keep their relative order, so b stays below c. Snapshot reads the source and target rows from the observed state table. Count reads how many windows are live. A close clears the saved point.

| Value | This step |
| --- | --- |
| `before close` | aRank 1, bRank 2, cRank 3, Count 3. |
| `after close` | aRank 0, bRank 1, cRank 2, Count 2. |
| `aPoint` | -1 after close |
| `aSaved` | -1 after close |

**Model rule: [`Transition`](../../verification/ModalLifecycle.tla#L228)**

```tla
Transition ==
  \E input \in Events :
    LET target == Targets[windows + 1][input.event + 1]
    IN /\ windows' = target
       /\ safe' = ChecksStillPass(safe, LegalTransition(windows, target, input))
```

**Model rule: [`OrderLaw`](../../verification/ModalLifecycle.tla#L133)**

```tla
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
```

**Model rule: [`Count`](../../verification/ModalLifecycle.tla#L91)**

```tla
Count(s) == (IF s.aRank > 0 THEN 1 ELSE 0) +
            (IF s.bRank > 0 THEN 1 ELSE 0) + (IF s.cRank > 0 THEN 1 ELSE 0)
```

**Model rule: [`ValidStack`](../../verification/ModalLifecycle.tla#L98)**

```tla
ValidStack(s) ==
  /\ \A key \in Keys :
       /\ Rank(s, key) \in {0, 1, 2, 3}
       /\ (Rank(s, key) = 0 => Point(s, key) = -1 /\ Saved(s, key) = -1)
       /\ (Rank(s, key) > 0 => Point(s, key) \in {0, 2} /\ Saved(s, key) \in {-1, 0, 2})
       /\ Rank(s, key) <= Count(s)
  /\ \A first \in Keys : \A second \in Keys :
       first # second /\ Rank(s, first) > 0 /\ Rank(s, second) > 0 =>
         Rank(s, first) # Rank(s, second)
```

**Model rule: [`Rank`](../../verification/ModalLifecycle.tla#L81)**

```tla
Rank(s, key) ==
  IF key = "a" THEN s.aRank ELSE IF key = "b" THEN s.bRank ELSE s.cRank
```

**Model rule: [`Snapshot`](../../verification/ModalLifecycle.tla#L79)**

```tla
Snapshot(id) == Snapshots[id + 1]
```

**Model rule: [`SavedLaw`](../../verification/ModalLifecycle.tla#L162)**

```tla
SavedLaw(before, after, e, key) ==
  Saved(after, key) =
    IF Rank(after, key) = 0 \/ PositionEvent(before, e, key, {"open", "restore"})
    THEN -1
    ELSE IF PositionEvent(before, e, key, {"minimise"}) /\ Saved(before, key) = -1
    THEN Point(before, key)
    ELSE Saved(before, key)
```

**Production code: [`src/ui/client/admin/modal.ts#closeAdminModal`](../../src/ui/client/admin/modal.ts#L365)**

```ts
export const closeAdminModal = (key: string): void => { ... }
```

Source fingerprint: `sha256:783c8953b152ed24`

**Production code: [`src/ui/client/admin/modal-state.ts#transitionModals`](../../src/ui/client/admin/modal-state.ts#L82)**

```ts
export const transitionModals = (
  states: readonly ModalState[],
  event: ModalEvent,
): readonly ModalState[] => { ... }
```

Source fingerprint: `sha256:e827d02bd13c79da`

### Step 4: Minimise at 2 and restore

The first minimise stores the expanded point 2. Restore requests the saved point 2, not the current point. The selected restore uses limit 0, so the nearest legal point is 0. The clamp law keeps the saved value as its request and the limit decides the final pixel. PositionEvent requires a saved point for a restore. Saved and Point read the stored values.

| Value | This step |
| --- | --- |
| `after minimise` | aPoint 2, aSaved 2. |
| `restore request` | saved point 2 |
| `restore limit` | 0 |
| `restore result` | point 0, aSaved -1. |

**Model rule: [`Transition`](../../verification/ModalLifecycle.tla#L228)**

```tla
Transition ==
  \E input \in Events :
    LET target == Targets[windows + 1][input.event + 1]
    IN /\ windows' = target
       /\ safe' = ChecksStillPass(safe, LegalTransition(windows, target, input))
```

**Model rule: [`PositionEvent`](../../verification/ModalLifecycle.tla#L122)**

```tla
PositionEvent(before, e, key, kinds) ==
  /\ e.key = key
  /\ e.kind \in kinds
  /\ CASE e.kind = "open" -> Rank(before, key) = 0
       [] e.kind = "restore" -> Saved(before, key) # -1
       [] OTHER -> TRUE
```

**Model rule: [`SavedLaw`](../../verification/ModalLifecycle.tla#L162)**

```tla
SavedLaw(before, after, e, key) ==
  Saved(after, key) =
    IF Rank(after, key) = 0 \/ PositionEvent(before, e, key, {"open", "restore"})
    THEN -1
    ELSE IF PositionEvent(before, e, key, {"minimise"}) /\ Saved(before, key) = -1
    THEN Point(before, key)
    ELSE Saved(before, key)
```

**Model rule: [`Saved`](../../verification/ModalLifecycle.tla#L88)**

```tla
Saved(s, key) ==
  IF key = "a" THEN s.aSaved ELSE IF key = "b" THEN s.bSaved ELSE -1
```

**Model rule: [`Point`](../../verification/ModalLifecycle.tla#L84)**

```tla
Point(s, key) ==
  IF key = "a" THEN s.aPoint ELSE IF key = "b" THEN s.bPoint
  ELSE IF s.cRank = 0 THEN -1 ELSE 0
```

**Model rule: [`RequestedPoint`](../../verification/ModalLifecycle.tla#L148)**

```tla
RequestedPoint(before, e, key) ==
  IF PositionEvent(before, e, key, {"open", "move"}) THEN e.input
  ELSE IF PositionEvent(before, e, key, {"restore"}) THEN Saved(before, key)
  ELSE Point(before, key)
```

**Model rule: [`NeedsClamp`](../../verification/ModalLifecycle.tla#L156)**

```tla
NeedsClamp(before, e, key) ==
  e.kind = "resize" \/ PositionEvent(before, e, key, {"move", "restore"})
```

**Model rule: [`Clamped`](../../verification/ModalLifecycle.tla#L111)**

```tla
Clamped(request, result, limit) ==
  /\ result >= 0 /\ result <= limit
  /\ (request < 0 => result = 0)
  /\ (request > limit => result = limit)
  /\ (request >= 0 /\ request <= limit => result = request)
```

**Model rule: [`PointLaw`](../../verification/ModalLifecycle.tla#L173)**

```tla
PointLaw(before, after, e, key) ==
  IF Rank(after, key) = 0 THEN Point(after, key) = -1
  ELSE IF NeedsClamp(before, e, key)
  THEN Clamped(RequestedPoint(before, e, key), Point(after, key), e.limit)
  ELSE Point(after, key) = RequestedPoint(before, e, key)
```

**Production code: [`src/ui/client/admin/modal-state.ts#transitionModals`](../../src/ui/client/admin/modal-state.ts#L82)**

```ts
export const transitionModals = (
  states: readonly ModalState[],
  event: ModalEvent,
): readonly ModalState[] => { ... }
```

Source fingerprint: `sha256:e827d02bd13c79da`

### Step 5: Resize and move clamp to the edge

Resize measures every live window and clamps each current point. A move clamps the requested point. A request below zero lands at zero, and a request above the limit lands at the limit. The independent Clamped law checks the result. Move and resize keep the saved point. The production clamp uses the same nearest-edge rule.

| Value | This step |
| --- | --- |
| `resize` | aPoint 2, limit 0, result 0. |
| `move` | request 3, limit 2, result 2. |
| `saved point` | Resize and move keep it. |

**Model rule: [`Transition`](../../verification/ModalLifecycle.tla#L228)**

```tla
Transition ==
  \E input \in Events :
    LET target == Targets[windows + 1][input.event + 1]
    IN /\ windows' = target
       /\ safe' = ChecksStillPass(safe, LegalTransition(windows, target, input))
```

**Model rule: [`NeedsClamp`](../../verification/ModalLifecycle.tla#L156)**

```tla
NeedsClamp(before, e, key) ==
  e.kind = "resize" \/ PositionEvent(before, e, key, {"move", "restore"})
```

**Model rule: [`RequestedPoint`](../../verification/ModalLifecycle.tla#L148)**

```tla
RequestedPoint(before, e, key) ==
  IF PositionEvent(before, e, key, {"open", "move"}) THEN e.input
  ELSE IF PositionEvent(before, e, key, {"restore"}) THEN Saved(before, key)
  ELSE Point(before, key)
```

**Model rule: [`Clamped`](../../verification/ModalLifecycle.tla#L111)**

```tla
Clamped(request, result, limit) ==
  /\ result >= 0 /\ result <= limit
  /\ (request < 0 => result = 0)
  /\ (request > limit => result = limit)
  /\ (request >= 0 /\ request <= limit => result = request)
```

**Model rule: [`PointLaw`](../../verification/ModalLifecycle.tla#L173)**

```tla
PointLaw(before, after, e, key) ==
  IF Rank(after, key) = 0 THEN Point(after, key) = -1
  ELSE IF NeedsClamp(before, e, key)
  THEN Clamped(RequestedPoint(before, e, key), Point(after, key), e.limit)
  ELSE Point(after, key) = RequestedPoint(before, e, key)
```

**Model rule: [`SavedLaw`](../../verification/ModalLifecycle.tla#L162)**

```tla
SavedLaw(before, after, e, key) ==
  Saved(after, key) =
    IF Rank(after, key) = 0 \/ PositionEvent(before, e, key, {"open", "restore"})
    THEN -1
    ELSE IF PositionEvent(before, e, key, {"minimise"}) /\ Saved(before, key) = -1
    THEN Point(before, key)
    ELSE Saved(before, key)
```

**Production code: [`src/ui/client/admin/modal-position.ts#clampModalPosition`](../../src/ui/client/admin/modal-position.ts#L12)**

```ts
export const clampModalPosition = (
  point: Point,
  size: ModalSize,
  viewport: ModalSize,
): Point => ...
```

Source fingerprint: `sha256:70d1a638b73cac71`

**Production code: [`src/ui/client/admin/modal-state.ts#transitionModals`](../../src/ui/client/admin/modal-state.ts#L82)**

```ts
export const transitionModals = (
  states: readonly ModalState[],
  event: ModalEvent,
): readonly ModalState[] => { ... }
```

Source fingerprint: `sha256:e827d02bd13c79da`

### Step 6: Every selected event fits the laws

The producer runs transitionModals at every discovered state for every selected event. The matrix stores the observed target id. LegalTransition checks the stack order, the saved position, and the clamp law for each key. DomainOK checks the state and event tables. Safety checks the current id, the retained verdict, and the domain. Next permits any transition or a pause. Safety does not prove that a window eventually closes.

| Value | This step |
| --- | --- |
| `state rows` | 71 |
| `input rows` | 12 |
| `observed transitions` | 852 |
| `target` | One observed reducer state id for each source and event. |
| `safe` | TRUE |

**Model rule: [`Next`](../../verification/ModalLifecycle.tla#L237)**

```tla
Next == Transition \/ UNCHANGED <<windows, safe>>
```

**Model rule: [`Safety`](../../verification/ModalLifecycle.tla#L213)**

```tla
Safety ==
  /\ windows \in NodeIds
  /\ safe = TRUE
  /\ DomainOK
```

**Model rule: [`LegalTransition`](../../verification/ModalLifecycle.tla#L182)**

```tla
LegalTransition(source, target, input) ==
  LET before == Snapshot(source)
      after == Snapshot(target)
  IN /\ ValidStack(after)
     /\ \A key \in Keys :
          /\ OrderLaw(before, after, input, key)
          /\ SavedLaw(before, after, input, key)
          /\ PointLaw(before, after, input, key)
```

**Model rule: [`DomainOK`](../../verification/ModalLifecycle.tla#L195)**

```tla
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
```

**Model rule: [`PointLaw`](../../verification/ModalLifecycle.tla#L173)**

```tla
PointLaw(before, after, e, key) ==
  IF Rank(after, key) = 0 THEN Point(after, key) = -1
  ELSE IF NeedsClamp(before, e, key)
  THEN Clamped(RequestedPoint(before, e, key), Point(after, key), e.limit)
  ELSE Point(after, key) = RequestedPoint(before, e, key)
```

**Model rule: [`OrderLaw`](../../verification/ModalLifecycle.tla#L133)**

```tla
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
```

**Model rule: [`SavedLaw`](../../verification/ModalLifecycle.tla#L162)**

```tla
SavedLaw(before, after, e, key) ==
  Saved(after, key) =
    IF Rank(after, key) = 0 \/ PositionEvent(before, e, key, {"open", "restore"})
    THEN -1
    ELSE IF PositionEvent(before, e, key, {"minimise"}) /\ Saved(before, key) = -1
    THEN Point(before, key)
    ELSE Saved(before, key)
```

**Production code: [`scripts/verify-models/modal-lifecycle-matrix.ts#modalTargets`](../../scripts/verify-models/modal-lifecycle-matrix.ts#L24)**

```ts
export const modalTargets = (
  facts: ModalFacts,
): readonly (readonly number[])[] => { ... }
```

Source fingerprint: `sha256:a270156c942e0f56`

**Production code: [`scripts/verify-models/modal-lifecycle.ts#modalLifecycleModelData`](../../scripts/verify-models/modal-lifecycle.ts#L255)**

```ts
export const modalLifecycleModelData = modalDataWith((facts) => facts);
```

Source fingerprint: `sha256:24de22ae10414dc5`

## The safety claim

Every current state has a valid stack with unique consecutive ranks. Each live window has its requested point, clamped to the limit when the event needs a clamp. A saved point belongs to the expanded position. The initial row is empty and the retained verdict is true.

The model checks two things:

- The first state satisfies the claim.
- Every allowed step from a state that satisfies the claim keeps it.

Together, these checks cover every finite run of the model.

## What this model does not prove

- The examples use three keys, points 0 and 2, one move request of 3, sizes 2 by 2, and viewports 2 by 2 and 4 by 4. They do not prove every pixel input.
- Input keys and measurements are assumed. Each live window has a resize measurement, and open receives its initial positioned point.
- The model checks a pure reducer. It does not prove browser event delivery, pointer capture, focus, native dialog timing, CSS size, rendered content, or actual viewport measurement.
- The model does not check drag click suppression, one axis of a position, or an oversized window.
- No fairness rule is present. Safety does not prove that a window eventually closes or restores.

## How to read the model text

| Symbol | Meaning |
| --- | --- |
| `==` | This line defines a rule. It does not assign a value. |
| `x'` | The value of `x` after the step. |
| `/\` | Both conditions must hold. |
| `\/` | One of the conditions must hold. |
| `\A` | Every supplied value must satisfy the rule. |
| `\E` | At least one supplied value must satisfy the rule. |
| `\in` | The value belongs to the set. |
| `=>` | If the left condition holds, the right condition must hold. |

Read [the model verification guide](../model-verification.md) for the
method and its limits.
