@story:payments.repeated-money-actions
@owner:payments @risk:high
@actor:organiser @actor:customer
@edition:managed @edition:self-hosted
Feature: Doing the same money action twice counts it once
  A payment message that arrives again, or an income figure saved again, must
  leave the books exactly as they already were.

  @rule:payments.doing-it-twice-counts-once
  @surface:admin
  Rule: Doing the same thing twice counts it only once
    A repeated payment message makes no second booking, and re-saving the same
    income figure makes no second correction.

    @case:payment.replayed-payment-counts-once
    Scenario: The same payment message arrives again
      Given a customer paid 60.00 for a Repeat place
      When the same payment message arrives again
      Then there is still one booking and one sale

    @case:payment.repeated-correction-counts-once
    Scenario: The organiser saves the same income figure twice
      Given a customer paid 60.00 for a Repeat place
      When the organiser sets the Repeat income to 40.00 twice
      Then the Repeat has earned 40.00 from a single correction
