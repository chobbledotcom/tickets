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
    Scenario: The provider turns down one of three refunds
      Given three people each paid 50.00 for a Tour place
      When the organiser refunds everyone and the provider turns down the second
      Then the organiser is told 2 refunds worked and 1 failed
      And the two who were refunded have their money back
      And the one who was not still has their place, and the Tour has earned 50.00
