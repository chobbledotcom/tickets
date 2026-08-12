@story:payments.waiting-for-a-refund
@owner:payments @risk:high
@actor:organiser @actor:customer
@edition:managed @edition:self-hosted
Feature: A refund in progress is checked, never sent again
  A provider may need time to finish, or the connection may disappear after it
  receives a request. The owner can refresh what the site knows without risking
  a second payment to the customer.

  @rule:payments.a-settling-refund-is-read-not-resent
  @surface:admin
  Rule: A refund still settling is checked without being sent again
    Once the provider accepts a refund, the action disappears until the
    provider confirms what happened.

    @case:refund-safety.accepted-refund-settles-after-refresh
    Scenario: Stripe accepts a refund and finishes it later
      Given Alice bought a 45.00 Concert place through the public booking page
      And Stripe will accept Alice's refund but leave it settling
      When the owner signs in and refunds Alice from her Actions page
      Then the owner is told the refund is still settling and to refresh its status
      And Alice's Actions page does not offer Refund
      And Alice's attendee page offers Refresh payment status
      When the owner presses Refresh payment status while it is still settling
      Then Stripe has received one request to return Alice's money
      And Money does not yet show a refund for Alice
      When Stripe finishes returning Alice's 45.00
      And the owner presses Refresh payment status from Alice's attendee page
      Then Money shows one refund for Alice
      And Stripe has received one request to return Alice's money

  @rule:payments.a-lost-keyless-answer-is-observed-not-repeated
  @surface:admin
  Rule: A lost answer is never repeated when the provider cannot repeat safely
    Some providers cannot recognise a repeated refund request as the same one.
    After a lost answer, the site only asks what happened.

    @case:refund-safety.sumup-lost-answer-is-never-resent
    Scenario: SumUp loses the connection after receiving the refund
      Given Alice bought a 45.00 Concert place through the public booking page
      And SumUp loses the connection after receiving Alice's refund request
      When the owner signs in and refunds Alice from her Actions page
      Then the owner is warned not to send the refund again
      And Alice's Actions page does not offer Refund
      When enough time passes for the site to check again
      And the owner presses Refresh payment status from Alice's attendee page
      Then SumUp has received one request to return Alice's money
      And Money does not yet show a refund for Alice
      When SumUp reports that Alice's 45.00 has been returned
      And the owner presses Refresh payment status from Alice's attendee page
      Then Money shows one refund for Alice
      And SumUp has received one request to return Alice's money
