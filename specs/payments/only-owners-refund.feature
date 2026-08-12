@story:payments.only-owners-refund
@owner:payments @risk:high
@actor:organiser
@edition:managed @edition:self-hosted
Feature: Only an owner decides what happens to refunds needing attention
  Managers can help run listings, but only an owner may send money back or say
  that a payment conflict has been reviewed. Pages must not promise managers an
  action they cannot take, and copied addresses must not bypass the rule.

  @rule:payments.managers-are-not-offered-owner-refund-actions
  @surface:admin
  Rule: A manager sees no refund or payment-review links
    The Actions page shows only links that the signed-in person can follow.

    @case:refund-permissions.manager-sees-no-refund-action
    Scenario: A manager opens a refundable booking
      Given Alice bought a 45.00 Concert place through the public booking page
      And the owner invited Morgan as a manager
      And Morgan accepted the invitation, chose a password and signed in
      When Morgan opens Alice's Actions page
      Then Morgan is not offered Refund
      And every action Morgan is offered opens for Morgan

    @case:refund-permissions.manager-sees-no-review-action
    Scenario: A manager opens a booking that needs an owner review
      Given Bob bought a 45.00 Concert place through the public booking page
      And Stripe says a failed refund returned 0.01 to Bob
      And the owner tried the refund and was offered Mark payment reviewed
      And the owner invited Morgan as a manager
      And Morgan accepted the invitation, chose a password and signed in
      When Morgan opens Bob's Actions page
      Then Morgan is not offered Mark payment reviewed
      And every action Morgan is offered opens for Morgan

  @rule:payments.copied-addresses-do-not-give-managers-owner-powers
  @surface:admin
  Rule: A manager cannot use a copied refund or review address
    Hiding a link is not permission. Both the confirmation page and its form
    refuse a manager before contacting the provider or changing the review.

    @case:refund-permissions.manager-cannot-open-or-send-refund
    Scenario: A manager uses the owner's refund address
      Given Alice bought a 45.00 Concert place through the public booking page
      And the owner invited Morgan as a manager
      And Morgan accepted the invitation, chose a password and signed in
      When Morgan opens the owner's saved refund confirmation address for Alice
      Then Morgan is refused access
      When Morgan submits the owner's saved refund form for Alice
      Then Morgan is refused access
      And no provider is asked to return Alice's money
      And Money still shows Alice's 45.00 payment

    @case:refund-permissions.manager-cannot-open-or-acknowledge-review
    Scenario: A manager uses the owner's payment-review address
      Given Alice bought a 45.00 Concert place through the public booking page
      And Stripe says a failed refund returned 0.01 to Alice
      And the owner tried the refund and was offered Mark payment reviewed
      And the owner invited Morgan as a manager
      And Morgan accepted the invitation, chose a password and signed in
      When Morgan opens the owner's saved payment-review address for Alice
      Then Morgan is refused access
      When Morgan submits the owner's saved payment-review form for Alice
      Then Morgan is refused access
      And Alice's Actions page still offers Mark payment reviewed to the owner
      And the provider has not been contacted again
      And Money still shows Alice's 45.00 payment

  @rule:payments.owners-can-acknowledge-a-review-without-moving-money
  @surface:admin
  Rule: An owner may acknowledge a payment review
    The owner must open the real confirmation page and type the attendee's exact
    name. The action changes neither the provider nor Money.

    @case:refund-permissions.owner-can-acknowledge-review
    Scenario: The owner marks a payment reviewed
      Given Alice bought a 45.00 Concert place through the public booking page
      And Stripe says a failed refund returned 0.01 to Alice
      And the owner tried the refund and was offered Mark payment reviewed
      When the owner opens Mark payment reviewed from Alice's Actions page
      And types Alice's exact name and presses Mark payment reviewed
      Then the owner is told the payment was marked reviewed
      And the provider has not been contacted again
      And Money still shows Alice's 45.00 payment
      And Alice's Actions page still offers Mark payment reviewed to the owner
