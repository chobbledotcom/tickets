@story:payments.refunding-everyone-at-once
@owner:payments @risk:high
@actor:organiser
@edition:managed @edition:self-hosted
Feature: An organiser refunds everyone on a listing
  When a listing is called off, an organiser can refund everyone on it in one
  go. One payment the provider turns down must not stop the rest — and only the
  refunds that really happened may be counted.

  @rule:payments.one-failed-refund-does-not-stop-the-others
  @surface:admin
  Rule: A refund that fails does not stop the others, and is not counted
    Every booking is tried. The organiser is told how many worked and how many
    did not, and the one that failed keeps its money and its place.

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
