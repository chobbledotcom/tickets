# Keeping a saved VAT assessment stable across settings and refunds

[Read the model](../../verification/VatLedger.tla).

This page follows one booking's saved tax assessment. A settings change alone does not rewrite a recorded sale. An accepted save uses the setting at that moment. A refund keeps the recorded amounts and closes the sale.

## The bad outcome it rules out

A later VAT setting rewrites a past refunded sale, or a stale form saves over the current assessment.

## The cast

| Word | Meaning |
| --- | --- |
| **sale** | One booking with a saved tax assessment. The model labels the sale active or refunded. |
| **basis** | The fixed listed amounts and adjustments for the sale, in minor units. |
| **setting** | The VAT policy that a save applies now. A setting is not part of the sale. |
| **policy** | No tax, tax added to the price, or tax within the price. Rates use basis points. |
| **revision** | A version count on the sale. A stale form carries an old revision. |
| **attempt** | One prepared event result with true or false checks. It is not a live customer record. |

## The walkthrough

### Step 1: Start with an active sale

The model starts with one active sale. It also checks every generated initial assessment, including samples for the refunded label. The producer builds those samples from the same small bases and policies.

| Value | This step |
| --- | --- |
| `bookingState` | active |
| `allAttemptsSafe` | TRUE |
| `initial samples` | 784 |
| `basis half` | One line with gross 3. Policy none gives tax 0 and total 3. |

**Model rule: [`Init`](../../verification/VatLedger.tla#L81)**

```tla
Init ==
  /\ bookingState = "active"
  /\ allAttemptsSafe = (\A sample \in VatInitial : sample.safe)
```

**Model rule: [`TypeOK`](../../verification/VatLedger.tla#L55)**

```tla
TypeOK == bookingState \in VatStates /\ allAttemptsSafe \in BOOLEAN
```

**Production code: [`src/shared/tax/assessment.ts#assessTax`](../../src/shared/tax/assessment.ts#L37)**

```ts
export const assessTax = (
  basis: TaxBasis,
  policy: TaxPolicy,
): TaxAssessment => { ... }
```

Source fingerprint: `sha256:728a9319fc2523a6`

**Production code: [`src/shared/tax/machine-spec.ts#TAX_BASES`](../../src/shared/tax/machine-spec.ts#L45)**

```ts
export const TAX_BASES: readonly { id: string; basis: TaxBasis }[] = [
  { basis: { lines: [{ gross: 3, listingId: 1 }], modifiers: [] }, id: "half" },
  {
    basis: {
      lines: [
        { gross: 1, listingId: 1 },
        { gross: 1, listingId: 2 },
      ],
      modifiers: [{ delta: 1, modifierId: 1 }],
    },
    id: "ties",
  },
  {
    basis: {
      lines: [
        { gross: 1001, listingId: 1 },
        { gross: 499, listingId: 2 },
      ],
      modifiers: [
        { delta: -137, modifierId: 1 },
        { delta: 63, modifierId: 2 },
      ],
    },
    id: "discount",
// ...
```

Source fingerprint: `sha256:75895cef87953f22`

**Production code: [`scripts/verify-models/vat.ts#validVatAssessment`](../../scripts/verify-models/vat.ts#L31)**

```ts
export const validVatAssessment = (value: TaxAssessment): boolean => { ... }
```

Source fingerprint: `sha256:36c177d8f50789cf`

### Step 2: A new setting does not touch the sale

The setting_add event replaces the setting and leaves the sale alone. The assessment still holds the no-tax policy. The model joins the event to the active state through taxNodeOf. Next also permits a pause.

| Value | This step |
| --- | --- |
| `event` | setting_add |
| `setting` | none changes to add_to_total at 2000 basis points |
| `assessment policy` | none, unchanged |
| `revision` | 0 |

**Model rule: [`VatStep`](../../verification/VatLedger.tla#L88)**

```tla
VatStep ==
  \E attempt \in VatAttempts :
    /\ attempt.sourceState = bookingState
    /\ AttemptedEdge(bookingState, attempt.targetState, SafeAttempt(attempt), allAttemptsSafe)
```

**Model rule: [`Next`](../../verification/VatLedger.tla#L95)**

```tla
Next == VatStep \/ UNCHANGED <<bookingState, allAttemptsSafe>>
```

**Production code: [`src/shared/tax/machine-spec.ts#TAX_EVENTS`](../../src/shared/tax/machine-spec.ts#L101)**

```ts
export const TAX_EVENTS: readonly TaxMachineEvent[] = [
  ...TAX_POLICIES.map(({ id, policy }) =>
    event(
      `setting_${id}`,
      "setting",
      false,
      (state) => ({ ...state, setting: policy }),
      policy,
    ),
  ),
  ...([false, true] as const).flatMap((stale) => [
    event(stale ? "save_stale" : "save", "save", stale, (state) => ({
      ...state,
      booking: reassessTax(
        state.booking,
        state.setting,
        state.booking.revision - Number(stale),
      ).after,
    })),
    event(stale ? "refund_stale" : "refund", "refund", stale, (state) => ({
      ...state,
      booking: refundTax(state.booking, state.booking.revision - Number(stale)),
    })),
  ]),
// ...
```

Source fingerprint: `sha256:f51905b3fe4ff999`

**Production code: [`src/shared/tax/machine-spec.ts#TAX_POLICIES`](../../src/shared/tax/machine-spec.ts#L22)**

```ts
export const TAX_POLICIES = [
  { id: "none", policy: NO_TAX },
  { id: "add", policy: { mode: "add_to_total", rateBasisPoints: 2000 } },
  {
    id: "included",
    policy: { mode: "calculate_from_total", rateBasisPoints: 2000 },
  },
  { id: "add_zero", policy: { mode: "add_to_total", rateBasisPoints: 0 } },
  {
    id: "included_zero",
    policy: { mode: "calculate_from_total", rateBasisPoints: 0 },
  },
  {
    id: "add_fraction",
    policy: { mode: "add_to_total", rateBasisPoints: 1751 },
  },
  {
    id: "included_fraction",
    policy: { mode: "calculate_from_total", rateBasisPoints: 1751 },
  },
] as const satisfies readonly { id: string; policy: TaxPolicy }[];
```

Source fingerprint: `sha256:fbf7445963944e5b`

**Production code: [`src/shared/tax/machine-spec.ts#taxNodeOf`](../../src/shared/tax/machine-spec.ts#L19)**

```ts
export const taxNodeOf = (state: TaxMachineState): TaxNodeId => ...
```

Source fingerprint: `sha256:79d681496acc18ae`

### Step 3: An accepted save applies the current setting

The save event calls reassessTax with the current setting. The producer expects assessTax on the saved basis with that setting. The tax is one minor unit because half units round up. The revision changes because the policy differs from the recorded policy.

| Value | This step |
| --- | --- |
| `basis` | One line with gross 3 |
| `setting` | add_to_total at 2000 basis points |
| `taxAmount` | 1 |
| `total` | 4 |
| `revision` | 0 changes to 1 |

**Model rule: [`VatStep`](../../verification/VatLedger.tla#L88)**

```tla
VatStep ==
  \E attempt \in VatAttempts :
    /\ attempt.sourceState = bookingState
    /\ AttemptedEdge(bookingState, attempt.targetState, SafeAttempt(attempt), allAttemptsSafe)
```

**Production code: [`src/shared/tax/assessment.ts#assessTax`](../../src/shared/tax/assessment.ts#L37)**

```ts
export const assessTax = (
  basis: TaxBasis,
  policy: TaxPolicy,
): TaxAssessment => { ... }
```

Source fingerprint: `sha256:728a9319fc2523a6`

**Production code: [`scripts/verify-models/vat.ts#vatModel`](../../scripts/verify-models/vat.ts#L135)**

```ts
export const vatModel = () => { ... }
```

Source fingerprint: `sha256:f167161fe10814b6`

### Step 4: A stale form is refused

The save_stale event supplies an old revision on purpose. reassessTax refuses it and throws. The producer records accepted FALSE and keeps the old assessment. The model treats this refusal as a legal attempt, not a crash.

| Value | This step |
| --- | --- |
| `form revision` | 0 |
| `stored revision` | 1 |
| `expected revision` | revision minus one, which is 0 |
| `accepted` | FALSE |
| `assessment` | unchanged |

**Model rule: [`VatStep`](../../verification/VatLedger.tla#L88)**

```tla
VatStep ==
  \E attempt \in VatAttempts :
    /\ attempt.sourceState = bookingState
    /\ AttemptedEdge(bookingState, attempt.targetState, SafeAttempt(attempt), allAttemptsSafe)
```

**Production code: [`src/shared/tax/machine-spec.ts#TAX_EVENTS`](../../src/shared/tax/machine-spec.ts#L101)**

```ts
export const TAX_EVENTS: readonly TaxMachineEvent[] = [
  ...TAX_POLICIES.map(({ id, policy }) =>
    event(
      `setting_${id}`,
      "setting",
      false,
      (state) => ({ ...state, setting: policy }),
      policy,
    ),
  ),
  ...([false, true] as const).flatMap((stale) => [
    event(stale ? "save_stale" : "save", "save", stale, (state) => ({
      ...state,
      booking: reassessTax(
        state.booking,
        state.setting,
        state.booking.revision - Number(stale),
      ).after,
    })),
    event(stale ? "refund_stale" : "refund", "refund", stale, (state) => ({
      ...state,
      booking: refundTax(state.booking, state.booking.revision - Number(stale)),
    })),
  ]),
// ...
```

Source fingerprint: `sha256:f51905b3fe4ff999`

**Production code: [`scripts/verify-models/vat.ts#vatModel`](../../scripts/verify-models/vat.ts#L135)**

```ts
export const vatModel = () => { ... }
```

Source fingerprint: `sha256:f167161fe10814b6`

### Step 5: A refund closes the sale and keeps its amounts

An accepted refund changes the label to refunded and keeps the assessment. The revision rises by one. A refunded sale stays refunded, so a later refund leaves the label and revision unchanged. A later setting event cannot rewrite the amounts.

| Value | This step |
| --- | --- |
| `bookingState` | active changes to refunded |
| `revision` | 1 changes to 2 |
| `basis` | unchanged |
| `taxAmount` | 1 |
| `second refund` | accepted, refunded stays refunded, revision 2 stays 2 |

**Model rule: [`VatStep`](../../verification/VatLedger.tla#L88)**

```tla
VatStep ==
  \E attempt \in VatAttempts :
    /\ attempt.sourceState = bookingState
    /\ AttemptedEdge(bookingState, attempt.targetState, SafeAttempt(attempt), allAttemptsSafe)
```

**Production code: [`src/shared/tax/machine-spec.ts#TAX_EVENTS`](../../src/shared/tax/machine-spec.ts#L101)**

```ts
export const TAX_EVENTS: readonly TaxMachineEvent[] = [
  ...TAX_POLICIES.map(({ id, policy }) =>
    event(
      `setting_${id}`,
      "setting",
      false,
      (state) => ({ ...state, setting: policy }),
      policy,
    ),
  ),
  ...([false, true] as const).flatMap((stale) => [
    event(stale ? "save_stale" : "save", "save", stale, (state) => ({
      ...state,
      booking: reassessTax(
        state.booking,
        state.setting,
        state.booking.revision - Number(stale),
      ).after,
    })),
    event(stale ? "refund_stale" : "refund", "refund", stale, (state) => ({
      ...state,
      booking: refundTax(state.booking, state.booking.revision - Number(stale)),
    })),
  ]),
// ...
```

Source fingerprint: `sha256:f51905b3fe4ff999`

**Production code: [`scripts/verify-models/vat.ts#vatModel`](../../scripts/verify-models/vat.ts#L135)**

```ts
export const vatModel = () => { ... }
```

Source fingerprint: `sha256:f167161fe10814b6`

### Step 6: Safety joins the promises

SafeAttempt requires nine checks: arithmetic, basis, setting, revision, assessment, terminal label, refusal, no provider call, and the combined verdict. VatStep applies any prepared attempt and keeps a false verdict. Safety requires every check to pass.

| Value | This step |
| --- | --- |
| `safe attempt` | All nine checks are TRUE. allAttemptsSafe stays TRUE. |
| `bad setting event` | The setting rewrites the sale. assessmentCorrect is FALSE. |
| `bad run` | allAttemptsSafe becomes FALSE |

**Model rule: [`SafeAttempt`](../../verification/VatLedger.tla#L65)**

```tla
SafeAttempt(attempt) ==
  /\ attempt.arithmetic
  /\ attempt.basisKept
  /\ attempt.settingCorrect
  /\ attempt.revisionCorrect
  /\ attempt.assessmentCorrect
  /\ attempt.terminal
  /\ attempt.refusalCorrect
  /\ attempt.noProviderCall
  /\ attempt.safe
```

**Model rule: [`Safety`](../../verification/VatLedger.tla#L76)**

```tla
Safety == TypeOK /\ allAttemptsSafe
\* Safety requires valid state types and no failed verdict anywhere in the run.
```

**Model rule: [`VatStep`](../../verification/VatLedger.tla#L88)**

```tla
VatStep ==
  \E attempt \in VatAttempts :
    /\ attempt.sourceState = bookingState
    /\ AttemptedEdge(bookingState, attempt.targetState, SafeAttempt(attempt), allAttemptsSafe)
```

**Production code: [`scripts/verify-models/vat.ts#validVatAssessment`](../../scripts/verify-models/vat.ts#L31)**

```ts
export const validVatAssessment = (value: TaxAssessment): boolean => { ... }
```

Source fingerprint: `sha256:36c177d8f50789cf`

**Production code: [`scripts/verify-models/vat.ts#corruptVatData`](../../scripts/verify-models/vat.ts#L187)**

```ts
export const corruptVatData = async (): Promise<string> => { ... }
```

Source fingerprint: `sha256:d3d5550a9bff12b8`

## The safety claim

Every accepted event keeps the recorded basis. A save uses the current setting. A save changes the revision only on an active sale with a new policy. An accepted refund changes it only on an active sale. A refusal changes nothing. A refunded sale stays refunded.

The model checks two things:

- The first state satisfies the claim.
- Every allowed step from a state that satisfies the claim keeps it.

Together, these checks cover every finite run of the model.

## What this model does not prove

- The examples use four small bases, seven policies, and revisions zero and two.
- They do not prove every price, every production input, or a concurrent save.
- SQL atomicity, provider truth, eventual completion, and legal VAT compliance need separate tests.
- The model checks safety. It does not prove that a save or refund eventually occurs.

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
