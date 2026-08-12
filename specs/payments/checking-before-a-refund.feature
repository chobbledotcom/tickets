@story:payments.checking-before-a-refund
@owner:payments @risk:high
@actor:organiser @actor:customer
@edition:managed @edition:self-hosted
Feature: The site checks an old payment before refunding it
  An old booking may not say which provider took its payment. Before returning
  money, the site asks every possible provider and acts only when their answers
  leave one safe choice.

  @rule:payments.one-provider-can-safely-identify-an-old-payment
  @surface:admin
  Rule: One clear provider answer is enough to refund an old payment
    The owner can refund an old booking when exactly one provider recognises
    its payment and every other provider confirms that it is not theirs.

    @case:refund-safety.one-provider-recognises-the-old-payment
    Scenario: Stripe alone recognises an old payment
      Given Alice bought a 45.00 Concert place through the public booking page
      And Alice's old payment record does not name its provider
      And Stripe recognises the payment while the other providers do not
      When the owner signs in and refunds Alice from her Actions page
      Then Alice is handed back 45.00 once
      And Alice's payment record now names Stripe
      And Money shows one refund for Alice

  @rule:payments.every-provider-must-answer-before-an-old-payment-moves
  @surface:admin
  Rule: An unanswered provider check stops the refund
    A provider being offline leaves a real possibility that it took the
    payment, so the site waits rather than guessing.

    @case:refund-safety.provider-outage-waits-for-a-clear-answer
    Scenario: One provider recognises the payment while another is offline
      Given Alice bought a 45.00 Concert place through the public booking page
      And Alice's old payment record does not name its provider
      And Stripe recognises the payment while Square cannot be reached
      When the owner signs in and tries to refund Alice from her Actions page
      Then the owner is told the provider checks could not be completed
      And no provider is asked to return Alice's money
      And Money still shows Alice's 45.00 payment
      When Square recovers and confirms the payment is not theirs
      And the owner retries the refund from Alice's Actions page
      Then Alice is handed back 45.00 once
      And Money shows one refund for Alice

  @rule:payments.two-matching-providers-stop-an-unsafe-refund
  @surface:admin
  Rule: Two providers recognising one old reference stops the refund
    The site cannot safely choose between two genuine matches. It explains the
    conflict without moving money.

    @case:refund-safety.two-providers-recognise-the-old-payment
    Scenario: Stripe and Square both recognise the same old reference
      Given Alice bought a 45.00 Concert place through the public booking page
      And Alice's old payment record does not name its provider
      And Stripe and Square both recognise the payment
      When the owner signs in and tries to refund Alice from her Actions page
      Then the owner is told to choose which provider took the payment
      And no provider is asked to return Alice's money
      And Money still shows Alice's 45.00 payment

  @rule:payments.any-returned-money-makes-another-refund-unsafe
  @surface:admin
  Rule: Even one penny already returned needs an owner review
    The site never treats a small returned amount as no refund at all. Marking
    it reviewed records the owner's acknowledgement; it does not move money or
    make unchanged evidence safe.

    @case:refund-safety.one-penny-returned-still-needs-review
    Scenario: A failed provider refund nevertheless returned one penny
      Given Alice bought a 45.00 Concert place through the public booking page
      And Stripe says a failed refund returned 0.01 to Alice
      When the owner signs in and tries to refund Alice from her Actions page
      Then no provider is asked to return any more money
      And Alice's Actions page offers Mark payment reviewed
      And Money still shows Alice's 45.00 payment
      When the owner opens Mark payment reviewed from Alice's Actions page
      And types Alice's exact name and presses Mark payment reviewed
      Then the owner is told the payment was marked reviewed
      And the provider has not been contacted again
      And Money still shows Alice's 45.00 payment
      And Alice's Actions page still offers Mark payment reviewed to the owner
      When the owner checks Alice's Actions page again
      Then no provider is asked to return any more money
      And Alice's Actions page offers Mark payment reviewed again
