# The two business classes of a stored subscription status

[Read the model](../../verification/SubscriptionRules.tla).

This page explains the two status classes that every subscription model shares. Six stored words still charge the buyer. Two stored words are ended.

## The bad outcome it rules out

A model treats an ended subscription as live, or a live subscription as safe to discard.

## The cast

| Word | Meaning |
| --- | --- |
| **status word** | One stored value of the subscription status column. |
| **live subscription** | A subscription that can still charge the buyer. Its plan must stay with its booking row. |
| **ended subscription** | A subscription that no longer charges. A drop can remove its row or its plan. |
| **drop** | An edit, a delete, or a merge that removes a booking row or its plan. |

## The walkthrough

### Step 1: A live word still charges the buyer

LiveStatuses holds six words. A row with one of these words can still charge the buyer. The booking row must keep the plan, so an edit, a delete, or a merge cannot discard it. This set is a business class, not a copy of a production transition table.

| Value | This step |
| --- | --- |
| `active` | live |
| `incomplete` | live |
| `past_due` | live |
| `paused` | live |
| `trialing` | live |
| `unpaid` | live |
| `count` | six words |

**Model rule: [`LiveStatuses`](../../verification/SubscriptionRules.tla#L10)**

```tla
LiveStatuses == {"active", "incomplete", "past_due", "paused", "trialing", "unpaid"}
```

### Step 2: An ended word no longer charges

EndedStatuses holds two words. A row with one of these words no longer charges. A drop can remove that row or its plan. The helper states the classes only. Each caller owns the facts and the safety claim.

| Value | This step |
| --- | --- |
| `canceled` | ended |
| `incomplete_expired` | ended |
| `count` | two words |

**Model rule: [`EndedStatuses`](../../verification/SubscriptionRules.tla#L11)**

```tla
EndedStatuses == {"canceled", "incomplete_expired"}
```

## The safety claim

The helper does not claim safety by itself. It supplies the status classes that a model joins into its own safety rule.

The model checks two things:

- The first state satisfies the claim.
- Every allowed step from a state that satisfies the claim keeps it.

Together, these checks cover every finite run of the model.

## What this model does not prove

- The helper has no state, no start state, and no step relation.
- It states two sets of status words. It does not describe a status change or a provider callback.
- The blank status word is outside both sets. The records model adds it for an ordinary row.
- Each model supplies its own facts and its own safety claim.

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
