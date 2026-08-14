@story:payments.refunding-from-two-windows
@owner:payments @risk:high
@actor:organiser
@edition:managed @edition:self-hosted
Feature: Other organiser actions wait while a refund is moving
  An owner may have the same booking open twice, or another owner may be
  changing it at the same moment. Only one refund may reach the provider, and
  the booking must stay in place until its payment is safe.

  @rule:payments.two-overlapping-refunds-send-one-request
  @surface:admin
  Rule: Two windows refunding one booking can send only once
    Both forms may be valid when opened. The first submission to reach the
    provider makes the second wait rather than returning the money twice.

    @case:refund-safety.two-windows-submit-one-refund
    Scenario: Two refund forms are submitted while the provider is answering
      Given Alice bought a 45.00 Concert place through Stripe on the public booking page
      And the owner signs in through two separate browsers
      And opens Alice's refund confirmation in both browsers
      And types Alice's exact name into both rendered forms
      When the first browser submits and Stripe pauses before answering
      And the second browser submits while Stripe is still paused
      And Stripe finishes accepting the first request
      Then one browser says the refund is still settling
      And the other browser says another refund is still in progress
      And Stripe received one request to return Alice's money

  @rule:payments.a-booking-being-refunded-cannot-be-deleted
  @surface:admin
  Rule: A booking stays in place while its refund is moving
    Deleting the booking would take away the information needed to finish or
    recover the refund, so the real delete form is refused.

    @case:refund-safety.delete-waits-for-moving-refund
    Scenario: Another browser deletes the booking while Stripe is answering
      Given Alice bought a 45.00 Concert place through Stripe on the public booking page
      And the owner signs in through two separate browsers
      And opens Alice's refund confirmation in the first browser
      And opens Alice's delete confirmation in the second browser
      And types Alice's exact name into both rendered forms
      When the first browser submits and Stripe pauses before answering
      And the second browser presses Delete Attendee while Stripe is still paused
      Then the second browser is told Alice cannot be deleted yet
      And Alice's booking and payment are still present
      When Stripe finishes accepting the refund
      Then Stripe received one request to return Alice's money

  @rule:payments.a-booking-being-refunded-cannot-be-merged
  @surface:admin
  Rule: A booking stays separate while its refund is moving
    A merge can move or remove payment information. The real merge form is
    refused until the refund has a final home.

    @case:refund-safety.merge-waits-for-moving-refund
    Scenario: Another browser merges the booking while Stripe is answering
      Given Alice bought a 45.00 Concert place through Stripe on the public booking page
      And another Alice bought a free Workshop place through the public page
      And the owner signs in through two separate browsers
      And opens the paid Alice's refund confirmation in the first browser
      And opens the rendered merge choices in the second browser
      And chooses to keep every paid Alice detail in the merge form
      When the first browser submits and Stripe pauses before answering
      And the second browser presses Merge and delete source attendee
      Then the second browser is told the bookings cannot be merged yet
      And both Alices and both bookings are still present
      And Money still shows the paid Alice's 45.00 payment
      When Stripe finishes accepting the refund
      Then Stripe received one request to return the paid Alice's money
