------------------------- MODULE SubscriptionRules -------------------------
\* A live subscription can still charge the buyer. Its booking must keep the
\* plan and cannot be discarded. An ended subscription cannot resume through
\* a stale local status write. These are independent business classifications,
\* not values copied from the production transition table.
\* == defines a set. Braces list its members; membership uses \in.
\* Callers own their state, events, coverage, and safety checks. This helper
\* has no lifecycle and makes no provider or eventual-completion claim.

LiveStatuses == {"active", "incomplete", "past_due", "paused", "trialing", "unpaid"}
EndedStatuses == {"canceled", "incomplete_expired"}
=============================================================================
