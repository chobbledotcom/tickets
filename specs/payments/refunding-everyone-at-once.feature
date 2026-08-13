@story:payments.refunding-everyone-at-once
@owner:payments @risk:high
@actor:organiser
@edition:managed @edition:self-hosted
Feature: An organiser refunds everyone on a listing
  When a listing is called off, an organiser works through its refunds one
  person at a time. Every submission shows how many remain, so the next
  provider call is a deliberate, bounded visitor action.

  @rule:payments.refund-all-advances-one-person-at-a-time
  @surface:admin
  Rule: Each submission refunds one person and leaves the rest visible
    Refund All never turns a large listing into one large provider request. A
    successful submission returns one person's money, tells the organiser how
    many remain, and lets them submit the same real form again.

    @case:bulk-refund.one-person-per-submission
    Scenario: Two refunds take two submissions
      Given 2 people each paid 50.00 for a Tour place
      When the organiser tries to refund everyone
      Then the organiser is told 1 refund worked and 1 remains
      And exactly 1 person has their money back
      When the organiser tries to refund everyone
      Then all 2 people have their money back
      And the Tour has earned 0.00

  @rule:payments.failed-refund-keeps-its-place
  @surface:admin
  Rule: A failed refund is counted without trying another person
    A provider refusal leaves everybody else untouched. The organiser sees the
    failure and the full remaining count, then chooses whether to submit again.

    @case:bulk-refund.failure-stops-this-submission
    Scenario: The provider turns down the selected refund
      Given 2 people each paid 50.00 for a Tour place
      When the organiser tries to refund everyone and the provider turns it down
      Then the organiser is told 0 refunds worked and 1 failed
      And the organiser is told 2 refunds remain
      And all 2 people still have their payments
      And the Tour has earned 100.00

  @rule:payments.refund-all-respects-owner-review
  @surface:admin
  Rule: Refund All cannot bypass a refund that still needs an owner decision
    A contradictory provider report creates one durable refund-recovery case.
    Even if the provider's next report looks safe, Refund All waits for the
    owner to resolve that case before sending any money.

    @case:bulk-refund.review-on-last-payment-stops-every-send
    Scenario: A review on the last payment stops every send
      Given 2 people each paid 50.00 for a Tour place
      And the first payment is last in Refund All's payment set
      And the provider reports returning more than it took on the first payment
      And the owner tried the first refund and left its refund case unresolved
      And the provider corrects the first payment to show no refund
      When the organiser tries to refund everyone
      Then Refund All stops before asking the provider to return money
      And all 2 people still have their payments
      And the Tour has earned 100.00

  @rule:payments.refund-all-requires-the-complete-payment-history
  @surface:admin
  Rule: Refund All stops when an older payment cannot join the refund set
    A payment row from before refund indexes existed proves that the visible
    references may be incomplete. The site returns no money until the old
    history can be migrated safely.

    @case:bulk-refund.unindexed-history-stops-every-send
    Scenario: One old unindexed payment stops every send
      Given 2 people each paid 50.00 for a Tour place
      And the first payment was stored before refund indexes existed
      When the organiser tries to refund everyone
      Then Refund All stops because older payment history is incomplete
      And all 2 people still have their payments
      And the Tour has earned 100.00
