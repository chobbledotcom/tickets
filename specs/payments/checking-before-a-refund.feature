@story:payments.checking-before-a-refund
@owner:payments @risk:high
@actor:organiser @actor:customer
@edition:managed @edition:self-hosted
Feature: The site checks that a payment names its provider before refunding it
  Automatic refunds use only the provider recorded when the payment was made.
  If an older payment does not name one, the site stops before contacting any
  provider rather than trying several possible providers.

  @rule:payments.old-payments-without-a-provider-fail-closed
  @surface:admin
  Rule: An unknown payment provider stops every automatic money action
    Re-saving an old payment cannot turn it into a modern provider-tagged
    payment. The attendee page explains the limitation and offers neither
    Refund nor Refresh, without reading or sending through any configured
    provider.

    @case:refund-safety.old-payment-without-a-provider-is-not-contacted
    Scenario: An old payment does not name its provider
      Given Alice bought a 45.00 Concert place through Stripe on the public booking page
      And Alice's old payment record does not name its provider
      And every payment provider is available
      When the owner opens Alice's attendee page
      Then the owner is told the payment does not record its provider
      And Alice's attendee page does not offer Refresh payment status
      And Alice's Actions page does not offer Refund
      And no provider is contacted about Alice's payment
      And Money still shows Alice's 45.00 payment
      When the owner re-saves Alice's attendee record without changing it
      And the owner opens Alice's attendee page
      Then the owner is told the payment does not record its provider
      And Alice's attendee page does not offer Refresh payment status
      And Alice's Actions page does not offer Refund
      And no provider is contacted about Alice's payment
      And Money still shows Alice's 45.00 payment

  @rule:payments.a-provider-tag-is-authority-not-a-search-hint
  @surface:admin
  Rule: A recorded provider is the only provider the site may contact
    Another provider may happen to accept the same-looking reference. That is
    not evidence that it took this payment. An outage is retried only at the
    provider recorded by checkout.

    @case:refund-safety.tagged-provider-outage-never-searches-elsewhere
    Scenario: Stripe is offline while Square recognises the same reference
      Given Alice bought a 45.00 Concert place through Stripe on the public booking page
      And every payment provider is available
      And Square would recognise Alice's Stripe payment
      And Stripe cannot be reached for Alice's payment
      When the owner signs in and tries to refund Alice from her Actions page
      Then the owner is told Stripe could not answer
      And only Stripe is asked to check Alice's payment
      And no provider is asked to return Alice's money
      When Stripe recovers for Alice's payment
      And the owner retries the refund from Alice's Actions page
      Then Alice is handed back 45.00 once
      And only Stripe was ever contacted about Alice's payment
      And Money shows one refund for Alice

  @rule:payments.any-returned-money-makes-another-refund-unsafe
  @surface:admin
  Rule: Even one penny already returned needs another provider check
    The site never treats a small returned amount as no refund at all. It keeps
    the conflict in the one Refund recovery queue until a later provider check
    is conclusive. The owner cannot call a partial return complete or send the
    rest as though nothing was returned.

    @case:refund-safety.one-penny-returned-still-needs-provider-check
    Scenario: A failed provider refund nevertheless returned one penny
      Given Alice bought a 45.00 Concert place through Stripe on the public booking page
      And Stripe says a failed refund returned 0.01 to Alice
      When the owner signs in and tries to refund Alice from her Actions page
      Then no provider is asked to return any more money
      And Alice's Actions page offers Open Refund recovery
      And Money still shows Alice's 45.00 payment
      When the owner opens Open Refund recovery from Alice's Actions page
      Then the partial return can only be checked with the provider again
      And the provider has not been contacted again
