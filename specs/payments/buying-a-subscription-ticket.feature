@story:payments.buying-a-subscription-ticket
@owner:payments @risk:high
@actor:customer @actor:organiser
@edition:managed @edition:self-hosted
Feature: A customer buys a subscription ticket
  An organiser can give a ticket a recurring price. The customer pays the
  ticket price at once, and Stripe charges the recurring price again every
  period from one period later. The booking keeps the plan the customer
  agreed to.

  @rule:payments.the-first-recurring-charge-comes-one-period-later
  @surface:admin @surface:public
  Rule: The first recurring charge comes one period after the ticket price
    Stripe charges the ticket price now. It charges the recurring price for
    every ticket again each period, with the tax the site adds.

    @case:payments.a-monthly-subscription
    Scenario: A customer starts a monthly subscription
      Given Stripe takes payments for the site
      And the owner enables "Subscriptions"
      And the organiser sells a Club ticket at 10.00 that charges 5.00 again every month
      When a customer subscribes with 1 Club ticket
      Then Stripe is asked to charge 10.00 now and 5.00 every month from one month later
      And the Club booking pays 5.00 every month with 0.00 of tax

    @case:payments.a-subscription-with-added-tax
    Scenario: A customer starts a subscription for two tickets when the site adds tax
      Given Stripe takes payments for the site
      And the site adds 20 percent tax to listed prices
      And the owner enables "Subscriptions"
      And the organiser sells a Club ticket at 10.00 that charges 5.00 again every week
      When a customer subscribes with 2 Club tickets
      Then Stripe is asked to charge 24.00 now and 12.00 every week from one week later
      And the Club booking pays 12.00 every week with 2.00 of tax

  @rule:payments.a-booking-keeps-its-plan
  @surface:admin @surface:public
  Rule: A booking keeps the plan the customer agreed to
    A later change to the ticket does not change what an existing
    subscriber pays.

    @case:payments.a-price-change-leaves-subscribers-alone
    Scenario: The organiser raises the recurring price after a customer subscribed
      Given Stripe takes payments for the site
      And the owner enables "Subscriptions"
      And the organiser sells a Club ticket at 10.00 that charges 5.00 again every year
      And a customer subscribes with 1 Club ticket
      When the organiser changes the Club recurring price to 8.00
      Then the Club booking pays 5.00 every year with 0.00 of tax

  @rule:payments.only-stripe-sells-subscriptions
  @surface:admin
  Rule: Only a site that takes payments with Stripe offers a recurring price
    Square and SumUp cannot charge a subscription for this site.

    @case:payments.no-recurring-price-with-square
    Scenario: The organiser on a Square site sees no recurring price
      Given Square takes payments for the site
      And the owner enables "Subscriptions"
      When the organiser opens the form for a new listing
      Then the form offers no recurring price
