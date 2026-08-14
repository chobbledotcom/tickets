@story:payments.recovering-the-money-record
@owner:payments @risk:high
@actor:organiser @actor:customer
@edition:managed @edition:self-hosted
Feature: The books catch up when a returned payment could not be recorded
  The provider can return money while a temporary database problem stops Money
  recording it. The site remembers the danger, prevents another refund, and
  lets the owner safely bring the books up to date.

  @rule:payments.returned-money-is-recovered-without-another-send
  @surface:admin
  Rule: Money catches up after its temporary failure is fixed
    Provider success is never mistaken for a failed refund. The owner sees a
    warning until refreshing can record the return exactly once.

    @case:refund-safety.money-catches-up-after-recording-failure
    Scenario: Stripe returns the money while Money is temporarily unavailable
      Given Alice bought a 45.00 Concert place through Stripe on the public booking page
      And Money will temporarily refuse to record Alice's refund
      When the owner signs in and refunds Alice from her Actions page
      Then the owner is warned that the provider returned Alice's money but Money did not record it
      And the owner is told to fix Money and refresh the payment status
      And the owner is warned not to send the refund again
      And Alice's Actions page does not offer another Refund
      And Stripe received one request to return Alice's money
      And Money does not yet show a refund for Alice
      When Money can record refunds again
      And the owner presses Refresh payment status from Alice's attendee page
      Then Money shows one refund for Alice
      And Alice's booking says the 45.00 was refunded
      And Stripe received one request to return Alice's money
      And the owner can delete Alice now that the payment work is finished

  @rule:payments.partial-provider-returns-stay-unresolved
  @surface:admin
  Rule: A partial return cannot be mistaken for a complete refund
    If the provider reports returning only part of the captured payment, the
    owner can check again but cannot call the whole refund returned or unsent.
    Checking reads the provider once, sends nothing, and keeps the payment
    protected while the evidence is still partial.

    @case:refund-safety.partial-return-remains-protected-after-recheck
    Scenario: Stripe still reports returning 4.00 of a 25.00 payment
      Given Alice bought a 25.00 Concert place through Stripe on the public booking page
      And Stripe says a failed refund returned 4.00 to Alice
      When the owner signs in and tries to refund Alice from her Actions page
      And the owner opens Open Refund recovery from Alice's Actions page
      Then the partial return can only be checked with the provider again
      When the owner checks the partial return with the provider
      Then Stripe was read once more and received no refund request for Alice
      And the partial return can only be checked with the provider again
      And Alice's Actions page does not offer another Refund and does offer recovery
      And Money still shows Alice's 25.00 payment

  @rule:payments.moved-payment-work-stays-reachable
  @surface:admin
  Rule: Moved payment work can still be finished from its new attendee
    A merge can move the durable payment record onto a booking whose older
    contact details never carried that payment. The new attendee page still
    shows the refresh control because the durable record, not an old contact
    field, says there is payment work to finish.

    @case:refund-safety.merged-payment-work-can-be-refreshed
    Scenario: Returned money moves onto a free booking before Money catches up
      Given Alice bought a 45.00 Concert place through Stripe on the public booking page
      And Money will temporarily refuse to record Alice's refund
      When the owner signs in and refunds Alice from her Actions page
      Then the owner is warned that the provider returned Alice's money but Money did not record it
      When Money can record refunds again
      And another Alice bought a free Workshop place through the public page
      And the owner signs in through two separate browsers
      And opens the rendered merge choices in the second browser
      And chooses to keep every paid Alice detail in the merge form
      And the second browser presses Merge and delete source attendee
      Then the returned payment work moves onto the free Alice without a legacy payment ID
      And Alice's attendee page offers Refresh payment status
      When the owner presses Refresh payment status from Alice's attendee page
      Then Money shows one refund for Alice
      And Stripe received one request to return Alice's money
      And the owner can delete Alice now that the payment work is finished
