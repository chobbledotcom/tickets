@story:payments.refunding-everyone-at-once
@owner:payments @risk:high
@actor:organiser
@edition:managed @edition:self-hosted
Feature: An organiser refunds everyone on a listing
  When a listing is called off, an organiser can work through everyone's
  refunds in bounded pages. One payment the provider turns down must not stop
  the rest of the selected page — and only refunds that really happened may be
  counted.

  @rule:payments.one-failed-refund-does-not-stop-the-others
  @surface:admin
  Rule: A refund that fails does not stop the others, and is not counted
    Every person in the selected page is tried once. The organiser is told how
    many worked, how many did not, and how many people remain for another
    submission. A failed refund keeps its money and its place.

    @case:bulk-refund.one-fails-the-rest-succeed
    Scenario: The provider turns down the first of two refunds
      Given 2 people each paid 50.00 for a Tour place
      When the organiser refunds everyone and the provider turns down the first
      Then the organiser is told 1 refund worked and 1 failed
      And the person who was refunded has their money back
      And the one who was not still has their place, and the Tour has earned 50.00

  @rule:payments.refund-all-respects-owner-review
  @surface:admin
  Rule: Refund All cannot bypass a payment that still needs owner review
    Acknowledging a contradictory provider report records that the owner saw
    it. Even if the provider's next report looks safe, Refund All waits for the
    review to be resolved through the payment refresh process before sending
    any money.

    @case:bulk-refund.review-on-last-payment-stops-every-send
    Scenario: A review on the last payment stops every send
      Given 2 people each paid 50.00 for a Tour place
      And the first payment is last in Refund All's payment set
      And the provider reports returning more than it took on the first payment
      And the owner tried the first refund and acknowledged its review
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
